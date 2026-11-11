// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { BrainLifecycleRecord, BrainLifecycleState, ScceStorage } from "@scce/kernel";
import type { LanguageCorpusTrainingReport } from "../language-corpus-trainer.js";

vi.mock("@scce/kernel", async importOriginal => {
  const { CORPUS_SOURCE_SYSTEM_IDS } = await importOriginal<typeof import("@scce/kernel")>();
  const digestHex = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
  return {
    CORPUS_SOURCE_SYSTEM_IDS,
    canonicalStringify: (value: unknown) => JSON.stringify(value),
    createHasher: () => ({ digestHex }),
    compileBrainReplayManifest: (input: { sourceSchema: string; sourceManifestHash: string; componentIds: string[]; content: unknown; configuration?: unknown }) => {
      const canonicalBytes = JSON.stringify({ schema: "scce.brain_replay_manifest.v1", ...input, componentIds: [...new Set(input.componentIds)].sort() });
      const byteHash = digestHex(canonicalBytes);
      return { schema: "scce.brain_replay_manifest.v1", id: `brain_replay.${byteHash.slice(0, 48)}`, byteHash, canonicalBytes, componentIds: [...new Set(input.componentIds)].sort() };
    },
    createLanguageIdentityRuntime: (options: { informationLabel?: { tenantId: string } }) => {
      if (options.informationLabel?.tenantId !== "tenant.owner") throw new Error("identity discovery lost its durable information label");
      return { ensure: async (input: { initializeIfMissing?: boolean; rebuild?: boolean }) => {
        if (!input.initializeIfMissing && !input.rebuild) throw new Error("initial brain identity discovery requires explicit maintenance");
        return { assigned: 1, identities: [], discovered: false, readiness: "ready", elapsedMs: 0 };
      } };
    },
    toJsonValue: (value: unknown) => value,
    validateBrainManifestContract: () => [],
    validationDisposition: (checks: Array<{ passed: boolean; severity: string }>) => checks.some(check => !check.passed && check.severity === "error") ? "FAILED" : "PASSED"
  };
});

import { completeInitialSourceBrainBuild, completeInitialSourceBrainFromDialogueReport, completeInitialSourceBrainFromStoredReports, validateStoredSourceBrainPlan, type DialogueSourceBrainReport } from "../source-brain-build.js";

const CONTENT_BYTES = new Uint8Array(64).fill(97);
const CONTENT_HASH = `sha256_${createHash("sha256").update(CONTENT_BYTES).digest("hex")}`;

