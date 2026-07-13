import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import {
  buildVerifiedCorpusIndex,
  mapExactCitations,
  ownerInputForEvaluationQuestion,
  parseEvaluationEnvironment
} from "../../integration/yopp-jsonl-adapter-lib.mjs";

test("evaluation environment produces one explicit typed condition input", () => {
  const parsed = parseEvaluationEnvironment({
    YOPP_EVAL_CONDITION: "no_graph",
    YOPP_EVAL_SEED: "sealed-seed-1",
    YOPP_EVAL_CLOCK: "2026-01-01T00:00:00.000Z",
    YOPP_EVAL_RUN_ID: "run-1",
    YOPP_EVAL_CORPUS_MANIFEST: "fixtures/corpus.json",
    YOPP_EVAL_CONFIG_PATH: "fixture.config.json",
    YOPP_EVAL_DATABASE_SCHEMA: "sealed_run_1"
  });
  assert.deepEqual(parsed.conditionInput, {
    conditionId: "no_graph",
    seed: "sealed-seed-1",
    clockIso: "2026-01-01T00:00:00.000Z",
    scope: "answer-quality"
  });
  assert.equal(parsed.runId, "run-1");
  assert.equal(parsed.corpusManifestPath, path.resolve("fixtures/corpus.json"));
  assert.equal(parsed.databaseSchema, "sealed_run_1");
  assert.throws(() => parseEvaluationEnvironment({}), /missing YOPP_EVAL_CONDITION/u);
  assert.throws(() => parseEvaluationEnvironment({
    YOPP_EVAL_CONDITION: "not-a-condition",
    YOPP_EVAL_SEED: "x",
    YOPP_EVAL_CLOCK: "2026-01-01T00:00:00.000Z",
    YOPP_EVAL_RUN_ID: "x",
    YOPP_EVAL_CORPUS_MANIFEST: "x"
  }), /unknown YOPP_EVAL_CONDITION/u);
  assert.throws(() => parseEvaluationEnvironment({
    YOPP_EVAL_CONDITION: "full",
    YOPP_EVAL_SEED: "x",
    YOPP_EVAL_CLOCK: "2026-01-01T00:00:00.000Z",
    YOPP_EVAL_RUN_ID: "x",
    YOPP_EVAL_CORPUS_MANIFEST: "x",
    YOPP_EVAL_DATABASE_SCHEMA: "unsafe-schema;drop"
  }), /safe PostgreSQL schema identifier/u);
});

test("no_shard_router is constrained to the performance-recovery scope", () => {
  const base = {
    YOPP_EVAL_CONDITION: "no_shard_router",
    YOPP_EVAL_SEED: "sealed-seed-1",
    YOPP_EVAL_CLOCK: "2026-01-01T00:00:00.000Z",
    YOPP_EVAL_RUN_ID: "run-1",
    YOPP_EVAL_CORPUS_MANIFEST: "corpus.json"
  };
  assert.equal(parseEvaluationEnvironment(base).conditionInput.scope, "performance-recovery");
  assert.throws(() => parseEvaluationEnvironment({ ...base, YOPP_EVAL_SCOPE: "answer-quality" }), /requires.*performance-recovery/u);
});

test("question mapping passes conversation identity but never gold or protected metadata", () => {
  const owner = ownerInputForEvaluationQuestion({
    schemaVersion: "1.0",
    questionId: "q-1",
    category: "knowledge",
    prompt: "What is supported?",
    conversationId: "conversation-7",
    turnIndex: 2,
    gold: { acceptedAnswers: ["secret"] },
    protectedMetadata: { scoringKey: "secret" }
  }, {
    runId: "run-1",
    condition: { conditionId: "full", configHash: "hash", cacheNamespace: "namespace" }
  });
  assert.equal(owner.text, "What is supported?");
  assert.equal(owner.metadata.questionId, "q-1");
  assert.equal(owner.metadata.conversationId, "conversation-7");
  assert.equal(owner.metadata.turnIndex, 2);
  assert.equal("gold" in owner.metadata, false);
  assert.equal("protectedMetadata" in owner.metadata, false);
});

