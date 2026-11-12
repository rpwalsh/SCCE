// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import {
  WIKIPEDIA_PUBLICATION_RECEIPT_KINDS,
  WIKIPEDIA_PUBLICATION_RECEIPT_SCHEMA,
  canonicalDigestHex,
  canonicalStringify,
  createHasher,
  toJsonValue,
  wikipediaSourceCompilationInventoryHash,
  type BrainLifecycleRecord,
  type WikipediaPublicationBinding,
  type WikipediaPublicationReceiptKind,
  type WikipediaSourceCompilationInventoryEntry
} from "@scce/kernel";
import {
  finalizeWikipediaCandidatePublication,
  type WikipediaPublicationEvidence
} from "../wikipedia-publication-finalization.js";

const hasher = createHasher();
const encoder = new TextEncoder();

function fixture() {
  const manifestHash = hasher.digestHex("manifest");
  const lifecycle: BrainLifecycleRecord = {
    importRunId: "import.wikipedia.publication",
    brainVersion: "brain.wikipedia.publication",
    rootPath: "C:/brains/wikipedia",
    state: "VALIDATING",
    manifest: {
      schema: "scce.brainManifestContract.v1",
      importRunId: "import.wikipedia.publication",
      brainVersion: "brain.wikipedia.publication",
      rootPath: "C:/brains/wikipedia",
      manifestHash,
      sourceSchema: "scce.wikipediaV3Import.v1",
      runtimeContractVersion: 1,
      content: { graphShardCount: 1, languageShardCount: 1, ngramStateCount: 1, priorSectionCount: 3 },
      metadata: {},
      createdAt: 1
    },
    revision: 2,
    createdAt: 1,
    updatedAt: 2
  };
  const sourceCompilations = compilationFixture();
  const binding: WikipediaPublicationBinding = {
    importRunId: lifecycle.importRunId,
    brainVersion: lifecycle.brainVersion,
    manifestHash,
    inventoryHash: wikipediaSourceCompilationInventoryHash(sourceCompilations, hasher),
    executableHash: hasher.digestHex("executable"),
    configurationHash: hasher.digestHex("configuration"),
    policyHash: hasher.digestHex("policy"),
    casesHash: hasher.digestHex("cases")
  };
  const blobs = new Map<string, Uint8Array>();
  const receipts = WIKIPEDIA_PUBLICATION_RECEIPT_KINDS.map(kind => {
    const bytes = encoder.encode(JSON.stringify({
      schema: WIKIPEDIA_PUBLICATION_RECEIPT_SCHEMA,
      kind,
      binding,
      result: receiptResult(kind, binding)
    }));
    const contentHash = hasher.digestHex(bytes);
    blobs.set(contentHash, bytes);
    return { kind, contentHash };
  });
  const evidence: WikipediaPublicationEvidence = {
    executableHash: binding.executableHash,
    configurationHash: binding.configurationHash,
    policyHash: binding.policyHash,
    casesHash: binding.casesHash,
    sourceCompilations,
    receipts
  };
  const ledgers: any[] = [];
  const transitionLifecycle = vi.fn(async (input: any) => ({
    ...lifecycle,
    state: input.toState,
    validation: input.validation,
    revision: lifecycle.revision + 1,
    updatedAt: input.updatedAt
  }));
  const activateReady = vi.fn();
  const storage = {
    blobs: {
      get: async (hash: string) => {
        const bytes = blobs.get(hash);
        if (!bytes) throw new Error("missing blob");
        return bytes;
      }
    },
    brainImports: {
      putLedger: async (record: any) => { ledgers.push(record); },
      transitionLifecycle,
      activateReady
    }
  } as any;
  return { lifecycle, evidence, storage, ledgers, transitionLifecycle, activateReady };
}

function compilationFixture(): WikipediaSourceCompilationInventoryEntry[] {
  const common = { schema: "scce.source_language_compilation.v1", owner: "wikipedia-fixture" };
  const compilationId = canonicalDigestHex(common, hasher);
  const models = [{
    id: "model.wikipedia.fixture",
    streamId: "stream.wikipedia.fixture",
    chunk: toJsonValue({ index: 0, start: 0, end: 10, textHash: hasher.digestHex("chunk") }),
    modelDigest: hasher.digestHex("model")
  }];
  return [{ receipt: toJsonValue({ ...common, compilationId, modelInventory: models }), models }];
}

