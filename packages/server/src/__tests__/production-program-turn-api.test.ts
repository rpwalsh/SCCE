import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@scce/adapters-node", async importOriginal => {
  const actual = await importOriginal<typeof import("@scce/adapters-node")>();
  return {
    ...actual,
    assertHydratedRuntimeReady: vi.fn(async () => ({
      activeBrainVersion: "brain.integration.v1",
      activeImportRunIds: []
    }))
  };
});

import {
  createClock,
  createHasher,
  createIdFactory,
  createInMemoryDialogueMemoryStore,
  createScceKernel,
  type PatchTransactionPlan,
  type ScceEvent,
  type ScceStorage,
  type LanguagePatternRecord,
  type LanguageProfile,
  type WorkspaceRecord,
  type WorkspaceSourceFileRecord
} from "@scce/kernel";
import {
  NodeBuildTestAdapter,
  trustedHostPatchValidationProvider,
  type StructuredPatchValidationPolicy
} from "@scce/adapters-node";
import { handleRequest, WORKSPACE_CODING_TURN_REQUEST_SCHEMA, WORKSPACE_PATCH_REQUEST_SCHEMA, type ApiContext } from "../routes.js";

const roots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("production owner program turn through the API", () => {
  it("emits a real source/test proposal, observes failure, replans, reruns, and then executes it in an empty workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "scce-production-program-api-"));
    roots.push(root);
    const executionRoot = await mkdtemp(join(tmpdir(), "scce-production-program-exec-"));
    roots.push(executionRoot);
    const workspace: WorkspaceRecord = {
      id: "workspace.production.owner.blank",
      rootPath: root,
      rootUri: `file://${root.replaceAll("\\", "/")}`,
      corpusId: "corpus.production.owner.blank",
      status: "active",
      createdAt: 101_000,
      updatedAt: 101_000,
      metadata: {}
    };
    const events: ScceEvent[] = [];
    const sources: WorkspaceSourceFileRecord[] = [];
    const storage = integrationStorage({ events, workspace, sources });
    const clock = createClock({ fixedTime: 101_000, stepMs: 1 });
    const hasher = createHasher();
    const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
    const buildTest = new NodeBuildTestAdapter({ runtime: { tempRoot: executionRoot } } as never);
    const attempts: Array<{ source: string; testCode: number | null }> = [];
    const kernel = createScceKernel({
      storage,
      files: { streamPath: async function* () { /* no source files in the blank workspace */ } },
      buildTest: {
        executeProgram: async input => {
          const result = await buildTest.executeProgram(input);
          attempts.push({
            source: result.artifacts.find(artifact => artifact.path === "src/program.mjs")?.content ?? "",
            testCode: result.test.code
          });
          return result;
        }
      },
      approvals: { isApproved: () => true, observePending: () => undefined, policyPatch: () => ({ dryRunByDefault: false }) },
      idFactory: ids,
      clock,
      deterministicReplay: true
    });
    const context = {
      runtime: {
        storage: { ...storage, dialogueMemory: createInMemoryDialogueMemoryStore() },
        kernel,
        approvals: { isApproved: () => true, requestApproval: () => undefined, snapshot: () => ({ operatorGrant: true, pending: [] }) }
      },
      config: {
        server: { url: "http://127.0.0.1" },
        runtime: { workspaceRoot: root, allowedRoots: [root], tempRoot: executionRoot, tools: { pnpm: "pnpm" } },
        policy: { allowMutation: true }
      },
      patchValidation: {
        provider: trustedHostPatchValidationProvider,
        resolvePolicy: (policyId: string) => policyId === "owner-program-api-node.v1"
          ? ownerValidationPolicy()
          : (() => { throw new Error(`unexpected validation policy: ${policyId}`); })()
      },
      startupReadiness: { snapshot: () => ({ phase: "running", ok: true, complete: true }) }
    } as unknown as ApiContext;
    const server = createServer((request, response) => { void handleRequest(request, response, context); });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("integration server has no TCP address");

    const requestText = "Create a function double(x) such that double(3) returns 6, double(7) returns 14, double(-2) returns -4, and double(11) returns 22. Add and run a test proving it.";
    const response = await fetch(`http://127.0.0.1:${address.port}/api/turn?full=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: requestText,
        conversationId: "conversation.production.owner.blank",
        workspaceCoding: {
          schemaVersion: WORKSPACE_CODING_TURN_REQUEST_SCHEMA,
          workspaceId: workspace.id,
          expectedWorkspaceUpdatedAt: workspace.updatedAt,
          requestId: "request.production.owner.blank",
          requestedPaths: ["src/program.mjs"],
          diagnosticCodes: [],
          validationPlan: { validatorId: "trusted-host-pnpm-validate.v1", checks: ["compiler", "typecheck", "tests"] }
        }
      })
    });
    const body = await response.json() as Record<string, any>;
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.workspaceCoding?.programProposalTrace, JSON.stringify(body)).toBeDefined();
    const program = body.constructGraph?.program as Record<string, any>;
    const ownerRequirementIds = program.hydration?.ownerRequirementIds as string[];
    expect(ownerRequirementIds).toHaveLength(4);
    expect(program.nodes.some((node: { kind: string; metadata: Record<string, unknown> }) => node.kind === "owner_behavior_requirement" && node.metadata.callableId === "double")).toBe(true);
    expect(body.workspaceCoding?.programProposalTrace?.ownerRequirementIds).toEqual([...ownerRequirementIds].sort());
    expect(body.workspaceCoding?.plan?.operations?.map((operation: { path: string }) => operation.path)).toEqual([
      "src/program.mjs",
      "test/program.test.mjs"
    ]);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.testCode).not.toBe(0);
    expect(attempts[1]?.testCode).toBe(0);
    expect(attempts[0]?.source).toContain("args[0]");
    expect(attempts[1]?.source).toContain("args[0] + args[0]");
    expect(body.buildTest?.passed).toBe(true);

    const plan = body.workspaceCoding.plan as PatchTransactionPlan;
    expect(await readFile(join(root, "src", "program.mjs")).catch(() => undefined)).toBeUndefined();
    const applyResponse = await fetch(`http://127.0.0.1:${address.port}/api/workspace/patch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: WORKSPACE_PATCH_REQUEST_SCHEMA,
        workspaceId: workspace.id,
        plan,
        validationPolicyId: "owner-program-api-node.v1"
      })
    });
    const applied = await applyResponse.json() as Record<string, any>;
    expect(applyResponse.status, JSON.stringify(applied)).toBe(200);
    const receipt = applied.receipt as Record<string, any>;
    expect(receipt.validation?.executedChecks?.map((check: { checkId: string }) => check.checkId)).toEqual(["compiler", "typecheck", "tests"]);
    const source = await readFile(join(root, "src", "program.mjs"), "utf8");
    const test = await readFile(join(root, "test", "program.test.mjs"), "utf8");
    expect(source).toContain("export function double(...args)");
    expect(source).toContain("args[0] + args[0]");
    expect(test).toContain("owner requirement");
    expect(receipt.mutations.map((mutation: { path: string }) => mutation.path)).toEqual(["src/program.mjs", "test/program.test.mjs"]);
    const testEvents = events.filter(event => event.typeId === "TestExecuted");
    expect(testEvents.map(event => (event.payload as { passed?: boolean }).passed)).toEqual([false, true]);
    const passedTestIndex = events.findIndex(event => event.typeId === "TestExecuted" && (event.payload as { passed?: boolean }).passed === true);
    const succeededIndex = events.findIndex(event => event.typeId === "CapabilitySucceeded");
    expect(passedTestIndex).toBeGreaterThanOrEqual(0);
    expect(succeededIndex).toBeGreaterThan(passedTestIndex);
    expect(events.some(event => event.typeId === "ProgramRepaired")).toBe(true);
  }, 60_000);

});

