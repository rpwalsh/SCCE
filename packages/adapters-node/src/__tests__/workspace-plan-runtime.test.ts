import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  verifyPatchTransactionPlan,
  type WorkspaceRecord,
  type WorkspaceSourceFileRecord,
  type WorkspaceStore
} from "@scce/kernel";
import type { ScceRuntimeConfig } from "../config.js";
import type { NodeScceRuntime } from "../runtime.js";
import {
  createWorkspaceRuntime,
  type WorkspacePatchPlanningInput
} from "../workspace-runtime.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("workspace patch planning from a durable revision", () => {
  it("turns exact durable bytes and hashes into an unauthorized, unexecuted transaction plan", async () => {
    const fixture = await durableWorkspaceFixture("# Current\n");
    const runtime = createWorkspaceRuntime({
      runtime: fakeRuntime(fixture.store),
      config: fixtureConfig(fixture.root)
    });

    const result = await runtime.planPatch(replacementInput(fixture.workspace, fixture.contentHash), fixture.root);

    expect(result.workspaceId).toBe(fixture.workspace.id);
    expect(result.revisionId).toBe(`${fixture.workspace.id}:${fixture.workspace.updatedAt}`);
    expect(result.authorization).toEqual({
      required: true,
      granted: false,
      capabilityId: "workspace.patch.apply"
    });
    expect(result.execution).toEqual({ state: "not_executed", receipt: null });
    expect(result.plan.operations).toHaveLength(1);
    expect(result.plan.operations[0]).toMatchObject({
      kind: "replace",
      path: "README.md",
      beforeContentHash: patchHash("# Current\n"),
      content: "# Proposed\n"
    });
    expect(result.safety.exactBaseHashPaths).toEqual(["README.md"]);
    expect(() => verifyPatchTransactionPlan(result.plan)).not.toThrow();
  });

  it("refuses stale durable bytes and a stale workspace timestamp", async () => {
    const fixture = await durableWorkspaceFixture("# Durable\n");
    const runtime = createWorkspaceRuntime({
      runtime: fakeRuntime(fixture.store),
      config: fixtureConfig(fixture.root)
    });

    await writeFile(path.join(fixture.root, "README.md"), "# Changed after ingest\n", "utf8");
    await expect(runtime.planPatch(
      replacementInput(fixture.workspace, fixture.contentHash),
      fixture.root
    )).rejects.toThrow(/stale durable workspace bytes for README\.md/u);

    await writeFile(path.join(fixture.root, "README.md"), "# Durable\n", "utf8");
    await expect(runtime.planPatch({
      ...replacementInput(fixture.workspace, fixture.contentHash),
      expectedWorkspaceUpdatedAt: fixture.workspace.updatedAt - 1
    }, fixture.root)).rejects.toThrow(/stale workspace revision/u);
  });

  it("accepts a create only while both the durable revision and filesystem prove absence", async () => {
    const fixture = await durableWorkspaceFixture("# Current\n");
    const runtime = createWorkspaceRuntime({
      runtime: fakeRuntime(fixture.store),
      config: fixtureConfig(fixture.root)
    });
    const input: WorkspacePatchPlanningInput = {
      ...basePlanningInput(fixture.workspace),
      proposedFiles: [{
        path: "NOTES.md",
        content: "# Notes\n",
        mediaType: "text/markdown",
        role: "doc",
        expectedContentHash: null
      }],
      requestedPaths: ["NOTES.md"]
    };

    const result = await runtime.planPatch(input, fixture.root);
    expect(result.plan.operations[0]).toMatchObject({
      kind: "create",
      path: "NOTES.md",
      beforeContentHash: null,
      content: "# Notes\n"
    });
    expect(result.safety.provenAbsentCreatePaths).toEqual(["NOTES.md"]);

    await writeFile(path.join(fixture.root, "NOTES.md"), "untracked but present\n", "utf8");
    await expect(runtime.planPatch(input, fixture.root)).rejects.toThrow(/workspace creation target is not absent: NOTES\.md/u);
  });
});

