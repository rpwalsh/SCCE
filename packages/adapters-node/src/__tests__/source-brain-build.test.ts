// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { BrainLifecycleRecord, BrainLifecycleState, ScceStorage } from "@scce/kernel";
import type { LanguageCorpusTrainingReport } from "../language-corpus-trainer.js";

vi.mock("@scce/kernel", () => {
  const digestHex = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
  return {
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

import { completeInitialSourceBrainBuild, completeInitialSourceBrainFromDialogueReport, type DialogueSourceBrainReport } from "../source-brain-build.js";

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
});

function buildInput(storage: ScceStorage) {
  return {
    storage,
    informationLabel: { tenantId: "tenant.owner", principals: ["owner"], compartments: [], exportClass: "restricted" as const, mergePolicy: "isolated" as const },
    sourceId: "owner-source",
    sourceSchema: "scce.owner.source.v1",
    rootPath: "C:/source/one-document",
    sourceManifestHash: "b".repeat(64),
    selectedItems: [{ sourceVersionId: "sv-one", contentHash: CONTENT_HASH, byteLength: 64 }],
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
      async sourceVersionsForEvidence() { return [{ sourceVersionId: "sv-one", derivation: undefined }]; },
      async sourceVersionsByContentHashes() { return [{ sourceVersionId: "sv-one", contentHash: CONTENT_HASH, byteLength: 64 }]; },
      async getEvidenceBatch() { return [{ id: "evidence-one", sourceVersionId: "sv-one" }]; }
    },
    model: {
      async listLanguageProfiles() { return [{ id: "profile-one", sourceVersionId: "sv-one" }]; }
    },
    languageMemory: {
      async listNgramModels() { return [{ id: "model-one" }]; }
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