function receiptResult(kind: WikipediaPublicationReceiptKind, binding: WikipediaPublicationBinding): Record<string, unknown> {
  switch (kind) {
    case "cold_reconstruction": return {
      status: "PASSED", reopenedManifestHash: binding.manifestHash, reconstructedInventoryHash: binding.inventoryHash
    };
    case "production_artifact_admission": return {
      status: "PASSED", admittedExecutableHash: binding.executableHash, consumedExecutableHash: binding.executableHash
    };
    case "learned_realization": return { status: "PASSED", casesHash: binding.casesHash, passedCases: 2, totalCases: 2 };
    case "calibration_identities": return { status: "PASSED", policyHash: binding.policyHash, identityCount: 2, failedIdentityCount: 0 };
    case "http_english_evaluation": return {
      status: "PASSED", casesHash: binding.casesHash, configurationHash: binding.configurationHash,
      transport: "http", serverAdmission: "production", passedCases: 2, totalCases: 2
    };
  }
}

describe("Wikipedia publication finalization", () => {
  it("persists an explicit pending FAILED report without leaving VALIDATING", async () => {
    const fixtureValue = fixture();
    const result = await finalizeWikipediaCandidatePublication({
      storage: fixtureValue.storage,
      lifecycle: fixtureValue.lifecycle,
      validatedAt: 3,
      hasher
    });
    expect(result).toMatchObject({ pending: true, lifecycle: { state: "VALIDATING" }, qualification: { qualified: false } });
    expect(result.qualification.report.disposition).toBe("FAILED");
    expect(fixtureValue.transitionLifecycle).not.toHaveBeenCalled();
    expect(fixtureValue.activateReady).not.toHaveBeenCalled();
    expect(fixtureValue.ledgers).toHaveLength(1);
    expect(fixtureValue.ledgers[0].metadata).toMatchObject({ pending: true, validation: { disposition: "FAILED" } });
  });

  it("persists PASSED and advances VALIDATING to READY through the existing CAS only", async () => {
    const fixtureValue = fixture();
    const result = await finalizeWikipediaCandidatePublication({
      storage: fixtureValue.storage,
      lifecycle: fixtureValue.lifecycle,
      evidence: fixtureValue.evidence,
      validatedAt: 3,
      hasher
    });
    expect(result).toMatchObject({ pending: false, lifecycle: { state: "READY" }, qualification: { qualified: true } });
    expect(fixtureValue.transitionLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      expectedState: "VALIDATING", toState: "READY", validation: expect.objectContaining({ disposition: "PASSED" })
    }));
    expect(fixtureValue.activateReady).not.toHaveBeenCalled();
    expect(fixtureValue.ledgers[0].metadata).toMatchObject({ pending: false, validation: { disposition: "PASSED" } });
  });

  it("persists invalid supplied evidence and CASes to FAILED, never READY or ACTIVE", async () => {
    const fixtureValue = fixture();
    const evidence = { ...fixtureValue.evidence, receipts: fixtureValue.evidence.receipts.slice(1) };
    const result = await finalizeWikipediaCandidatePublication({
      storage: fixtureValue.storage,
      lifecycle: fixtureValue.lifecycle,
      evidence,
      validatedAt: 3,
      hasher
    });
    expect(result.qualification).toMatchObject({ qualified: false, report: { disposition: "FAILED" } });
    expect(fixtureValue.transitionLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      expectedState: "VALIDATING", toState: "FAILED", validation: expect.objectContaining({ disposition: "FAILED" })
    }));
    expect(fixtureValue.activateReady).not.toHaveBeenCalled();
  });

  it("refuses qualification outside VALIDATING before writing or transitioning", async () => {
    const fixtureValue = fixture();
    await expect(finalizeWikipediaCandidatePublication({
      storage: fixtureValue.storage,
      lifecycle: { ...fixtureValue.lifecycle, state: "READY" },
      evidence: fixtureValue.evidence,
      validatedAt: 3,
      hasher
    })).rejects.toThrow("requires VALIDATING");
    expect(fixtureValue.ledgers).toHaveLength(0);
    expect(fixtureValue.transitionLifecycle).not.toHaveBeenCalled();
  });

  it("uses the report bytes for the durable ledger identity", async () => {
    const fixtureValue = fixture();
    const result = await finalizeWikipediaCandidatePublication({
      storage: fixtureValue.storage,
      lifecycle: fixtureValue.lifecycle,
      validatedAt: 3,
      hasher
    });
    const reportHash = hasher.digestHex(canonicalStringify(result.qualification.report));
    expect(fixtureValue.ledgers[0]).toMatchObject({
      id: `wikipedia.publication.qualification.${reportHash}`,
      shardHash: reportHash
    });
  });
});