async function durableWorkspaceFixture(content: string): Promise<{
  root: string;
  workspace: WorkspaceRecord;
  contentHash: string;
  store: MemoryWorkspaceStore;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "yopp-workspace-plan-"));
  temporaryRoots.push(root);
  const absolutePath = path.join(root, "README.md");
  await writeFile(absolutePath, content, "utf8");
  const contentHash = durableHash(content);
  const workspace: WorkspaceRecord = {
    id: "workspace.plan-test",
    rootPath: root,
    rootUri: `file://${root.split(path.sep).join("/")}`,
    corpusId: "corpus.plan-test",
    status: "active",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_100,
    metadata: {}
  };
  const source: WorkspaceSourceFileRecord = {
    workspaceId: workspace.id,
    corpusId: workspace.corpusId,
    path: "README.md",
    absolutePath,
    mediaType: "text/markdown",
    contentHash: contentHash as WorkspaceSourceFileRecord["contentHash"],
    modifiedTime: workspace.updatedAt,
    byteLength: Buffer.byteLength(content, "utf8"),
    ingestionStatus: "ingested",
    importBatchId: "import.plan-test",
    evidenceIds: [],
    symbolIds: [],
    conceptIds: [],
    warnings: [],
    errors: [],
    metadata: {},
    updatedAt: workspace.updatedAt
  };
  const store = new MemoryWorkspaceStore(workspace, source);
  return { root, workspace, contentHash, store };
}

function replacementInput(workspace: WorkspaceRecord, expectedContentHash: string): WorkspacePatchPlanningInput {
  return {
    ...basePlanningInput(workspace),
    proposedFiles: [{
      path: "README.md",
      content: "# Proposed\n",
      mediaType: "text/markdown",
      role: "doc",
      expectedContentHash
    }],
    requestedPaths: ["README.md"]
  };
}

function basePlanningInput(workspace: WorkspaceRecord): Omit<WorkspacePatchPlanningInput, "proposedFiles" | "requestedPaths"> {
  return {
    workspaceId: workspace.id,
    expectedWorkspaceUpdatedAt: workspace.updatedAt,
    assessment: {
      assessmentId: "assessment.plan-test",
      evidenceIds: ["evidence.plan-test"],
      requestedBehaviorCoverage: 1,
      dependencyConsistency: 1,
      architecturalFit: 1,
      explanationAccuracy: 1,
      fabricatedBehavior: 0
    },
    validationPlan: {
      validatorId: "validator.plan-test",
      checks: ["tests"]
    }
  };
}

function durableHash(content: string): string {
  return `sha256_${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function patchHash(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

class MemoryWorkspaceStore implements WorkspaceStore {
  constructor(
    private readonly workspace: WorkspaceRecord,
    private readonly source: WorkspaceSourceFileRecord
  ) {}

  async putWorkspace(): Promise<void> {}
  async getWorkspace(id: string): Promise<WorkspaceRecord | null> {
    return id === this.workspace.id ? this.workspace : null;
  }
  async latestWorkspace(): Promise<WorkspaceRecord | null> {
    return this.workspace;
  }
  async putSourceFile(): Promise<void> {}
  async listSourceFiles(query: { workspaceId?: string; limit?: number } = {}): Promise<WorkspaceSourceFileRecord[]> {
    if (query.workspaceId && query.workspaceId !== this.workspace.id) return [];
    return [this.source].slice(0, query.limit ?? 1);
  }
  async putReport(): Promise<void> {}
  async listReports(): Promise<[]> {
    return [];
  }
}

function fakeRuntime(workspace: WorkspaceStore): NodeScceRuntime {
  return {
    storage: { workspace } as NodeScceRuntime["storage"],
    kernel: {} as NodeScceRuntime["kernel"],
    connectors: {} as NodeScceRuntime["connectors"],
    approvals: {} as NodeScceRuntime["approvals"],
    close: async () => {}
  };
}

function fixtureConfig(root: string): ScceRuntimeConfig {
  return {
    server: { url: "http://127.0.0.1:0" },
    database: { url: "postgres://example/example", schema: "public" },
    runtime: {
      workspaceRoot: root,
      tempRoot: path.join(root, ".tmp"),
      maxFileBytes: 1024 * 1024,
      maxChunkBytes: 64 * 1024,
      allowedRoots: [root],
      excludedPaths: [],
      tools: {}
    },
    connectors: {},
    policy: {
      allowMutation: false,
      requireTwoPhaseCommit: true,
      dryRunByDefault: true,
      maxNetworkRequests: 0,
      maxToolCalls: 0,
      maxSpendCents: 0,
      alphaRiskCeiling: 0.5,
      encryptSecretsAtRest: true
    }
  };
}
