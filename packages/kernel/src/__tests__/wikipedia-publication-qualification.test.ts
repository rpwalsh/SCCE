// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import type { BrainManifestContract } from "../brain-lifecycle.js";
import { canonicalDigestHex } from "../canonical-json-digest.js";
import { createHasher, toJsonValue } from "../primitives.js";
import {
  WIKIPEDIA_PUBLICATION_RECEIPT_KINDS,
  WIKIPEDIA_PUBLICATION_RECEIPT_SCHEMA,
  qualifyWikipediaPublicationCandidate,
  wikipediaSourceCompilationInventoryHash,
  type WikipediaPublicationBinding,
  type WikipediaPublicationQualificationInput,
  type WikipediaPublicationReceiptKind,
  type WikipediaSourceCompilationInventoryEntry
} from "../wikipedia-publication-qualification.js";

const hasher = createHasher();
const encoder = new TextEncoder();
const hashes = {
  manifest: hasher.digestHex("manifest"),
  executable: hasher.digestHex("executable"),
  configuration: hasher.digestHex("configuration"),
  policy: hasher.digestHex("policy"),
  cases: hasher.digestHex("cases")
};

function sourceCompilations(): WikipediaSourceCompilationInventoryEntry[] {
  const common = {
    schema: "scce.source_language_compilation.v1",
    sourceId: "source.wikipedia.fixture",
    sourceVersionId: "source-version.wikipedia.fixture",
    contentHash: `sha256_${hasher.digestHex("source")}`,
    profileId: "language-profile.wikipedia.fixture"
  };
  const compilationId = canonicalDigestHex(common, hasher);
  const models = [{
    id: "ngram-model.wikipedia.fixture",
    streamId: "training-stream.wikipedia.fixture",
    chunk: toJsonValue({ index: 0, start: 0, end: 16, textHash: hasher.digestHex("source chunk") }),
    modelDigest: hasher.digestHex("model")
  }];
  return [{ receipt: toJsonValue({ ...common, compilationId, modelInventory: models }), models }];
}

function fixture() {
  const compilations = sourceCompilations();
  const binding: WikipediaPublicationBinding = {
    importRunId: "import.wikipedia.fixture",
    brainVersion: "brain.wikipedia.fixture",
    manifestHash: hashes.manifest,
    inventoryHash: wikipediaSourceCompilationInventoryHash(compilations, hasher),
    executableHash: hashes.executable,
    configurationHash: hashes.configuration,
    policyHash: hashes.policy,
    casesHash: hashes.cases
  };
  const manifest: BrainManifestContract = {
    schema: "scce.brainManifestContract.v1",
    importRunId: binding.importRunId,
    brainVersion: binding.brainVersion,
    rootPath: "C:/brains/wikipedia-fixture",
    manifestHash: binding.manifestHash,
    sourceSchema: "scce.wikipedia_dump.v1",
    runtimeContractVersion: 1,
    content: { graphShardCount: 1, languageShardCount: 1, ngramStateCount: 1, priorSectionCount: 1 },
    metadata: {},
    createdAt: 1
  };
  const bytes = new Map<string, Uint8Array>();
  const receipts = WIKIPEDIA_PUBLICATION_RECEIPT_KINDS.map(kind => {
    const encoded = encoder.encode(JSON.stringify({
      schema: WIKIPEDIA_PUBLICATION_RECEIPT_SCHEMA,
      kind,
      binding,
      result: resultFor(kind, binding)
    }));
    const contentHash = hasher.digestHex(encoded);
    bytes.set(contentHash, encoded);
    return { kind, contentHash };
  });
  const input: WikipediaPublicationQualificationInput = {
    lifecycleState: "VALIDATING",
    manifest,
    binding,
    sourceCompilations: compilations,
    receipts,
    readContent: async contentHash => bytes.get(contentHash),
    validatedAt: 2,
    hasher
  };
  return { input, bytes };
}

function resultFor(kind: WikipediaPublicationReceiptKind, binding: WikipediaPublicationBinding): Record<string, unknown> {
  switch (kind) {
    case "cold_reconstruction": return {
      status: "PASSED", reopenedManifestHash: binding.manifestHash, reconstructedInventoryHash: binding.inventoryHash
    };
    case "production_artifact_admission": return {
      status: "PASSED", admittedExecutableHash: binding.executableHash, consumedExecutableHash: binding.executableHash
    };
    case "learned_realization": return { status: "PASSED", casesHash: binding.casesHash, passedCases: 3, totalCases: 3 };
    case "calibration_identities": return { status: "PASSED", policyHash: binding.policyHash, identityCount: 3, failedIdentityCount: 0 };
    case "http_english_evaluation": return {
      status: "PASSED", casesHash: binding.casesHash, configurationHash: binding.configurationHash,
      transport: "http", serverAdmission: "production", passedCases: 4, totalCases: 4
    };
  }
}