describe("initial source brain completion", () => {
  it("activates a completed dialogue selection through the same persisted-artifact validation", async () => {
    const fixture = createFixture(), input = buildInput(fixture.storage);
    const result = await completeInitialSourceBrainFromDialogueReport({ storage: fixture.storage,
      informationLabel: input.informationLabel, report: dialogueReport(), now: 100 });
    expect("lifecycle" in result && result.lifecycle.state).toBe("ACTIVE");
    expect("report" in result && result.report.checks.every(check => check.passed)).toBe(true);
    expect(fixture.activationCalls).toBe(1);
  });

  it.each(["missing-selection", "incomplete", "duplicate", "skipped", "foreign-corpus"])("refuses %s dialogue completion before activation", async kind => {
    const fixture = createFixture(), input = buildInput(fixture.storage), value = dialogueReport();
    if (kind === "missing-selection") delete value.selection;
    if (kind === "incomplete") value.selection!.languageTrainingComplete = false;
    if (kind === "duplicate") value.selection!.completedSourceUris.push(value.selection!.completedSourceUris[0]!);
    if (kind === "skipped") value.filesSkipped.push({ path: "missing.txt", reason: "training_failed: unavailable" });
    if (kind === "foreign-corpus") value.reports[0]!.sourceSystemId = "foreign";
    await expect(completeInitialSourceBrainFromDialogueReport({ storage: fixture.storage,
      informationLabel: input.informationLabel, report: value })).rejects.toThrow("complete explicit human-authored");
    expect(fixture.activationCalls).toBe(0);
    expect(fixture.lifecycle).toBeUndefined();
  });

  it("validates persisted evidence, language models and identity before activation; retries idempotently", async () => {
    const fixture = createFixture();
    const result = await completeInitialSourceBrainBuild(buildInput(fixture.storage));
    expect(result.active).toBe(true);
    expect(result.lifecycle.state).toBe("ACTIVE");
    expect(result.report.disposition).toBe("PASSED");
    const manifestText = JSON.stringify(result.lifecycle.manifest.metadata);
    expect(manifestText).not.toContain("postgres://private");
    expect(manifestText).not.toContain("private-token-value");
    expect(manifestText).toContain("maxFilesPerRun");
    expect(result.lifecycle.manifest.replayManifest?.componentIds).toEqual(expect.arrayContaining([
      "sv-one", "profile-one", "evidence-one", "model-one"
    ]));
    expect(fixture.activationCalls).toBe(1);

    const retry = await completeInitialSourceBrainBuild(buildInput(fixture.storage));
    expect(retry.active).toBe(true);
    expect(retry.idempotent).toBe(true);
    expect(fixture.activationCalls).toBe(1);
  });

  it("leaves a READY candidate unactivated when a competing brain wins the atomic empty-active guard", async () => {
    const fixture = createFixture({ competingBrainWinsAtActivation: true });
    const result = await completeInitialSourceBrainBuild(buildInput(fixture.storage));
    expect(result.lifecycle.state).toBe("READY");
    expect(result.active).toBe(false);
    expect(fixture.activationCalls).toBe(1);
    expect((await fixture.storage.brainImports.active()).activeImportRunIds).toEqual(["other-run"]);
  });

  it("refuses an incomplete selection before registering or activating a lifecycle", async () => {
    const fixture = createFixture();
    await expect(completeInitialSourceBrainBuild({
      ...buildInput(fixture.storage),
      completion: { explicitSelection: true, selectedItemIds: ["sv-one"], completedItemIds: [], stoppedByHeapSafetyBound: true, interrupted: false, skippedRequiredItemIds: ["sv-one"] }
    })).rejects.toThrow("incomplete, skipped, stopped, or implicit selection");
    expect(fixture.lifecycle).toBeUndefined();
    expect(fixture.activationCalls).toBe(0);
  });

  it("refuses to replace a currently active brain", async () => {
    const fixture = createFixture({ activeAtStart: true });
    await expect(completeInitialSourceBrainBuild(buildInput(fixture.storage)))
      .rejects.toThrow("refuses to replace an existing active brain");
    expect(fixture.activationCalls).toBe(0);
  });
  it("validates more than 512 selected owners in exact-ID metadata work pages without reading model bodies", async () => {
    const f = await canonicalFixture(1025), input = buildInput(f.storage);
    const result = await completeInitialSourceBrainBuild({ ...input, selectedItems: f.selected, reports: f.reports,
      completion: { ...input.completion, selectedItemIds: f.selected.map(row => row.sourceVersionId), completedItemIds: f.selected.map(row => row.sourceVersionId) } });
    expect(result.active).toBe(true); expect(result.report.checks.every(check => check.passed)).toBe(true);
    expect(f.pages.profiles.map(page => page.length)).toEqual([512, 512, 1]);
    expect(f.pages.models.map(page => page.length)).toEqual([512, 512, 1]);
    expect(f.pages.evidence.every(page => page.length <= 512)).toBe(true);
    expect(f.bodyReads).toBe(0);
  });

  it("validates the actual derived replay parent and records it without fabricating original report bytes", async () => {
    const f = await canonicalFixture(2), child = f.versions[0]!, parent = f.versions[1]!;
    child.role = "evidence-derivative"; child.derivation = { kind: "extracted-text", transformId: "owned-extraction", derivedFromSourceVersionId: parent.sourceVersionId,
      originalCoordinateSpace: "source-bytes", redactionMap: [] };
    const input = buildInput(f.storage);
    const result = await completeInitialSourceBrainBuild({ ...input, selectedItems: [f.selected[0]!], reports: [f.reports[0]!],
      completion: { ...input.completion, selectedItemIds: [String(child.sourceVersionId)], completedItemIds: [String(child.sourceVersionId)] } });
    expect(result.active).toBe(true); expect(f.reports[0]!.originalSourceVersionId).toBe(String(child.sourceVersionId));
    expect(result.lifecycle.manifest.replayManifest?.componentIds).toContain(String(parent.sourceVersionId));
    expect(JSON.stringify(result.lifecycle.manifest.metadata)).toContain(String(parent.contentHash));
    f.spans[0]!.status = "quarantined";
    await expect(completeInitialSourceBrainBuild({ ...input, selectedItems: [f.selected[0]!], reports: [f.reports[0]!],
      completion: { ...input.completion, selectedItemIds: [String(child.sourceVersionId)], completedItemIds: [String(child.sourceVersionId)] } }))
      .rejects.toThrow("no longer satisfies");
    expect(f.activationCalls).toBe(1);
  });

  it("requires a real derivation whenever a report declares a different original owner", async () => {
    const f = await canonicalFixture(2), original = buildInput(f.storage), parent = f.versions[1]!;
    const projected = { ...f.reports[0]!, originalSourceVersionId: String(parent.sourceVersionId), sourceContentHash: String(parent.contentHash), sourceByteLength: parent.byteLength };
    const input = { ...original, reports: [projected], selectedItems: [f.selected[1]!], completion: { ...original.completion,
      selectedItemIds: [String(parent.sourceVersionId)], completedItemIds: [String(parent.sourceVersionId)] } };
    const rejected = await completeInitialSourceBrainBuild(input);
    expect(rejected.active).toBe(false); expect(rejected.report.checks.find(row => row.id === "source.evidence_persisted")?.passed).toBe(false);
    expect(f.activationCalls).toBe(0);

  });

  it("revalidates a normally produced READY lifecycle before activation and preserves a valid retry", async () => {
    const f = await canonicalFixture(1), original = buildInput(f.storage);
    const input = { ...original, selectedItems: f.selected, reports: f.reports,
      completion: { ...original.completion, selectedItemIds: [f.selected[0]!.sourceVersionId], completedItemIds: [f.selected[0]!.sourceVersionId] } };
    const ready = await completeInitialSourceBrainBuild({ ...input, activate: false });
    expect(ready.lifecycle.state).toBe("READY"); expect(ready.report.disposition).toBe("PASSED"); expect(f.activationCalls).toBe(0);
    f.spans[0]!.status = "quarantined";
    await expect(completeInitialSourceBrainBuild(input)).rejects.toThrow("ready source brain no longer satisfies canonical source/artifact validation");
    expect((await f.storage.brainImports.active()).activeImportRunIds).toEqual([]);
    expect((await f.storage.brainImports.getLifecycle(ready.lifecycle.importRunId))?.state).toBe("READY"); expect(f.activationCalls).toBe(0);
    f.spans[0]!.status = "promoted";
    const active = await completeInitialSourceBrainBuild(input);
    expect(active.lifecycle.importRunId).toBe(ready.lifecycle.importRunId); expect(active.lifecycle.state).toBe("ACTIVE"); expect(f.activationCalls).toBe(1);
  });

  it.each(["missing-parent", "bad-parent-bytes", "wrong-evidence-owner", "wrong-profile-owner", "wrong-model-owner"])("refuses %s during canonical completion", async failure => {
    const f = await canonicalFixture(2), input = buildInput(f.storage), child = f.versions[0]!, parent = f.versions[1]!;
    child.role = "evidence-derivative"; child.derivation = { kind: "extracted-text", transformId: "owned", derivedFromSourceVersionId: parent.sourceVersionId,
      originalCoordinateSpace: "source-bytes", redactionMap: [] };
    if (failure === "missing-parent") f.versions.pop();
    if (failure === "bad-parent-bytes") f.blobs.set(String(parent.contentHash), new Uint8Array([1]));
    if (failure === "wrong-evidence-owner") f.spans[0]!.sourceId = parent.sourceId;
    if (failure === "wrong-profile-owner") f.profiles[0]!.sourceVersionId = parent.sourceVersionId;
    if (failure === "wrong-model-owner") f.models[0]!.profileId = f.profiles[1]!.id;
    const result = await completeInitialSourceBrainBuild({ ...input, selectedItems: [f.selected[0]!], reports: [f.reports[0]!],
      completion: { ...input.completion, selectedItemIds: [String(child.sourceVersionId)], completedItemIds: [String(child.sourceVersionId)] } });
    expect(result.active).toBe(false); expect(result.lifecycle.state).toBe("FAILED"); expect(f.activationCalls).toBe(0);
  });

  it("finalizes all planned stored and human file owners together; no report subset qualifies the cohort", async () => {
    const f = await canonicalFixture(2), input = buildInput(f.storage), fileHash = "c".repeat(64);
    f.versions[1]!.metadata = { sourceHash: fileHash, authorship: "human_authored" };
    f.reports[1]!.sourceSystem = "dialogue"; f.reports[1]!.sourceSystemId = "source.dialogue"; f.reports[1]!.streamUri = "source.dialogue:human.json";
    const plan = validateStoredSourceBrainPlan({ schema: "scce.storedSourceBrainPlan.v1", sourceId: "combined", rootPath: "C:/cohort",
      selectedItems: f.selected.map((row, index) => ({ ...row, canonicalUri: f.versions[index]!.canonicalUri, ...(index ? { sourceFileHash: fileHash } : {}) })),
      reportFiles: [{ path: "wiki.json", sha256: "a".repeat(64) }, { path: "dialogue.json", sha256: "b".repeat(64) }] }, true);
    const stored = { schema: "scce.storedCorpusConstructionTrainReport.v1", reports: [f.reports[0]], exhausted: true, startBatchIndex: 0, startSourceVersionId: null,
      stoppedByHeapSafetyBound: false, stoppedByStorageFailure: false, stoppedByInterruption: false, batchesFailed: [], sourcesSkipped: [],
      selection: { schema: "scce.storedCorpusSourceSelection.v1", selectedSourceVersionIds: [f.reports[0]!.sourceVersionId], completedSourceVersionIds: [f.reports[0]!.sourceVersionId], languageTrainingComplete: true } };
    const dialogue = { ...dialogueReport(), schema: "scce.dialogueCorpusTrainReport.v1", reports: [f.reports[1]], selection: { selectedSourceUris: [f.versions[1]!.canonicalUri], completedSourceUris: [f.versions[1]!.canonicalUri], languageTrainingComplete: true } };
    await expect(completeInitialSourceBrainFromStoredReports({ storage: f.storage, informationLabel: input.informationLabel, plan, reports: [stored], sourceManifestHash: input.sourceManifestHash })).rejects.toThrow("every planned report");
    expect(f.activationCalls).toBe(0);
    const result = await completeInitialSourceBrainFromStoredReports({ storage: f.storage, informationLabel: input.informationLabel, plan, reports: [stored, dialogue], sourceManifestHash: input.sourceManifestHash });
    expect(result.active).toBe(true); expect(result.lifecycle.manifest.content.languageShardCount).toBe(2); expect(f.activationCalls).toBe(1);
    expect((await completeInitialSourceBrainFromStoredReports({ storage: f.storage, informationLabel: input.informationLabel, plan, reports: [stored, dialogue], sourceManifestHash: input.sourceManifestHash })).idempotent).toBe(true);
  });

  it.each(["heap", "interrupted", "storage-failure", "cursor", "skip", "missing-artifact"])("never activates a %s stored report even if its completion flag is forged", async failure => {
    const f = await canonicalFixture(1), input = buildInput(f.storage);
    const plan = validateStoredSourceBrainPlan({ schema: "scce.storedSourceBrainPlan.v1", sourceId: "cohort", rootPath: "root",
      selectedItems: [{ ...f.selected[0]!, canonicalUri: f.versions[0]!.canonicalUri }], reportFiles: [{ path: "report.json", sha256: "c".repeat(64) }] }, true);
    const stored = { schema: "scce.storedCorpusConstructionTrainReport.v1", reports: [f.reports[0]!], exhausted: true, startBatchIndex: 0, startSourceVersionId: null as string | null,
      stoppedByHeapSafetyBound: false, stoppedByStorageFailure: false, stoppedByInterruption: false, batchesFailed: [], sourcesSkipped: [] as { sourceVersionId: string; reason: string }[],
      selection: { schema: "scce.storedCorpusSourceSelection.v1", selectedSourceVersionIds: [f.reports[0]!.sourceVersionId], completedSourceVersionIds: [f.reports[0]!.sourceVersionId], languageTrainingComplete: true } };
    if (failure === "heap") stored.stoppedByHeapSafetyBound = true;
    if (failure === "interrupted") stored.stoppedByInterruption = true;
    if (failure === "storage-failure") stored.stoppedByStorageFailure = true;
    if (failure === "cursor") stored.startSourceVersionId = "previous-source";
    if (failure === "skip") stored.sourcesSkipped.push({ sourceVersionId: f.reports[0]!.sourceVersionId, reason: "unavailable" });
    if (failure === "missing-artifact") f.models.length = 0;
    if (failure === "missing-artifact") {
      const result = await completeInitialSourceBrainFromStoredReports({ storage: f.storage, informationLabel: input.informationLabel, plan, reports: [stored], sourceManifestHash: input.sourceManifestHash });
      expect(result.active).toBe(false); expect(result.report.disposition).toBe("FAILED");
    } else await expect(completeInitialSourceBrainFromStoredReports({ storage: f.storage, informationLabel: input.informationLabel, plan, reports: [stored], sourceManifestHash: input.sourceManifestHash })).rejects.toThrow("complete stored-source");
    expect(f.activationCalls).toBe(0);
  });

  it.each(["empty", "duplicate-owner", "duplicate-file", "duplicate-report", "missing-hash"])("rejects %s manifest before lifecycle writes", kind => {
    const item = { sourceVersionId: "owner", canonicalUri: "fixture://owner", contentHash: CONTENT_HASH, byteLength: 64 };
    const plan = { schema: "scce.storedSourceBrainPlan.v1", sourceId: "cohort", rootPath: "root", selectedItems: [item], reportFiles: [{ path: "report.json", sha256: "c".repeat(64) }] };
    if (kind === "empty") plan.selectedItems = [];
    if (kind === "duplicate-owner") plan.selectedItems.push({ ...item, canonicalUri: "fixture://other" });
    if (kind === "duplicate-file") plan.selectedItems.push({ ...item, sourceVersionId: "other" });
    if (kind === "duplicate-report") plan.reportFiles.push({ ...plan.reportFiles[0]! });
    if (kind === "missing-hash") plan.reportFiles[0]!.sha256 = "";
    expect(() => validateStoredSourceBrainPlan(plan, true)).toThrow();
  });

});

