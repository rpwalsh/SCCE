import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceRuntime, type WorkspaceCodingPatchPlanningResult } from "../workspace-runtime.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("WorkspaceRuntime compiler transformation planning", () => {
  it("selects one exact requested-path compiler fix without reading request prose", async () => {
    const fixture = await workspaceFixture(baseFiles({
      "src/index.ts": "const unused = 1;\nexport const value = 2;\n"
    }));
    const result = await plan(fixture, ["src/index.ts"], "요청 표면은 선택기가 읽지 않는다", [6133]);

    expectSelected(result);
    expect(result.plan.operations).toEqual([expect.objectContaining({
      kind: "replace",
      path: "src/index.ts",
      content: "export const value = 2;\n"
    })]);
    expect(result.constraintGraph.audit).toMatchObject({ requestTextUsed: false });
    expect(result.execution).toEqual({ state: "not_executed", receipt: null });
  });

  it("binds a compiler-owned misspelling replacement to the exact declared symbol", async () => {
    const fixture = await workspaceFixture(baseFiles({
      "src/index.ts": "import type { Legacy } from \"./legacy\";\nconst count = 1;\nexport const value = coutn;\n",
      "src/legacy.ts": "export interface Legacy { value: number; }\n"
    }));
    const result = await plan(fixture, ["src/index.ts"], "opaque", [2552]);

    expectSelected(result);
    expect(result.plan.operations).toEqual([expect.objectContaining({
      kind: "replace",
      path: "src/index.ts",
      content: "import type { Legacy } from \"./legacy\";\nconst count = 1;\nexport const value = count;\n"
    })]);
    expect(result.constraintGraph.audit).toMatchObject({ compilerDiagnosticSymbolBindingCount: 1 });
  });

  it("keeps an unrequested compiler action out of scope and admits it only when every affected file is requested", async () => {
    const fixture = await workspaceFixture(baseFiles({
      "src/a.ts": "const hidden = 1;\nexport const visible = 2;\n",
      "src/b.ts": "import { hidden } from \"./a\";\nexport const value = hidden;\n"
    }));
    const refused = await plan(fixture, ["src/b.ts"], "opaque request surface", [2459]);
    expectUnselected(refused);
    expect(refused.rejectedCandidates.flatMap(candidate => candidate.reasonIds)).toEqual(expect.arrayContaining([
      "scce.transformation.reject.affected_file_unbound.v1",
      "scce.transformation.reject.protected_invariant.v1"
    ]));

    const explicitlyScoped = await plan(fixture, ["src/a.ts", "src/b.ts"], "opaque request surface", [2459]);
    expectSelected(explicitlyScoped);
    expect(explicitlyScoped.plan.operations).toEqual([expect.objectContaining({
      kind: "replace",
      path: "src/a.ts",
      content: "export const hidden = 1;\nexport const visible = 2;\n"
    })]);
    expect(explicitlyScoped.constraintGraph.audit).toMatchObject({ requestTextUsed: false });
  });

  it("returns structured unresolved state for absent and ambiguous compiler lanes and an absent config", async () => {
    const absent = await workspaceFixture(new Map([
      ["package.json", `${JSON.stringify({ scripts: { check: "vitest run" } })}\n`],
      ["src/index.ts", "export const value = 1;\n"]
    ]));
    expect(await plan(absent, ["src/index.ts"], "opaque", [2552])).toMatchObject({
      statusId: "scce.workspace.compiler_patch.unresolved.v1",
      reasonIds: ["scce.workspace.compiler_patch.unresolved.compiler_lane_absent.v1"],
      plan: null,
      execution: { state: "not_executed", receipt: null }
    });

    const ambiguous = await workspaceFixture(new Map([
      ["package.json", `${JSON.stringify({ scripts: { a: "tsc -p tsconfig.json", b: "tsc -p tsconfig.json" } })}\n`],
      ["tsconfig.json", `${JSON.stringify({ compilerOptions: { strict: true }, include: ["src/**/*.ts"] })}\n`],
      ["src/index.ts", "export const value = 1;\n"]
    ]));
    expect(await plan(ambiguous, ["src/index.ts"], "opaque", [2552])).toMatchObject({
      statusId: "scce.workspace.compiler_patch.unresolved.v1",
      reasonIds: ["scce.workspace.compiler_patch.unresolved.compiler_lane_ambiguous.v1"],
      observedCompilerLaneCount: 2,
      plan: null
    });

    const noConfig = await workspaceFixture(new Map([
      ["package.json", `${JSON.stringify({ scripts: { build: "tsc -p missing.json" } })}\n`],
      ["src/index.ts", "export const value = 1;\n"]
    ]));
    expect(await plan(noConfig, ["src/index.ts"], "opaque", [2552])).toMatchObject({
      statusId: "scce.workspace.compiler_patch.unresolved.v1",
      reasonIds: ["scce.workspace.compiler_patch.unresolved.compiler_config_absent.v1"],
      observedCompilerLaneCount: 1,
      plan: null
    });
  });

  it("returns a structured unresolved state without launching compiler selection when the diagnostic selector is absent", async () => {
    const fixture = await workspaceFixture(baseFiles({ "src/index.ts": "export const value = 1;\n" }));
    const result = await plan(fixture, ["src/index.ts"]);
    expect(result).toMatchObject({
      statusId: "scce.workspace.compiler_patch.unresolved.v1",
      reasonIds: ["scce.workspace.compiler_patch.unresolved.diagnostic_selector_absent.v1"],
      selection: null,
      plan: null,
      execution: { state: "not_executed", receipt: null }
    });
  });

  it("returns the verified selector state when the selected diagnostic has no fixable candidate", async () => {
    const fixture = await workspaceFixture(baseFiles({ "src/index.ts": "export const value = 1;\n" }));
    const result = await plan(fixture, ["src/index.ts"], "opaque", [6133]);
    expectUnselected(result);
    expect(result.execution).toEqual({ state: "not_executed" });
    expect(result.unresolvedOutcomes.flatMap(outcome => outcome.reasonIds)).toContain(
      "scce.transformation.reject.no_admissible_family.v1"
    );
  });

  it("refuses a durable workspace revision that changes during semantic analysis", async () => {
    const fixture = await workspaceFixture(baseFiles({
      "src/index.ts": "const unused = 1;\nexport const value = 2;\n"
    }));
    let latestCalls = 0;
    const staleRuntime = createWorkspaceRuntime({
      runtime: {
        storage: {
          workspace: {
            latestWorkspace: async () => latestCalls++ === 0
              ? fixture.workspace
              : { ...fixture.workspace, updatedAt: Number(fixture.workspace.updatedAt) + 1 },
            listSourceFiles: async () => fixture.sources
          }
        }
      } as never,
      config: { runtime: { workspaceRoot: fixture.root, allowedRoots: [fixture.root] } } as never
    });
    await expect(staleRuntime.planCodingPatch({
      workspaceId: String(fixture.workspace.id),
      expectedWorkspaceUpdatedAt: Number(fixture.workspace.updatedAt),
      requestId: "request.stale",
      requestText: "opaque",
      requestedPaths: ["src/index.ts"],
      diagnosticCodes: [6133],
      validationPlan: { validatorId: "trusted-host-pnpm-validate.v1", checks: ["compiler"] }
    }, fixture.root, { maxFiles: 64, maxFileBytes: 1024 * 1024 })).rejects.toThrow(/stale workspace revision/u);
  });

  it("permits an explicitly requested test edit while protecting every unrequested compiler-observed file", async () => {
    const fixture = await workspaceFixture(baseFiles({
      "src/value.ts": "export const count = 1;\n",
      "test/value.test.ts": "import { count } from \"../src/value\";\nconst unused = 1;\nexport const observed = count;\n"
    }, ["src/**/*.ts", "test/**/*.ts"]));
    const result = await plan(fixture, ["test/value.test.ts"], "opaque request surface", [6133]);
    expectSelected(result);
    expect(result.plan.operations.map(operation => operation.path)).toEqual(["test/value.test.ts"]);
    const protectedPaths = result.constraintGraph.protectedInvariantNodeIds.map(id =>
      result.constraintGraph.nodes.find(node => node.id === id)?.path
    );
    expect(protectedPaths).toEqual(expect.arrayContaining(["package.json", "tsconfig.json", "src/value.ts"]));
    expect(protectedPaths).not.toContain("test/value.test.ts");
  });
});

