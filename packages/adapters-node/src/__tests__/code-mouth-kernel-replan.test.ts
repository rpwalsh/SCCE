import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createTypeScriptCodeMouthPorts, runCodeMouth } from "../code-mouth.js";
import { isCompilerRepairProposal, proposeCompilerOwnedRepair } from "../code-mouth-compiler-proposer.js";

const roots: string[] = [];
afterEach(async () => {
  const temporaryRoot = path.resolve(tmpdir());
  await Promise.all(roots.splice(0).map(async root => {
    const resolved = path.resolve(root);
    expect(path.dirname(resolved)).toBe(temporaryRoot);
    expect(path.basename(resolved).startsWith("scce-kernel-replan-")).toBe(true);
    await rm(resolved, { recursive: true });
  }));
});

async function fixture(source = "export const count = 1;\nexport const value = coutn;\n", scripts: Record<string, string> = { typecheck: "tsc -p tsconfig.json" }) {
  const root = await mkdtemp(path.join(tmpdir(), "scce-kernel-replan-"));
  roots.push(root);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts }));
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "es2022", types: [] }, include: ["src/**/*.ts"] }));
  await writeFile(path.join(root, "src/target.ts"), source);
  return { root, source, ports: createTypeScriptCodeMouthPorts({ workspaceRoot: root }) };
}

it("binds a real failed diagnostic to the kernel plan, applies it and verifies the repaired declaration", async () => {
  const { root, source, ports } = await fixture();
  const failed = await ports.verify("src/target.ts");
  expect(failed.buildSucceeded).toBe(false);
  expect(failed.diagnostics.map(row => row.patternId)).toContain("TS2552");
  const planned = await proposeCompilerOwnedRepair({ workspaceRoot: root, targetPath: "src/target.ts", targetText: source,
    requestText: "repair this file", attempt: 1, diagnostics: failed.diagnostics });
  expect(isCompilerRepairProposal(planned)).toBe(true);
  if (!isCompilerRepairProposal(planned)) return;
  expect(planned.selection?.selected?.patchPlan.operations).toEqual([expect.objectContaining({
    path: "src/target.ts", content: "export const count = 1;\nexport const value = count;\n"
  })]);
  expect(planned.selection?.execution).toEqual({ state: "not_executed" });
  const result = await runCodeMouth({ ports, targetPath: "src/target.ts", request: "repair this file", maxAttempts: 3 });
  expect(result.outcome).toBe("resolved");
  expect(result.planningSelections).toHaveLength(1);
  const appliedSelection = result.planningSelections?.[0]?.selection;
  expect(appliedSelection?.graphId).toBe(planned.selection?.graphId);
  expect(appliedSelection?.selected?.codeFixIdentity).toBe(planned.selection?.selected?.codeFixIdentity);
  expect(appliedSelection?.selected?.codeFixIdentity).toBeTruthy();
  expect(appliedSelection?.selected?.patchPlan.operations).toEqual(planned.selection?.selected?.patchPlan.operations);
  expect((await ports.verify("src/target.ts")).buildSucceeded).toBe(true);
  expect(await readFile(path.join(root, "src/target.ts"), "utf8")).toBe("export const count = 1;\nexport const value = count;\n");
}, 30_000);

it("routes compiler-owned fixes through typed selection before trying learned construction", async () => {
  const { root } = await fixture();
  let learnedCalls = 0;
  const ports = createTypeScriptCodeMouthPorts({
    workspaceRoot: root,
    learnedProposer: {
      async propose({ context }) {
        learnedCalls += 1;
        return {
          operations: [{
            id: "learned-bypass",
            kind: "replace",
            path: context.targetPath,
            startLine: 2,
            endLine: 2,
            content: "export const value = count;",
            reason: "test competing learned construction",
            risk: 0.1
          }],
          surface: "export const value = count;"
        };
      },
      lastCandidates: () => [],
      availableModelCount: async () => 1
    }
  });

  const result = await runCodeMouth({ ports, targetPath: "src/target.ts", request: "repair this file", maxAttempts: 3 });

  expect(result.outcome).toBe("resolved");
  expect(result.proposalSources).toEqual(["compiler_owned"]);
  expect(result.planningSelections).toHaveLength(1);
  expect(result.planningSelections?.[0]?.selection.selected?.diagnosticIdentity).toBeTruthy();
  expect(result.planningSelections?.[0]?.selection.selected?.codeFixIdentity).toBeTruthy();
  expect(learnedCalls).toBe(0);
  expect(await readFile(path.join(root, "src/target.ts"), "utf8")).toBe("export const count = 1;\nexport const value = count;\n");
}, 30_000);