test("exact citation mapping verifies UTF-8 bytes, source version, span text, and both hashes", () => {
  const bytes = Buffer.from("A😀 café 中文\r\nend", "utf8");
  const documentHash = sha256(bytes);
  const corpus = buildVerifiedCorpusIndex({
    manifest: { schemaVersion: "1.0", corpusId: "c", documents: [{ documentId: "doc-1", path: "docs/x.txt", sha256: documentHash, sizeBytes: bytes.length }] },
    manifestPath: path.resolve("fixture/corpus.json"),
    documentBytes: new Map([["doc-1", bytes]])
  });
  const startByte = Buffer.byteLength("A😀 ", "utf8");
  const quotedText = "café 中文";
  const endByte = startByte + Buffer.byteLength(quotedText, "utf8");
  const citation = mapExactCitations({
    corpus,
    sourceVersions: [{ sourceVersionId: "sv-1", contentHash: `sha256_${documentHash}`, byteLength: bytes.length, canonicalUri: "fixture/docs/x.txt", metadata: {} }],
    evidence: [{ id: "e-1", sourceVersionId: "sv-1", byteStart: startByte, byteEnd: endByte, text: quotedText, contentHash: `sha256_${sha256(bytes.subarray(startByte, endByte))}` }]
  });
  assert.deepEqual(citation.citations, [{
    documentId: "doc-1",
    startByte,
    endByte,
    sha256: sha256(bytes.subarray(startByte, endByte)),
    quotedText
  }]);
  assert.deepEqual(citation.omissions, []);
});

test("citation mapping omits every mismatch and refuses ambiguous document identity", () => {
  const bytes = Buffer.from("same bytes", "utf8");
  const hash = sha256(bytes);
  const corpus = buildVerifiedCorpusIndex({
    manifest: {
      schemaVersion: "1.0",
      corpusId: "c",
      documents: [
        { documentId: "doc-a", path: "a.txt", sha256: hash, sizeBytes: bytes.length },
        { documentId: "doc-b", path: "b.txt", sha256: hash, sizeBytes: bytes.length }
      ]
    },
    manifestPath: path.resolve("fixture/corpus.json"),
    documentBytes: new Map([["doc-a", bytes], ["doc-b", bytes]])
  });
  const ambiguous = mapExactCitations({
    corpus,
    sourceVersions: [{ sourceVersionId: "sv", contentHash: hash, byteLength: bytes.length, canonicalUri: "unknown", metadata: {} }],
    evidence: [{ id: "e", sourceVersionId: "sv", byteStart: 0, byteEnd: bytes.length, text: "same bytes", contentHash: hash }]
  });
  assert.equal(ambiguous.citations.length, 0);
  assert.equal(ambiguous.omissions[0].reason, "document-identity-ambiguous");

  const wrongText = mapExactCitations({
    corpus,
    sourceVersions: [{ sourceVersionId: "sv", contentHash: hash, byteLength: bytes.length, canonicalUri: "unknown", metadata: { documentId: "doc-a" } }],
    evidence: [{ id: "e", sourceVersionId: "sv", byteStart: 0, byteEnd: bytes.length, text: "wrong", contentHash: hash }]
  });
  assert.equal(wrongText.citations.length, 0);
  assert.equal(wrongText.omissions[0].reason, "evidence-text-mismatch");
});

test("corpus index rejects manifest hash and size mismatches before citation mapping", () => {
  const bytes = Buffer.from("document", "utf8");
  const descriptor = { documentId: "doc", path: "doc.txt", sha256: "0".repeat(64), sizeBytes: bytes.length };
  assert.throws(() => buildVerifiedCorpusIndex({
    manifest: { schemaVersion: "1.0", corpusId: "c", documents: [descriptor] },
    documentBytes: new Map([["doc", bytes]])
  }), /hash mismatch/u);
  assert.throws(() => buildVerifiedCorpusIndex({
    manifest: { schemaVersion: "1.0", corpusId: "c", documents: [{ ...descriptor, sha256: sha256(bytes), sizeBytes: bytes.length + 1 }] },
    documentBytes: new Map([["doc", bytes]])
  }), /size mismatch/u);
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