interface Fixture {
  root: string;
  workspace: Record<string, unknown>;
  sources: Record<string, unknown>[];
  runtime: ReturnType<typeof createWorkspaceRuntime>;
}

function baseFiles(sources: Record<string, string>, include: string[] = ["src/**/*.ts"]): Map<string, string> {
  return new Map([
    ["package.json", `${JSON.stringify({ scripts: { build: "tsc -p tsconfig.json" } })}\n`],
    ["tsconfig.json", `${JSON.stringify({ compilerOptions: { strict: true, noUnusedLocals: true, module: "ESNext", moduleResolution: "Bundler" }, include })}\n`],
    ...Object.entries(sources)
  ]);
}

async function workspaceFixture(files: Map<string, string>): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "scce-compiler-planning-"));
  roots.push(root);
  for (const [relative, content] of files) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
  const updatedAt = 1_700_000_000_000;
  const workspace = {
    id: `workspace-${createHash("sha256").update(root).digest("hex").slice(0, 16)}`,
    rootPath: root,
    rootUri: `file://${root.replaceAll("\\", "/")}`,
    corpusId: "corpus.compiler-planning",
    status: "active",
    createdAt: updatedAt,
    updatedAt,
    metadata: {}
  };
  const sources = [...files].map(([relative, content]) => ({
    workspaceId: workspace.id,
    corpusId: workspace.corpusId,
    path: relative,
    absolutePath: path.join(root, relative),
    mediaType: relative.endsWith(".json") ? "application/json" : "text/typescript",
    contentHash: `sha256_${createHash("sha256").update(content).digest("hex")}`,
    modifiedTime: updatedAt,
    byteLength: Buffer.byteLength(content),
    ingestionStatus: "ingested",
    evidenceIds: [],
    symbolIds: [],
    conceptIds: [],
    warnings: [],
    errors: [],
    metadata: {},
    updatedAt
  }));
  const runtime = createWorkspaceRuntime({
    runtime: { storage: { workspace: { latestWorkspace: async () => workspace, listSourceFiles: async () => sources } } } as never,
    config: { runtime: { workspaceRoot: root, allowedRoots: [root] } } as never
  });
  return { root, workspace, sources, runtime };
}