it("binds a source-observed unused type declaration through the selected compiler repair", async () => {
  const { root, source, ports } = await fixture(
    "import type { Kept, Unused } from \"./types.js\";\nexport const value = (input: Kept) => input.value;\n"
  );
  await writeFile(path.join(root, "src/types.ts"), "export interface Kept { value: number; }\nexport interface Unused { value: number; }\n");
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, target: "es2022", types: [], noUnusedLocals: true },
    include: ["src/**/*.ts"]
  }));

  const failed = await ports.verify("src/target.ts");
  expect(failed.diagnostics.map(row => row.patternId)).toContain("TS6196");
  const proposal = await proposeCompilerOwnedRepair({
    workspaceRoot: root,
    targetPath: "src/target.ts",
    targetText: source,
    requestText: "repair this file",
    attempt: 1,
    diagnostics: failed.diagnostics
  });

  expect(isCompilerRepairProposal(proposal)).toBe(true);
  if (!isCompilerRepairProposal(proposal)) return;
  expect(proposal.selection?.selected?.diagnosticIdentity).toBeTruthy();
  expect(proposal.selection?.selected?.codeFixIdentity).toBeTruthy();
  const result = await runCodeMouth({ ports, targetPath: "src/target.ts", request: "repair this file", maxAttempts: 3 });
  expect(result.outcome).toBe("resolved");
  expect(result.planningSelections).toHaveLength(1);
  expect(await readFile(path.join(root, "src/target.ts"), "utf8")).toBe("import type { Kept } from \"./types.js\";\nexport const value = (input: Kept) => input.value;\n");
}, 30_000);

it("keeps a singleton unselected without failed-goal evidence and rejects stale evidence", async () => {
  const { root, source, ports } = await fixture();
  const failed = await ports.verify("src/target.ts");
  const args = { workspaceRoot: root, targetPath: "src/target.ts", targetText: source, requestText: "repair this file", attempt: 1 };
  expect(isCompilerRepairProposal(await proposeCompilerOwnedRepair(args))).toBe(false);
  expect(isCompilerRepairProposal(await proposeCompilerOwnedRepair({ ...args, diagnostics: failed.diagnostics.map(row => ({ ...row, line: 99 })) }))).toBe(false);
}, 30_000);

it("leaves the file unchanged when the public loop cannot bind its observed diagnostic into planning", async () => {
  const { root, source, ports } = await fixture();
  const result = await runCodeMouth({
    targetPath: "src/target.ts",
    request: "repair this file",
    maxAttempts: 3,
    ports: {
      ...ports,
      propose: input => ports.propose({ ...input, diagnostics: [] })
    }
  });

  expect(result.outcome).toBe("awaiting_selection");
  expect(result.planningSelections).toBeUndefined();
  expect(result.appliedOperations).toEqual([]);
  expect(await readFile(path.join(root, "src/target.ts"), "utf8")).toBe(source);
}, 30_000);

it.each([
  [{}],
  [{ first: "tsc -p tsconfig.json", second: "tsc -p tsconfig.json" }]
] satisfies Array<[Record<string, string>]>)
("declines absent or ambiguous source-observed compiler lanes", async scripts => {
  const { root, source, ports } = await fixture(undefined, scripts);
  const failed = await ports.verify("src/target.ts");
  const result = await proposeCompilerOwnedRepair({ workspaceRoot: root, targetPath: "src/target.ts", targetText: source,
    requestText: "repair this file", attempt: 1, diagnostics: failed.diagnostics });
  expect(isCompilerRepairProposal(result)).toBe(false);
}, 30_000);

it("leaves competing admissible diagnostic repairs unresolved", async () => {
  const { root, source, ports } = await fixture("export const count = 1;\nexport const value = coutn;\nexport const other = coutn;\n");
  const failed = await ports.verify("src/target.ts");
  expect(failed.diagnostics.filter(row => row.patternId === "TS2552")).toHaveLength(2);
  expect(isCompilerRepairProposal(await proposeCompilerOwnedRepair({ workspaceRoot: root, targetPath: "src/target.ts", targetText: source,
    requestText: "repair this file", attempt: 1, diagnostics: failed.diagnostics }))).toBe(false);
}, 30_000);
