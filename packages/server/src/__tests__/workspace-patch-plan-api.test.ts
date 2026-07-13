import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_PATCH_VALIDATION_POLICY_ID,
  ROUTES,
  WORKSPACE_CODING_PATCH_PLAN_REQUEST_SCHEMA,
  WORKSPACE_PATCH_PLAN_REQUEST_SCHEMA,
  parseWorkspaceCodingPatchPlanRequest,
  parseWorkspacePatchPlanRequest,
  planWorkspaceCodingPatchApiRequest,
  planWorkspacePatchApiRequest
} from "../routes.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("workspace patch planning API contract", () => {
  it("registers an authenticated database-backed non-mutating route and parses the bounded request", () => {
    expect(ROUTES).toContainEqual({
      method: "POST",
      path: "/api/workspace/patch/plan",
      label: "workspace patch plan",
      mutates: false,
      requiresDb: true
    });
    expect(parseWorkspacePatchPlanRequest(validRequest()).input).toMatchObject({
      workspaceId: "workspace-1",
      expectedWorkspaceUpdatedAt: 1700000000000,
      requestedPaths: ["README.md"],
      validationPlan: {
        validatorId: DEFAULT_WORKSPACE_PATCH_VALIDATION_POLICY_ID,
        checks: ["tests"]
      }
    });
    expect(ROUTES).toContainEqual({
      method: "POST",
      path: "/api/workspace/patch/plan/request",
      label: "workspace coding request plan",
      mutates: false,
      requiresDb: true
    });
    expect(parseWorkspaceCodingPatchPlanRequest(validCodingRequest()).input).toMatchObject({
      requestId: "request-1",
      requestText: "Update the existing source module.",
      requestedPaths: ["src/index.ts"]
    });
  });

  it("rejects roots, commands, authorization or execution spoofing, and unknown nested fields", () => {
    for (const forbidden of [
      { workspaceRoot: "C:/escape" },
      { rootPath: "C:/escape" },
      { command: "pnpm validate" },
      { authorization: { granted: true } },
      { execution: { state: "succeeded" } },
      { unknown: true }
    ]) {
      expect(() => parseWorkspacePatchPlanRequest({ ...validRequest(), ...forbidden })).toThrow(/unexpected:/u);
    }
    expect(() => parseWorkspacePatchPlanRequest({
      ...validRequest(),
      validationPlan: {
        validatorId: DEFAULT_WORKSPACE_PATCH_VALIDATION_POLICY_ID,
        checks: ["tests"],
        commands: [{ executable: "powershell", argv: ["-Command", "exit 0"] }]
      }
    })).toThrow(/unexpected: commands/u);
    expect(() => parseWorkspacePatchPlanRequest({
      ...validRequest(),
      proposedFiles: [{ ...validRequest().proposedFiles[0], workspaceRoot: "C:/escape" }]
    })).toThrow(/unexpected: workspaceRoot/u);
    for (const forbidden of [
      { proposedFiles: [{ path: "src/index.ts", content: "caller bytes" }] },
      { assessment: { fabricatedBehavior: 0 } },
      { command: "pnpm test" },
      { authorization: { granted: true } },
      { execution: { state: "succeeded" } }
    ]) {
      expect(() => parseWorkspaceCodingPatchPlanRequest({ ...validCodingRequest(), ...forbidden })).toThrow(/unexpected:/u);
    }
  });

  it("rejects unsafe paths, spoofed hashes, permissive numeric coercion, and unbounded content", () => {
    expect(() => parseWorkspacePatchPlanRequest({
      ...validRequest(),
      proposedFiles: [{ ...validRequest().proposedFiles[0], path: "../escape.ts" }]
    })).toThrow(/unsafe/u);
    expect(() => parseWorkspacePatchPlanRequest({
      ...validRequest(),
      proposedFiles: [{ ...validRequest().proposedFiles[0], expectedContentHash: "sha256:fake" }]
    })).toThrow(/durable SHA-256/u);
    expect(() => parseWorkspacePatchPlanRequest({ ...validRequest(), expectedWorkspaceUpdatedAt: "1700000000000" })).toThrow(/safe integer/u);
    expect(() => parseWorkspacePatchPlanRequest({
      ...validRequest(),
      proposedFiles: [{ ...validRequest().proposedFiles[0], content: "x".repeat(4 * 1024 * 1024 + 1) }]
    })).toThrow(/4194304 UTF-8 bytes/u);
  });

  it("builds an exact-byte plan through WorkspaceRuntime without changing the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "yopp-patch-plan-api-"));
    roots.push(root);
    const filePath = join(root, "README.md");
    const before = "# Before\n";
    const after = "# After\n";
    await writeFile(filePath, before, "utf8");
    const updatedAt = 1700000000000;
    const workspace = {
      id: "workspace-1",
      rootPath: root,
      rootUri: `file://${root.replaceAll("\\", "/")}`,
      corpusId: "corpus-1",
      status: "active",
      createdAt: updatedAt,
      updatedAt,
      metadata: {}
    };
    const source = {
      workspaceId: workspace.id,
      corpusId: workspace.corpusId,
      path: "README.md",
      absolutePath: filePath,
      mediaType: "text/markdown",
      contentHash: durableHash(before),
      modifiedTime: updatedAt,
      byteLength: Buffer.byteLength(before),
      ingestionStatus: "ingested",
      evidenceIds: [],
      symbolIds: [],
      conceptIds: [],
      warnings: [],
      errors: [],
      metadata: {},
      updatedAt
    };
    const context = {
      runtime: {
        storage: {
          workspace: {
            latestWorkspace: async () => workspace,
            listSourceFiles: async () => [source]
          }
        }
      },
      config: {
        runtime: {
          workspaceRoot: root,
          allowedRoots: [root]
        }
      }
    } as unknown as Parameters<typeof planWorkspacePatchApiRequest>[0];
    const request = parseWorkspacePatchPlanRequest(validRequest({
      expectedWorkspaceUpdatedAt: updatedAt,
      proposedFiles: [{
        path: "README.md",
        content: after,
        mediaType: "text/markdown",
        role: "doc",
        expectedContentHash: durableHash(before)
      }]
    }));

    const result = await planWorkspacePatchApiRequest(context, request);

    expect(result).toMatchObject({
      schemaVersion: "yopp.workspace-plan-generation.v1",
      workspaceId: workspace.id,
      plan: {
        schemaVersion: "yopp.patch-transaction-plan.v1",
        operations: [{ kind: "replace", path: "README.md", content: after }]
      },
      authorization: { required: true, granted: false, capabilityId: "workspace.patch.apply" },
      execution: { state: "not_executed", receipt: null }
    });
    expect(await readFile(filePath, "utf8")).toBe(before);
  });

  it("fails closed instead of replacing an existing module with a generic generated scaffold", async () => {
    const root = await mkdtemp(join(tmpdir(), "scce-coding-plan-api-"));
    roots.push(root);
    const files = new Map([
      ["package.json", `${JSON.stringify({ name: "fixture", type: "module", scripts: { build: "tsc -p tsconfig.json", test: "vitest run" } }, null, 2)}\n`],
      ["src/index.ts", "export function existingValue() { return 1; }\n"],
      ["README.md", "# Fixture\n\nA small TypeScript package.\n"]
    ]);
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "test"), { recursive: true });
    for (const [relative, content] of files) {
      const absolute = join(root, relative);
      await writeFile(absolute, content, "utf8");
    }
    const updatedAt = 1_700_000_000_000;
    const workspace = {
      id: "workspace-coding-1",
      rootPath: root,
      rootUri: `file://${root.replaceAll("\\", "/")}`,
      corpusId: "corpus-coding-1",
      status: "active",
      createdAt: updatedAt,
      updatedAt,
      metadata: {}
    };
    const sources = [...files].map(([relative, content]) => ({
      workspaceId: workspace.id,
      corpusId: workspace.corpusId,
      path: relative,
      absolutePath: join(root, relative),
      mediaType: relative.endsWith(".json") ? "application/json" : relative.endsWith(".md") ? "text/markdown" : "text/typescript",
      contentHash: durableHash(content),
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
    const context = {
      runtime: {
        storage: {
          workspace: {
            latestWorkspace: async () => workspace,
            listSourceFiles: async () => sources
          }
        }
      },
      config: {
        runtime: {
          workspaceRoot: root,
          tempRoot: join(root, ".tmp"),
          maxFileBytes: 1024 * 1024,
          maxChunkBytes: 64 * 1024,
          allowedRoots: [root],
          excludedPaths: [],
          tools: {}
        }
      }
    } as unknown as Parameters<typeof planWorkspaceCodingPatchApiRequest>[0];
    const request = parseWorkspaceCodingPatchPlanRequest({
      schemaVersion: WORKSPACE_CODING_PATCH_PLAN_REQUEST_SCHEMA,
      workspaceId: workspace.id,
      expectedWorkspaceUpdatedAt: updatedAt,
      requestId: "request.update-library",
      requestText: "Update the existing library module with explicit input validation and a structured result.",
      requestedPaths: ["src/index.ts"],
      validationPlan: {
        validatorId: DEFAULT_WORKSPACE_PATCH_VALIDATION_POLICY_ID,
        checks: ["compiler", "typecheck", "tests"]
      }
    });

    await expect(planWorkspaceCodingPatchApiRequest(context, request))
      .rejects.toThrow(/coding request is unsupported: request did not couple to an admissible workspace kernel answer/u);
    expect(await readFile(join(root, "src/index.ts"), "utf8")).toBe(files.get("src/index.ts"));
    await expect(readFile(join(root, "src/domain.ts"), "utf8")).rejects.toThrow();
    await expect(readFile(join(root, "test/generated-artifact.test.ts"), "utf8")).rejects.toThrow();

    const unsupported = parseWorkspaceCodingPatchPlanRequest({
      ...validCodingRequest({
        workspaceId: workspace.id,
        expectedWorkspaceUpdatedAt: updatedAt,
        requestId: "request.unsupported-path",
        requestText: "Implement a source file for which no program artifact was materialized.",
        requestedPaths: ["src/not-materialized.ts"]
      })
    });
    await expect(planWorkspaceCodingPatchApiRequest(context, unsupported)).rejects.toThrow(/coding request is unsupported/u);
    await expect(readFile(join(root, "src/not-materialized.ts"), "utf8")).rejects.toThrow();
  }, 30_000);
});