function buildInput(storage: ScceStorage) {
  return {
    storage,
    informationLabel: { tenantId: "tenant.owner", principals: ["owner"], compartments: [], exportClass: "restricted" as const, mergePolicy: "isolated" as const },
    sourceId: "owner-source",
    sourceSchema: "scce.owner.source.v1",
    rootPath: "C:/source/one-document",
    sourceManifestHash: "b".repeat(64),
    selectedItems: [{ sourceId: "source-one", sourceVersionId: "sv-one", contentHash: CONTENT_HASH, byteLength: 64 }],
    reports: [report()] as LanguageCorpusTrainingReport[],
    completion: { explicitSelection: true, selectedItemIds: ["sv-one"], completedItemIds: ["sv-one"], stoppedByHeapSafetyBound: false, interrupted: false, skippedRequiredItemIds: [] },
    configuration: { maxFilesPerRun: 1, databaseUrl: "postgres://private/password", apiToken: "private-token-value" },
    now: 100
  };
}

function report(): LanguageCorpusTrainingReport {
  return {
    schema: "scce.languageCorpusTrainingReport.v1",
    sourceSystem: "oss_docs", sourceSystemId: "oss_docs", streamUri: "oss_docs:README.md", originalSourceVersionId: "sv-one", sourceVersionId: "sv-one",
    artifacts: { languageProfileId: "profile-one", evidenceIds: ["evidence-one"], ngramModelIds: ["model-one"] },
    sourceContentHash: CONTENT_HASH, sourceByteLength: 64,
    languageProfiles: 1, evidence: 1, ngramObservations: 2, ngramModels: 1, languageUnits: 1, languagePatterns: 0,
    semanticFrames: 0, admission: { disposition: "unmeasured", reasons: [] }, alignmentPromotionObservations: [],
    alignmentCalibrationObservations: [], constructionCandidates: 0, languageConstructions: 0, graphSurfaceAlignments: 0,
    constructionObservationReceipt: { schema: "scce.language_training.construction_observation_receipt.v1", compilerRecipe: "kernel.language_training_batch.v8",
      profileId: "profile-one", sourceVersionId: "sv-one", sourceTextHash: "0".repeat(64), sourceEvidenceCount: 0, sourceEvidenceIds: [],
      sourceEvidenceIdsTruncated: false, sourceEvidenceDigest: "1".repeat(64), qualificationEvidenceCount: 0,
      qualificationEvidenceDigest: "2".repeat(64), candidateCount: 0, observationCount: 0,
      observationDigestRecipe: "sha256.canonical_observation_digests.v1", observationDigest: "3".repeat(64), recomputationIdentity: "4".repeat(64) },
    rejectedLanguageConstructions: 0, eventId: "event-one", warnings: []
  };
}

