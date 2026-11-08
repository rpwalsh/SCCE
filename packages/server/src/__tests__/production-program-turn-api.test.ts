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
  createCorpusRegistry,
  corpusSourceAlias,
  createHasher,
  createIdFactory,
  createInMemoryDialogueMemoryStore,
  createLanguageAcquisitionEngine,
  createLanguageMemoryRuntime,
  createScceKernel,
  createUniversalCreativeEventConstructionCompiler,
  compileCreativeEventCompatibilityCorpus,
  compileLanguageTrainingBatch,
  hydrateLanguageConstructionPatterns,
  type PatchTransactionPlan,
  type ScceEvent,
  type TurnResult,
  type ScceStorage,
  type EvidenceSpan,
  type LanguagePatternRecord,
  type LanguageIdentityRecord,
  type LanguageProfile,
  type NgramModelRecord,
  type WorkspaceRecord,
  type WorkspaceSourceFileRecord
} from "@scce/kernel";
import {
  NodeBuildTestAdapter,
  trustedHostPatchValidationProvider,
  type StructuredPatchValidationPolicy
} from "@scce/adapters-node";
import { handleRequest, WORKSPACE_CODING_TURN_REQUEST_SCHEMA, WORKSPACE_PATCH_REQUEST_SCHEMA, type ApiContext } from "../routes.js";
import { creativeReferenceTestAnnotation, replyWithReviewedProperty } from "../../../kernel/src/__tests__/fixtures/creative-reference-test-annotations.js";
import { creativeSourceUtterances } from "../../../kernel/src/creative-source-utterance.js";

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
    const turnResults: TurnResult[] = [];
    const nativeTurn = kernel.turn.bind(kernel);
    kernel.turn = async input => {
      const result = await nativeTurn(input);
      turnResults.push(result);
      return { ...result, workingMemory: { internalDiagnostic: "internal-only".repeat(300_000) } };
    };
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
    const response = await fetch(`http://127.0.0.1:${address.port}/api/turn`, {
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
    const ownerRequirementIds = body.workspaceCoding?.programProposalTrace?.ownerRequirementIds as string[];
    expect(ownerRequirementIds).toHaveLength(4);
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
    expect(body.buildTest).toEqual(turnResults[0]?.buildTest);
    expect(JSON.stringify(body)).not.toContain("internal-only".repeat(1000));

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

    const verifiedResponse = await fetch(`http://127.0.0.1:${address.port}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: requestText, conversationId: "conversation.production.owner.verified" })
    });
    const verified = await verifiedResponse.json() as Record<string, any>;
    expect(verifiedResponse.status, JSON.stringify(verified)).toBe(200);
    expect(verified.programReadiness).toMatchObject({ status: "ready", reasonId: "program.readiness.verified", artifactCount: expect.any(Number) });
    expect(verified.programReadiness.artifactIds).toHaveLength(verified.programReadiness.artifactCount);
    expect(verified.buildTest).toEqual(turnResults.at(-1)?.buildTest);
    expect(verified.programArtifacts).toEqual(turnResults.at(-1)?.buildTest?.artifacts);
    expect(Math.max(...verified.programArtifacts.map((artifact: { content: string }) => artifact.content.length))).toBeGreaterThan(500);
    expect(verified.programArtifacts).toEqual(expect.arrayContaining([expect.objectContaining({ path: "src/program.mjs", mediaType: "text/javascript", role: "source", contentHash: expect.any(String), content: expect.stringContaining("args[0] + args[0]") })]));

    const scaffoldResponse = await fetch(`http://127.0.0.1:${address.port}/api/turn?full=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "Write a TypeScript function clamp(value: number, minimum: number, maximum: number): number that returns value bounded by minimum and maximum.",
        conversationId: "conversation.production.owner.unbound"
      })
    });
    const scaffold = await scaffoldResponse.json() as Record<string, any>;
    expect(scaffoldResponse.status, JSON.stringify(scaffold)).toBe(422);
    expect(scaffold.detail).toMatchObject({
      schema: "scce.program.response_readiness.v1",
      status: "not_ready",
      reasonId: "program.readiness.behavior_contract_missing"
    });
  }, 60_000);

  it("carries creative preference through the API and reloads it after a cold kernel restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "scce-production-creative-api-"));
    roots.push(root);
    const executionRoot = await mkdtemp(join(tmpdir(), "scce-production-creative-exec-"));
    roots.push(executionRoot);
    const workspace: WorkspaceRecord = { id: "workspace.production.creative", rootPath: root, rootUri: `file://${root.replaceAll("\\", "/")}`, corpusId: "corpus.production.creative", status: "active", createdAt: 102_000, updatedAt: 102_000, metadata: {} };
    const events: ScceEvent[] = [];
    const dialogueMemory = createInMemoryDialogueMemoryStore();
    const source = creativeLanguageSource();
    const fixtureIds = createIdFactory({ clock: createClock({ fixedTime: 102_000, stepMs: 1 }), hasher: createHasher(), deterministicReplay: true });
    const profile = createLanguageAcquisitionEngine({ idFactory: fixtureIds }).acquire({ sourceVersionId: source.sourceVersionId, text: source.text, createdAt: 102_000 });
    const trainedLanguage = compileLanguageTrainingBatch({ runtime: createLanguageMemoryRuntime({ idFactory: fixtureIds, hasher: createHasher() }), hasher: createHasher(),
      batch: { streamId: "source:production-creative-language", sourceSystem: "gutenberg", profile, sourceVersionId: source.sourceVersionId, text: source.text, evidence: [source], createdAt: 102_000, maxOrder: 4, maxCountersPerOrder: 256 } });
    const compiled = createUniversalCreativeEventConstructionCompiler().compile({ profileId: profile.id, evidence: [source], hasher: createHasher(), updatedAt: 102_000 });
    if (compiled.status !== "compiled") throw new Error(`creative API fixture did not compile: ${JSON.stringify(compiled)}`);
    const bundle = hydrateLanguageConstructionPatterns({ patterns: [compiled.pattern], evidence: [source], hasher: createHasher() }).bundles[0];
    if (!bundle?.creativeEvents?.length) throw new Error("creative API fixture has no events");
    const requestText = "Invent two alternative indexing algorithms for this graph, each with a distinct structural approach.";
    const graphTextStart = requestText.indexOf("this graph");
    if (graphTextStart < 0) throw new Error("creative API fixture request lacks its annotated graph argument");
    const graphStart = [...requestText.slice(0, graphTextStart)].length;
    const graphEnd = graphStart + [..."this graph"].length;
    // Test-authored semantic teaching: these source operations act on the declared graph argument.
    const declaredOperations = new Set(["indexes", "partitions"]);
    const taughtEvents = bundle.creativeEvents.filter(event => declaredOperations.has(event.sourceLabel)
      && event.argumentFrame.bindings.some(port => port.roleId === "scce.role.patient" && port.surface === "graph"));
    expect(new Set(taughtEvents.map(event => event.sourceLabel))).toEqual(declaredOperations);
    const examples = taughtEvents.flatMap(event => ["train", "calibration", "calibration"].map(partition => ({ requestText, requestFrameId: "request.frame.indexing", requestCompilerId: "compiler.request.learned", eventCompilerId: event.compilerId, eventRelationId: event.relationId, eventArgumentFrameId: event.argumentFrame.id, partition: partition as "train" | "calibration", accepted: true, roleBindings: [{ requestRoleId: "scce.request.role.argument", eventRoleId: "scce.role.patient" as const, accepted: true, requestSpan: { charStart: graphStart, charEnd: graphEnd } }] })));
    const compatibility = compileCreativeEventCompatibilityCorpus({ corpus: { schema: "scce.creative_event_compatibility_corpus.v1", calibrationId: "calibration.creative.fixture", minimumAdmissiblePosterior: 0.72, minimumRolePosterior: 0.72, minimumTrainingSupport: 1, minimumCalibrationSupport: 1, examples }, profileId: profile.id, evidenceIds: [source.id], updatedAt: 102_000, makeId: value => `fixture:${createHasher().digestHex(JSON.stringify(value))}` });
    expect(trainedLanguage.constructionPatterns.length).toBeGreaterThan(0);
    const languagePatterns = [...new Map([...trainedLanguage.patterns, compiled.pattern, ...compatibility.patterns].map(pattern => [pattern.id, pattern])).values()];
    const storage = integrationStorage({ events, workspace, sources: [], constructionEvidence: [source], dialogueMemory, languageProfiles: [profile], languageModels: trainedLanguage.models, languagePatterns });
    const createContext = () => {
      const clock = createClock({ fixedTime: 102_000, stepMs: 1 });
      const kernel = createScceKernel({ storage, files: { streamPath: async function* () {} }, buildTest: { executeProgram: async () => { throw new Error("creative turn must not execute a program"); } }, approvals: { isApproved: () => true, observePending: () => undefined, policyPatch: () => ({ dryRunByDefault: false }) }, idFactory: createIdFactory({ clock, hasher: createHasher(), deterministicReplay: false }), clock, deterministicReplay: false, corpusRegistry: createCorpusRegistry([{ sourceSystem: "gutenberg" }]) });
      return { runtime: { storage: { ...storage, dialogueMemory }, kernel, approvals: { isApproved: () => true, requestApproval: () => undefined, snapshot: () => ({ operatorGrant: true, pending: [] }) } }, config: { server: { url: "http://127.0.0.1" }, runtime: { workspaceRoot: root, allowedRoots: [root], tempRoot: executionRoot, tools: { pnpm: "pnpm" } }, policy: { allowMutation: true } }, startupReadiness: { snapshot: () => ({ phase: "running", ok: true, complete: true }) } } as unknown as ApiContext;
    };
    let context = createContext();
    const server = createServer((request, response) => { void handleRequest(request, response, context); });
    servers.push(server);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("creative integration server has no TCP address");
    const request = { text: requestText, requestedAuthority: "creative", conversationId: "conversation.production.creative" };
    const firstResponse = await fetch(`http://127.0.0.1:${address.port}/api/turn?full=1`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
    const first = await firstResponse.json() as Record<string, any>;
    expect(firstResponse.status, JSON.stringify(first)).toBe(200);
    expect((first.answer as string).trim().length).toBeGreaterThan(0);
    expect(first.answer).toContain("this graph");
    for (const operation of declaredOperations) expect(first.answer).toContain(operation);
    const speech = events.filter(event => event.typeId === "MouthSpoken").at(-1)!.payload as Record<string, any>;
    expect(speech.evidenceRefs).toEqual([]);
    expect(speech.trace.selected.surfaceRealizationId).toMatch(/^candidate:generated:creative:realizer:/u);
    const speechAudit = speech.trace.selected.audit.candidateAudit ?? speech.trace.selected.audit;
    expect(speechAudit.source).toBe("mouth.selected_event_source_construction");
    expect(speechAudit.realizations.length).toBeGreaterThan(0);
    const sourceSpeech = hydrateLanguageConstructionPatterns({ patterns: trainedLanguage.constructionPatterns, evidence: [source], hasher: createHasher() }).bundles;
    for (const witness of speechAudit.realizations) {
      expect(bundle.creativeEvents.some(event => event.id === witness.eventId && declaredOperations.has(event.sourceLabel))).toBe(true);
      expect(sourceSpeech.some(bundle => bundle.constructions.some(construction => construction.id === witness.constructionId)
        && bundle.sourceExamples.some(example => example.id === witness.exampleId))).toBe(true);
    }
    const firstContinuation = first.creativeContinuation as { offered: Array<{ candidateId: string; structureId: string }>; selectedCandidateId: string } | undefined;
    expect(firstContinuation?.offered.length ?? 0).toBeGreaterThanOrEqual(2);
    const selectedFirst = firstContinuation?.offered.find(candidate => candidate.candidateId === firstContinuation.selectedCandidateId);
    const preferredAfterCorrection = firstContinuation?.offered.find(candidate => candidate.candidateId !== firstContinuation.selectedCandidateId);
    expect(selectedFirst).toBeDefined();
    expect(preferredAfterCorrection).toBeDefined();
    const outcomeResponse = await fetch(`http://127.0.0.1:${address.port}/api/turn/outcome`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: request.conversationId, turnId: first.episodeId, status: "corrected", correctionText: "Prefer the other structural continuation.", preferredCandidateId: preferredAfterCorrection!.candidateId }) });
    const outcome = await outcomeResponse.json() as Record<string, any>;
    expect(outcomeResponse.status, JSON.stringify(outcome)).toBe(200);
    expect((outcome.calibrationObservationIds as string[]).length).toBeGreaterThanOrEqual(2);
    context = createContext();
    const secondResponse = await fetch(`http://127.0.0.1:${address.port}/api/turn?full=1`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
    const second = await secondResponse.json() as Record<string, any>;
    expect(secondResponse.status, JSON.stringify(second)).toBe(200);
    expect((second.answer as string).trim().length).toBeGreaterThan(0);
    const secondContinuation = second.creativeContinuation as { offered: Array<{ candidateId: string; structureId: string }>; selectedCandidateId: string } | undefined;
    const selectedSecond = secondContinuation?.offered.find(candidate => candidate.candidateId === secondContinuation.selectedCandidateId);
    expect(selectedSecond?.candidateId).not.toBe(selectedFirst?.candidateId);
    expect(selectedSecond?.structureId).toBe(preferredAfterCorrection?.structureId);

    const freshResponse = await fetch(`http://127.0.0.1:${address.port}/api/turn?full=1`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, text: requestText.replace("this graph", "Qzeta matrix"), conversationId: "conversation.production.creative.fresh" }) });
    const fresh = await freshResponse.json() as Record<string, any>;
    expect(freshResponse.status, JSON.stringify(fresh)).toBe(200);
    expect(fresh.answer).toContain("Qzeta matrix");
    expect(fresh.answer).not.toContain("this graph");
    expect(source.text).not.toContain("Qzeta matrix");

    const speechPatternIds = new Set(trainedLanguage.constructionPatterns.map(pattern => pattern.id));
    languagePatterns.splice(0, languagePatterns.length, ...languagePatterns.filter(pattern => !speechPatternIds.has(pattern.id)));
    context = createContext();
    const missingSpeech = await fetch(`http://127.0.0.1:${address.port}/api/turn?full=1`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
    expect(missingSpeech.status, JSON.stringify(await missingSpeech.json())).toBe(422);
  }, 60_000);

  it.each([
    ["dolly-human-creative-pair.json", "room", "κάλυ月", true, false, false],
    ["oasst-human-russian-creative-pair.json", "Спанч", "Кварц", true, false, true],
    ["oasst-human-russian-creative-pair.json", "Спанч", "Кварц", false, false, true],
    ["dolly-human-creative-pair.json", "room", "κάλυ月", false, true, true],
    ["oasst-human-russian-creative-pair.json", "Спанч", "Кварц", false, true, true]
  ] as const)("loads ordinary human speech and enforces complete participant property provenance: %s (case %#)", async (fixtureName, sourceValue, heldoutValue, seedIdentity, annotated, freshRoleLicensed) => {
    const human = JSON.parse(await readFile(new URL(`../../../kernel/src/__tests__/fixtures/${fixtureName}`, import.meta.url), "utf8")) as {
      text: string; turns: NonNullable<Parameters<typeof compileLanguageTrainingBatch>[0]["batch"]["transcriptTurns"]>;
    };
    const root = await mkdtemp(join(tmpdir(), "scce-human-utterance-api-"));
    roots.push(root);
    const workspace: WorkspaceRecord = { id: "workspace.human.utterance", rootPath: root, rootUri: `file://${root.replaceAll("\\", "/")}`,
      corpusId: "corpus.human.utterance", status: "active", createdAt: 103_000, updatedAt: 103_000, metadata: {} };
    const clock = createClock({ fixedTime: 103_000, stepMs: 1 }), hasher = createHasher();
    const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
    const sourceVersionId = ids.sourceVersionId(human.text), contentHash = ids.contentHash(human.text);
    const source: EvidenceSpan = { id: ids.evidenceId({ sourceVersionId, byteStart: 0, byteEnd: Buffer.byteLength(human.text), spanHash: contentHash }),
      sourceId: ids.sourceId("dialogue", `fixture://human/${fixtureName}`), sourceVersionId,
      chunkId: ids.chunkId({ sourceVersionId, byteStart: 0, byteEnd: Buffer.byteLength(human.text), chunkHash: contentHash }), contentHash,
      mediaType: "text/plain", byteStart: 0, byteEnd: Buffer.byteLength(human.text), charStart: 0, charEnd: [...human.text].length,
      text: human.text, textPreview: human.text, languageHints: {}, scriptHints: {}, trustVector: {}, provenance: { sourceSystem: "dialogue" },
      features: [], status: "promoted", alpha: 1, observedAt: 103_000 };
    const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId, text: human.text, createdAt: 103_000 });
    const declaration = creativeReferenceTestAnnotation(fixtureName, human.text, hasher);
    const trained = compileLanguageTrainingBatch({ runtime: createLanguageMemoryRuntime({ hasher, idFactory: ids }), hasher,
      batch: { streamId: `fixture://human/${fixtureName}`, sourceSystem: "dialogue", profile, sourceVersionId, text: human.text,
        evidence: [source], transcriptTurns: human.turns, ...(annotated ? { sourceReferenceBindings: declaration } : {}),
        createdAt: 103_000, retainNgramObservations: false } });
    const languagePatterns = trained.patterns.map(pattern => ({ ...pattern,
      patternJson: { ...(pattern.patternJson as Record<string, unknown>), sourceSystem: "dialogue" } as LanguagePatternRecord["patternJson"] }));
    if (!annotated && freshRoleLicensed) {
      const state = createLanguageMemoryRuntime({ hasher }).hydrate({ models: [], patterns: languagePatterns, constructionEvidence: [source] });
      const role = state.creativeEventCompatibilityModels.flatMap(model => creativeSourceUtterances(model, profile.id, hasher))
        .flatMap(utterance => utterance.requestRoles.map(role => ({ role, surface: [...utterance.request.surface].slice(role.startCodePoint, role.endCodePoint).join("") })))
        .find(row => row.surface === sourceValue)?.role;
      expect(role?.surfaceAcquisition).toEqual({ recipe: "kernel.creative_source_surface_acquisition.v1", occurrenceCount: 6 });
    }
    const events: ScceEvent[] = [];
    const storage = integrationStorage({ events, workspace, sources: [], constructionEvidence: [source], languageProfiles: [profile],
      languageModels: trained.models, languagePatterns });
    let identities: LanguageIdentityRecord[] = [];
    const assignments = new Map<string, string>();
    storage.languageIdentities = {
      putIdentities: async rows => { identities = [...rows]; }, replaceIdentities: async rows => { identities = [...rows]; },
      listIdentities: async () => identities,
      assignProfileLanguages: async rows => { for (const row of rows) assignments.set(row.profileId, row.languageId); },
      listProfileLanguages: async () => [...assignments].map(([profileId, languageId]) => ({ profileId, languageId })),
      listProfileSignatures: async query => profile.id > (query.afterId ?? "") ? [{ id: profile.id, sourceVersionId, sourceSystem: "dialogue",
        sourceUri: `fixture://human/${fixtureName}`, scripts: profile.scripts, direction: profile.direction,
        topContinuation: (profile.kneserNey as { topContinuation: Array<[string, number]> }).topContinuation }] : []
    };
    const queries: Array<Parameters<ScceStorage["languageMemory"]["listLanguagePatterns"]>[0]> = [];
    storage.languageMemory.listLanguagePatterns = async query => {
      queries.push(query);
      return languagePatterns.filter(pattern => {
        const value = pattern.patternJson as Record<string, unknown>;
        return (!query?.sourceSystem || query.sourceSystem === value.sourceSystem)
          && (!query?.profileId || query.profileId === pattern.profileId)
          && (!query?.profileIds || query.profileIds.includes(pattern.profileId))
          && (!query?.patternSchemas || query.patternSchemas.includes(String(value.schema)))
          && (!query?.patternIds || query.patternIds.includes(pattern.id));
      }).slice(0, query?.limit);
    };
    storage.languageMemory.listNgramModels = async query => trained.models.filter(model => !query?.sourceSystem
      || (model.modelJson as Record<string, unknown>).sourceSystem === query.sourceSystem);
    const createContext = async () => {
      const kernelClock = createClock({ fixedTime: 103_000, stepMs: 1 });
      const kernel = createScceKernel({ storage, files: { streamPath: async function* () {} },
        buildTest: { executeProgram: async () => { throw new Error("human creative turn must not execute a program"); } },
        idFactory: createIdFactory({ clock: kernelClock, hasher, deterministicReplay: false }), clock: kernelClock,
        deterministicReplay: false, corpusRegistry: createCorpusRegistry([{ sourceSystem: "dialogue" }, { sourceSystem: "gutenberg" }]) });
      if (seedIdentity) await kernel.languageIdentities();
      return { runtime: { storage, kernel, approvals: { isApproved: () => true, requestApproval: () => undefined, snapshot: () => ({ operatorGrant: false, pending: [] }) } },
        config: { server: { url: "http://127.0.0.1" }, runtime: { workspaceRoot: root, allowedRoots: [root], tempRoot: root, tools: { pnpm: "pnpm" } }, policy: { allowMutation: false } },
        startupReadiness: { snapshot: () => ({ phase: "running", ok: true, complete: true }) } } as unknown as ApiContext;
    };
    let context = await createContext();
    const server = createServer((request, response) => { void handleRequest(request, response, context); });
    servers.push(server);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("human utterance API has no address");
    for (const [index, text] of [human.turns[0]!.surface, human.turns[0]!.surface.replace(sourceValue, heldoutValue)].entries()) {
      context = await createContext();
      const response = await fetch(`http://127.0.0.1:${address.port}/api/turn?full=1`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, conversationId: `conversation.human.utterance.${index}` }) });
      const body = await response.json() as Record<string, any>;
      if (index === 1 && !freshRoleLicensed) { expect(response.status, JSON.stringify(body)).toBe(422); continue; }
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(body.answer).not.toBe(text);
      if (index === 1) {
        const expected = replyWithReviewedProperty({ declaration, reply: human.turns[1]!.surface, replyStart: human.turns[1]!.startCodePoint, value: heldoutValue });
        expect(body.answer.replace(/\s+/gu, " ")).toBe(expected.replace(/\s+/gu, " "));
        expect(body.answer.split(heldoutValue)).toHaveLength(fixtureName.startsWith("dolly") ? 3 : 7);
        if (fixtureName.startsWith("dolly")) { expect(body.answer).toContain("laundry room"); expect(body.answer).toContain("bedroom"); }
        else expect(body.answer).not.toContain(sourceValue);
      }
      else expect(body.answer.replace(/\s+/gu, " ")).toBe(human.turns[1]!.surface.replace(/\s+/gu, " "));
    }
    if (seedIdentity) expect(queries.some(query => query?.sourceSystem && corpusSourceAlias(query.sourceSystem) === "gutenberg")).toBe(true);
    context = await createContext();
    const lowercase = await fetch(`http://127.0.0.1:${address.port}/api/turn?full=1`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: human.turns[0]!.surface.toLocaleLowerCase(), conversationId: "conversation.human.utterance.lowercase" }) });
    const lowercaseBody = await lowercase.json() as { answer: string };
    expect(lowercase.status, JSON.stringify(lowercaseBody)).toBe(200);
    expect(lowercaseBody.answer.replace(/\s+/gu, " ")).toBe(human.turns[1]!.surface.replace(/\s+/gu, " "));
    const sourceReads = queries.filter(query => query?.patternIds?.length);
    expect(sourceReads.length).toBeGreaterThan(0);
    expect(sourceReads.every(query => query?.sourceSystem === undefined && query?.profileIds === undefined)).toBe(true);
    const arithmetic = await fetch(`http://127.0.0.1:${address.port}/api/turn?full=1`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "7 - 10", conversationId: "conversation.human.utterance.arithmetic" }) });
    expect(arithmetic.status).toBe(200);
    expect((await arithmetic.json() as { answer: string }).answer).toBe("7 - 10 = -3.");
    if (annotated) {
      const referencePatterns = languagePatterns.filter(pattern => (pattern.patternJson as Record<string, unknown>).schema === "scce.source_reference_bindings.v1");
      expect(referencePatterns).toHaveLength(1);
      expect(queries.some(query => query?.patternIds?.includes(referencePatterns[0]!.id))).toBe(true);
      languagePatterns.splice(0, languagePatterns.length, ...languagePatterns.filter(pattern => !referencePatterns.includes(pattern)));
      context = await createContext();
      const revoked = await fetch(`http://127.0.0.1:${address.port}/api/turn?full=1`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: human.turns[0]!.surface.replace(sourceValue, heldoutValue), conversationId: "conversation.human.utterance.revoked" }) });
      expect(revoked.status, JSON.stringify(await revoked.json())).toBe(422);
      languagePatterns.push(...referencePatterns);
    }
    languagePatterns.splice(0, languagePatterns.length, ...languagePatterns.filter(pattern =>
      !String(((pattern.patternJson as Record<string, any>).bundle ?? {}).bindingId ?? "").startsWith("source.creative.utterance.")));
    context = await createContext();
    const missing = await fetch(`http://127.0.0.1:${address.port}/api/turn?full=1`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: human.turns[0]!.surface, conversationId: "conversation.human.utterance.missing" }) });
    expect(missing.status, JSON.stringify(await missing.json())).toBe(422);
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