type TestPatchPlanRequest = Record<string, unknown> & { proposedFiles: Array<Record<string, unknown>> };

function validRequest(overrides: Record<string, unknown> = {}): TestPatchPlanRequest {
  return {
    schemaVersion: WORKSPACE_PATCH_PLAN_REQUEST_SCHEMA,
    workspaceId: "workspace-1",
    expectedWorkspaceUpdatedAt: 1700000000000,
    proposedFiles: [{
      path: "README.md",
      content: "# After\n",
      mediaType: "text/markdown",
      role: "doc",
      expectedContentHash: `sha256_${"a".repeat(64)}`
    }],
    requestedPaths: ["README.md"],
    assessment: {
      assessmentId: "assessment-1",
      evidenceIds: ["evidence-1"],
      requestedBehaviorCoverage: 1,
      dependencyConsistency: 1,
      architecturalFit: 1,
      explanationAccuracy: 1,
      fabricatedBehavior: 0
    },
    validationPlan: {
      validatorId: DEFAULT_WORKSPACE_PATCH_VALIDATION_POLICY_ID,
      checks: ["tests"]
    },
    ...overrides
  } as TestPatchPlanRequest;
}

function validCodingRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: WORKSPACE_CODING_PATCH_PLAN_REQUEST_SCHEMA,
    workspaceId: "workspace-1",
    expectedWorkspaceUpdatedAt: 1700000000000,
    requestId: "request-1",
    requestText: "Update the existing source module.",
    requestedPaths: ["src/index.ts"],
    validationPlan: {
      validatorId: DEFAULT_WORKSPACE_PATCH_VALIDATION_POLICY_ID,
      checks: ["compiler", "typecheck", "tests"]
    },
    ...overrides
  };
}

function durableHash(content: string): string {
  return `sha256_${createHash("sha256").update(content).digest("hex")}`;
}