function dialogueReport(): DialogueSourceBrainReport {
  return { rootPath: "C:/source/dialogue", sourceSystem: "source.dialogue" as DialogueSourceBrainReport["sourceSystem"],
    authorship: "human_authored", startFileIndex: 0, filesTrained: 1, filesSkipped: [],
    reports: [{ ...report(), sourceSystem: "dialogue", sourceSystemId: "source.dialogue" }],
    stoppedByHeapSafetyBound: false,
    selection: { selectedSourceUris: ["file:///C:/source/dialogue/session.txt"], completedSourceUris: ["file:///C:/source/dialogue/session.txt"], languageTrainingComplete: true } };
}

function createFixture(options: { activeAtStart?: boolean; competingBrainWinsAtActivation?: boolean } = {}) {
  let lifecycle: BrainLifecycleRecord | undefined;
  const ledger = new Map<string, unknown>();
  let activeImportRunIds = options.activeAtStart ? ["other-run"] : [];
  let activeBrainVersion = options.activeAtStart ? "other-brain" : undefined;
  let activationCalls = 0;
  const identity = {
    schema: "scce.language_identity.v2", id: "identity-one", script: "script:Latin", directions: [], closedClass: [],
    families: [{ family: "files", count: 1 }], corpusRoles: [], profileCount: 1, membershipCut: 0, createdAt: 1
  };
  const storage = {
    brainImports: {
      async active() { return { activeBrainVersion, activeImportRunIds: [...activeImportRunIds] }; },
      async getLifecycle() { return lifecycle ?? null; },
      async putLifecycle(record: BrainLifecycleRecord) { lifecycle = { ...record }; },
      async transitionLifecycle(input: { importRunId: string; expectedState: BrainLifecycleState; toState: BrainLifecycleState; updatedAt: number; validation?: BrainLifecycleRecord["validation"] }) {
        if (!lifecycle || lifecycle.state !== input.expectedState) throw new Error("CAS mismatch");
        lifecycle = { ...lifecycle, state: input.toState, revision: lifecycle.revision + 1, updatedAt: input.updatedAt, ...(input.validation ? { validation: input.validation } : {}) };
        return lifecycle;
      },
      async putLedger(row: { id: string }) { ledger.set(row.id, row); },
      async activateReady(input: { importRunId: string; brainVersion: string; updatedAt: number; requireNoActive?: boolean }) {
        activationCalls += 1;
        if (options.competingBrainWinsAtActivation) {
          activeImportRunIds = ["other-run"];
          activeBrainVersion = "other-brain";
        }
        if (input.requireNoActive && (activeImportRunIds.length || activeBrainVersion)) throw new Error("brain activation requires no existing active brain");
        if (!lifecycle || lifecycle.state !== "READY") throw new Error("requires READY");
        lifecycle = { ...lifecycle, state: "ACTIVE", revision: lifecycle.revision + 1, updatedAt: input.updatedAt };
        activeImportRunIds = [input.importRunId];
        activeBrainVersion = input.brainVersion;
        return { activeBrainVersion: input.brainVersion, activeImportRunIds };
      }
    },
    blobs: {
      async exists(hash: string) { return hash === CONTENT_HASH; },
      async get() { return CONTENT_BYTES; }
    },
    evidence: {
      async sourceVersionsForEvidence() { return [{ sourceId: "source-one", sourceVersionId: "sv-one", derivation: undefined, contentHash: CONTENT_HASH, byteLength: 64 }]; },
      async sourceVersionsByContentHashes() { return [{ sourceId: "source-one", sourceVersionId: "sv-one", contentHash: CONTENT_HASH, byteLength: 64 }]; },
      async getEvidenceBatch() { return [{ id: "evidence-one", sourceId: "source-one", sourceVersionId: "sv-one", status: "promoted" }]; }
    },
    model: {
      async listLanguageProfiles() { return [{ id: "profile-one", sourceVersionId: "sv-one" }]; },
      async listLanguageProfileHeaders() { return [{ id: "profile-one", sourceVersionId: "sv-one" }]; }
    },
    languageMemory: {
      async listNgramModels() { return [{ id: "model-one" }]; },
      async listNgramModelHeaders() { return [{ id: "model-one", profileId: "profile-one" }]; }
    },
    languageIdentities: {
      async listIdentities() { return [identity]; },
      async listProfileLanguages() { return [{ profileId: "profile-one", languageId: "identity-one" }]; },
      async listProfileSignatures() { return []; },
      async putIdentities() {},
      async assignProfileLanguages() {}
    }
  } as unknown as ScceStorage;
  return { storage, get lifecycle() { return lifecycle; }, ledger, get activationCalls() { return activationCalls; } };
}