function creativeLanguageSource(): EvidenceSpan {
  const text = "method indexes graph. routine indexes graph. method indexes bucket. routine indexes bucket. method partitions graph. routine partitions graph. method partitions bucket. routine partitions bucket.";
  return { id: "evidence:production-creative-language", sourceId: "source:production-creative-language", sourceVersionId: "source:production-creative-language:v1", chunkId: "chunk:production-creative-language", contentHash: "hash:production-creative-language", mediaType: "text/plain", byteStart: 0, byteEnd: Buffer.byteLength(text), charStart: 0, charEnd: text.length, text, textPreview: text, languageHints: {}, scriptHints: {}, trustVector: {}, provenance: {}, features: [], status: "promoted", alpha: 0.9, observedAt: 102_000 } as unknown as EvidenceSpan;
}

function integrationStorage(input: {
  events: ScceEvent[];
  workspace: WorkspaceRecord;
  sources: WorkspaceSourceFileRecord[];
  dialogueMemory?: ReturnType<typeof createInMemoryDialogueMemoryStore>;
  languageProfiles?: LanguageProfile[];
  languageModels?: NgramModelRecord[];
  languagePatterns?: LanguagePatternRecord[];
  constructionEvidence?: EvidenceSpan[];
}): ScceStorage {
  const dialogueMemory = input.dialogueMemory ?? createInMemoryDialogueMemoryStore();
  const graph = { bounded: true, query: {}, nodes: [], edges: [], hyperedges: [] } as any;
  const emptyStore = new Proxy({}, { get: () => async () => undefined });
  const storage = {
    transaction: async <T>(operation: () => Promise<T>): Promise<T> => operation(),
    events: {
      append: async (event: ScceEvent) => { input.events.push(event); },
      appendBatch: async (events: ScceEvent[]) => { input.events.push(...events); },
      readEpisode: async (episodeId: string) => input.events.filter(event => String(event.episodeId) === episodeId),
      readRange: async (query?: { typeId?: string }) => input.events.filter(event => !query?.typeId || event.typeId === query.typeId),
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
      getEvidence: async (id: string) => input.constructionEvidence?.find(evidence => String(evidence.id) === id) ?? null,
      getEvidenceBatch: async (ids: string[]) => (input.constructionEvidence ?? []).filter(evidence => ids.includes(String(evidence.id))),
      searchEvidence: async () => [], sourceVersionsForEvidence: async () => []
    },
    quarantine: { put: async () => undefined, get: async () => null, listPending: async () => [], markDecision: async () => undefined },
    model: { readModel: async () => ({ languageProfiles: input.languageProfiles ?? [], latentConcepts: [], learnedProgramPatterns: [], learningGoals: [], trainingSteps: 0 }), writeModel: async () => undefined, putLanguageProfile: async () => undefined, listLanguageProfiles: async () => input.languageProfiles ?? [] },
    languageMemory: { putNgramObservation: async () => undefined, putNgramObservationsBatch: async () => undefined, putNgramModel: async () => undefined, putLanguageUnit: async () => undefined, putLanguagePattern: async () => undefined, putSemanticFrame: async () => undefined, putTranslationAlignment: async () => undefined, listNgramModels: async () => input.languageModels ?? [], listNgramObservations: async () => [], listLanguageUnits: async () => [], listLanguagePatterns: async () => input.languagePatterns ?? [], listSemanticFrames: async () => [], listTranslationAlignments: async () => [] },
    stats: async () => ({ tables: [] }), init: async () => undefined, migrate: async () => undefined, verify: async () => ({ ok: true, tables: [], errors: [] }), close: async () => undefined,
    blobs: emptyStore, ingestion: emptyStore, proofs: emptyStore, constructs: emptyStore, capabilities: emptyStore, forecasts: { putState: async () => undefined, putForecast: async () => undefined, getSeries: async () => [] }, benchmarks: emptyStore, brainImports: { active: async () => ({ activeImportRunIds: [] }), summarize: async () => ({ activeImportRunIds: [], importedLanguagePriorCount: 0, importedGraphPriorCount: 0, importedDirectEvidenceCount: 0, profileExcerptEvidenceCount: 0, importedLearnedPriorCount: 0, importedProgramPriorCount: 0, unknownPriorCount: 0, runs: [] }) }, corrections: { putRule: async () => undefined, listRules: async () => [] }, dialogueMemory,
    userModelClaims: { putClaim: async () => undefined, listClaims: async () => [] }, taskResumption: { putSnapshot: async () => undefined, getLatestSnapshot: async () => null }, documentGeneration: { putSession: async () => undefined, getSession: async () => null, compareAndPutSession: async () => ({ stored: true, currentUpdatedAt: 0 }) }, localization: emptyStore, flowCache: emptyStore, selfRewrite: emptyStore,
    workspace: { latestWorkspace: async () => input.workspace, listSourceFiles: async () => input.sources, putWorkspace: async () => undefined, putReport: async () => undefined }
  };
  return storage as unknown as ScceStorage;
}