async function plan(fixture: Fixture, requestedPaths: string[], requestText = "opaque request surface", diagnosticCodes: number[] = []): Promise<WorkspaceCodingPatchPlanningResult> {
  return fixture.runtime.planCodingPatch({
    workspaceId: String(fixture.workspace.id),
    expectedWorkspaceUpdatedAt: Number(fixture.workspace.updatedAt),
    requestId: `request-${createHash("sha256").update(JSON.stringify(requestedPaths)).digest("hex").slice(0, 12)}`,
    requestText,
    requestedPaths,
    ...(diagnosticCodes.length ? { diagnosticCodes } : {}),
    validationPlan: { validatorId: "trusted-host-pnpm-validate.v1", checks: ["compiler"] }
  }, fixture.root, { maxFiles: 64, maxFileBytes: 1024 * 1024 });
}

function expectSelected(result: WorkspaceCodingPatchPlanningResult): asserts result is Extract<WorkspaceCodingPatchPlanningResult, { statusId: "scce.workspace.compiler_patch.selected.v1" }> {
  if (!("statusId" in result) || result.statusId !== "scce.workspace.compiler_patch.selected.v1") throw new Error(JSON.stringify(result));
  expect(result.statusId).toBe("scce.workspace.compiler_patch.selected.v1");
}

function expectUnselected(result: WorkspaceCodingPatchPlanningResult): asserts result is WorkspaceTransformationSelectionResult {
  expect("schema" in result && result.schema).toBe("scce.workspace.transformation_family_selection.v1");
  if (!("schema" in result)) throw new Error("selector fixture did not return selector state");
  expect(result.selected).toBeNull();
}

type WorkspaceTransformationSelectionResult = Extract<WorkspaceCodingPatchPlanningResult, { schema: string }>;