function ownerValidationPolicy(): StructuredPatchValidationPolicy {
  return {
    schemaVersion: "scce.patch-validation-policy.v1",
    id: "owner-program-api-node.v1",
    commands: [
      { executable: process.execPath, argv: ["--check", "src/program.mjs"], checkIds: ["compiler", "typecheck"] },
      { executable: process.execPath, argv: ["test/program.test.mjs"], checkIds: ["tests"] }
    ],
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
    maxWorkspaceFiles: 32,
    maxWorkspaceBytes: 1024 * 1024
  };
}

function integrationStorage(input: {
  events: ScceEvent[];
  workspace: WorkspaceRecord;
  sources: WorkspaceSourceFileRecord[];
  dialogueMemory?: ReturnType<typeof createInMemoryDialogueMemoryStore>;
  languageProfiles?: LanguageProfile[];
  languagePatterns?: LanguagePatternRecord[];
}): ScceStorage {
  const dialogueMemory = input.dialogueMemory ?? createInMemoryDialogueMemoryStore();
  const graph = { bounded: true, query: {}, nodes: [], edges: [], hyperedges: [] } as any;
  const emptyStore = new Proxy({}, { get: () => async () => undefined });
  const storage = {
    events: {
      append: async (event: ScceEvent) => { input.events.push(event); },
      appendBatch: async (events: ScceEvent[]) => { input.events.push(...events); },
      readEpisode: async (episodeId: string) => input.events.filter(event => String(event.episodeId) === episodeId),
      readRange: async () => input.events,
      latestLedgerHash: async () => input.events.at(-1)?.hash ?? ""
    },
    conversation: { putTurn: async () => undefined, listTurns: async () => [] },
    graph: {
      upsertNode: async () => undefined, upsertEdge: async () => undefined, upsertHyperedge: async () => undefined,
      getSlice: async () => graph, getTemporalSlice: async () => ({ ...graph, temporalQuery: {} }),
      materializeAlphaGraph: async () => ({ alpha: 0, thresholds: { virtual: 0, visible: 0, bonded: 0, structural: 0 }, relations: [], adjacency: { nodes: [], values: [] }, laplacian: { nodes: [], values: [] }, normalizedLaplacian: { nodes: [], values: [] }, surfaces: { pressure: 0, drift: 0, contradiction: 0, bond: 0, risk: 0, actionability: 0 }, contradictionMass: 0, bondedLeakage: 0 })
    },
    evidence: {
      putSourceVersion: async () => undefined, putEvidenceSpan: async () => undefined, promoteEvidence: async () => 0,
      getEvidence: async () => null,
      getEvidenceBatch: async () => [],
      searchEvidence: async () => [], sourceVersionsForEvidence: async () => []
    },
    quarantine: { put: async () => undefined, get: async () => null, listPending: async () => [], markDecision: async () => undefined },
    model: { readModel: async () => ({ languageProfiles: input.languageProfiles ?? [], latentConcepts: [], learnedProgramPatterns: [], learningGoals: [], trainingSteps: 0 }), writeModel: async () => undefined, putLanguageProfile: async () => undefined, listLanguageProfiles: async () => input.languageProfiles ?? [] },
    languageMemory: { putNgramObservation: async () => undefined, putNgramObservationsBatch: async () => undefined, putNgramModel: async () => undefined, putLanguageUnit: async () => undefined, putLanguagePattern: async () => undefined, putSemanticFrame: async () => undefined, putTranslationAlignment: async () => undefined, listNgramModels: async () => [], listNgramObservations: async () => [], listLanguageUnits: async () => [], listLanguagePatterns: async () => input.languagePatterns ?? [], listSemanticFrames: async () => [], listTranslationAlignments: async () => [] },
    stats: async () => ({ tables: [] }), init: async () => undefined, migrate: async () => undefined, verify: async () => ({ ok: true, tables: [], errors: [] }), close: async () => undefined,
    blobs: emptyStore, ingestion: emptyStore, proofs: emptyStore, constructs: emptyStore, capabilities: emptyStore, forecasts: { putState: async () => undefined, putForecast: async () => undefined, getSeries: async () => [] }, benchmarks: emptyStore, brainImports: { active: async () => ({ activeImportRunIds: [] }), summarize: async () => ({ activeImportRunIds: [], importedLanguagePriorCount: 0, importedGraphPriorCount: 0, importedDirectEvidenceCount: 0, profileExcerptEvidenceCount: 0, importedLearnedPriorCount: 0, importedProgramPriorCount: 0, unknownPriorCount: 0, runs: [] }) }, corrections: { putRule: async () => undefined, listRules: async () => [] }, dialogueMemory,
    userModelClaims: { putClaim: async () => undefined, listClaims: async () => [] }, taskResumption: { putSnapshot: async () => undefined, getLatestSnapshot: async () => null }, documentGeneration: { putSession: async () => undefined, getSession: async () => null, compareAndPutSession: async () => ({ stored: true, currentUpdatedAt: 0 }) }, localization: emptyStore, flowCache: emptyStore, selfRewrite: emptyStore,
    workspace: { latestWorkspace: async () => input.workspace, listSourceFiles: async () => input.sources, putWorkspace: async () => undefined, putReport: async () => undefined }
  };
  return storage as unknown as ScceStorage;
}