async function canonicalFixture(count: number) {
  const k = await vi.importActual<typeof import("@scce/kernel")>("@scce/kernel");
  const hasher = k.createHasher(), ids = k.createIdFactory({ hasher, clock: k.createClock({ fixedTime: 1 }), deterministicReplay: true });
  const f = createFixture(), blobs = new Map<string, Uint8Array>();
  const versions: import("@scce/kernel").SourceVersion[] = [], spans: import("@scce/kernel").EvidenceSpan[] = [];
  const profiles: import("@scce/kernel").LanguageProfileHeader[] = [], models: import("@scce/kernel").NgramModelHeader[] = [];
  const reports: LanguageCorpusTrainingReport[] = [];
  for (let index = 0; index < count; index++) {
    const text = String(index).padEnd(64, "a"), bytes = Buffer.from(text), contentHash = ids.contentHash(bytes), sourceVersionId = ids.sourceVersionId(bytes),
      canonicalUri = `fixture://source/${index}`, sourceId = ids.sourceId("owned", canonicalUri), byteLength = bytes.byteLength;
    blobs.set(contentHash, bytes);
    versions.push({ sourceId, sourceVersionId, canonicalUri, contentHash, byteLength, observedAt: 1, namespace: "owned", mediaType: "text/plain", metadata: {}, role: "original",
      sourceTrust: { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1, independenceGroup: canonicalUri, accessScope: "owned", licenseStatus: "owned" } });
    const coordinates = { sourceVersionId, byteStart: 0, byteEnd: byteLength, spanHash: contentHash };
    const id = ids.evidenceId(coordinates), profileId = `profile-${index}`, modelId = `model-${index}`;
    spans.push({ id, sourceId, sourceVersionId, chunkId: ids.chunkId({ ...coordinates, chunkHash: contentHash }), contentHash, mediaType: "text/plain", byteStart: 0, byteEnd: byteLength,
      charStart: 0, charEnd: text.length, text, textPreview: text, languageHints: {}, scriptHints: {}, trustVector: {}, provenance: {}, features: [], status: "promoted", alpha: 1, observedAt: 1 });
    profiles.push({ id: profileId, sourceVersionId }); models.push({ id: modelId, profileId });
    reports.push({ ...report(), sourceVersionId, originalSourceVersionId: sourceVersionId, sourceContentHash: contentHash, sourceByteLength: byteLength, streamUri: canonicalUri,
      artifacts: { languageProfileId: profileId, ngramModelIds: [modelId], evidenceIds: [id] } });
  }
  const pages = { evidence: [] as string[][], profiles: [] as string[][], models: [] as string[][] }; let bodyReads = 0;
  f.storage.blobs.exists = async hash => blobs.has(hash); f.storage.blobs.get = async hash => { const bytes = blobs.get(hash); if (!bytes) throw Error("missing"); return bytes; };
  f.storage.evidence.sourceVersionById = async id => versions.find(row => row.sourceVersionId === id) ?? null;
  f.storage.evidence.sourceVersionsByContentHashes = async hashes => versions.filter(row => hashes.includes(row.contentHash));
  f.storage.evidence.sourceVersionsForEvidence = async ids => versions.filter(version => spans.some(span => ids.includes(span.id) && span.sourceVersionId === version.sourceVersionId));
  f.storage.evidence.getEvidenceBatch = async ids => { pages.evidence.push([...ids]); return spans.filter(row => ids.includes(row.id)); };
  f.storage.model.listLanguageProfileHeaders = async q => { pages.profiles.push([...q.profileIds]); return profiles.filter(row => q.profileIds.includes(row.id)).slice(0, q.limit); };
  f.storage.languageMemory.listNgramModelHeaders = async q => { pages.models.push([...q.modelIds]); return models.filter(row => q.modelIds.includes(row.id) && (!q.profileIds || q.profileIds.includes(row.profileId))).slice(0, q.limit); };
  f.storage.model.listLanguageProfiles = async () => { bodyReads++; throw Error("must not hydrate profile bodies"); };
  f.storage.languageMemory.listNgramModels = async () => { bodyReads++; throw Error("must not hydrate model bodies"); };
  f.storage.languageIdentities!.listProfileLanguages = async q => profiles.filter(row => !q?.profileIds || q.profileIds.includes(row.id)).map(row => ({ profileId: row.id, languageId: "identity-one" }));
  return { storage: f.storage, get activationCalls() { return f.activationCalls; }, versions, spans, profiles, models, blobs, reports, pages, get bodyReads() { return bodyReads; },
    selected: versions.map(row => ({ sourceVersionId: String(row.sourceVersionId), contentHash: String(row.contentHash), byteLength: row.byteLength })) };
}