describe("Wikipedia publication qualification", () => {
  it("emits a PASSED lifecycle report only after every immutable receipt is verified", async () => {
    const { input } = fixture();
    const result = await qualifyWikipediaPublicationCandidate(input);
    expect(result.qualified).toBe(true);
    expect(result.report).toMatchObject({
      disposition: "PASSED",
      importRunId: input.binding.importRunId,
      brainVersion: input.binding.brainVersion,
      manifestHash: input.binding.manifestHash
    });
    expect(result.report.checks.every(check => check.passed)).toBe(true);
    if (result.qualified) expect(result.qualificationHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("fails closed when a required receipt is absent", async () => {
    const { input } = fixture();
    const result = await qualifyWikipediaPublicationCandidate({ ...input, receipts: input.receipts.slice(1) });
    expect(result.qualified).toBe(false);
    expect(result.report.disposition).toBe("FAILED");
    expect(result.report.checks).toContainEqual(expect.objectContaining({
      id: "publication.receipt.cold_reconstruction", passed: false
    }));
  });

  it("rejects bytes that do not match the referenced content address", async () => {
    const { input, bytes } = fixture();
    const reference = input.receipts.find(receipt => receipt.kind === "learned_realization")!;
    bytes.set(reference.contentHash, encoder.encode("{}"));
    const result = await qualifyWikipediaPublicationCandidate(input);
    expect(result.qualified).toBe(false);
    expect(result.report.checks).toContainEqual(expect.objectContaining({
      id: "publication.receipt.learned_realization", passed: false,
      message: "learned_realization receipt bytes do not match their content address"
    }));
  });

  it("rejects a content-addressed receipt whose semantic result failed", async () => {
    const { input, bytes } = fixture();
    const index = input.receipts.findIndex(receipt => receipt.kind === "http_english_evaluation");
    const failedBytes = encoder.encode(JSON.stringify({
      schema: WIKIPEDIA_PUBLICATION_RECEIPT_SCHEMA,
      kind: "http_english_evaluation",
      binding: input.binding,
      result: { ...resultFor("http_english_evaluation", input.binding), status: "FAILED", passedCases: 3 }
    }));
    const failedHash = hasher.digestHex(failedBytes);
    bytes.set(failedHash, failedBytes);
    const receipts = input.receipts.map((receipt, receiptIndex) => receiptIndex === index ? { ...receipt, contentHash: failedHash } : receipt);
    const result = await qualifyWikipediaPublicationCandidate({ ...input, receipts });
    expect(result.qualified).toBe(false);
    expect(result.report.checks).toContainEqual(expect.objectContaining({
      id: "publication.receipt.http_english_evaluation", passed: false,
      message: "http_english_evaluation receipt did not pass"
    }));
  });

  it("rejects receipt reuse across candidates even when the bytes remain intact", async () => {
    const { input } = fixture();
    const changed = {
      ...input,
      binding: { ...input.binding, executableHash: hasher.digestHex("replacement executable") }
    };
    const result = await qualifyWikipediaPublicationCandidate(changed);
    expect(result.qualified).toBe(false);
    expect(result.report.checks.some(check => !check.passed && check.message.includes("not bound to this candidate"))).toBe(true);
  });

  it("runs the existing canonical source-compilation inventory validator", async () => {
    const { input } = fixture();
    const sourceCompilations = input.sourceCompilations.map(entry => ({
      ...entry,
      models: entry.models.map(model => ({ ...model, modelDigest: hasher.digestHex("changed model") }))
    }));
    const result = await qualifyWikipediaPublicationCandidate({ ...input, sourceCompilations });
    expect(result.qualified).toBe(false);
    expect(result.report.checks).toContainEqual(expect.objectContaining({
      id: "publication.source_compilations.0", passed: false
    }));
  });

  it("does not qualify a candidate outside VALIDATING", async () => {
    const { input } = fixture();
    const result = await qualifyWikipediaPublicationCandidate({ ...input, lifecycleState: "READY" });
    expect(result.qualified).toBe(false);
    expect(result.report.checks).toContainEqual(expect.objectContaining({
      id: "publication.lifecycle.validating", passed: false
    }));
  });
});
