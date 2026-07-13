import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const EVALUATION_CONDITION_IDS = Object.freeze([
  "full",
  "no_relation_potential",
  "no_query_diffusion",
  "no_powerwalk",
  "no_graph",
  "lexical_only",
  "no_support_engine",
  "deterministic_mouth",
  "no_language_memory",
  "no_incremental_learning",
  "no_shard_router"
]);

/** Parse the process environment once, before a runtime is constructed. */
export function parseEvaluationEnvironment(environment) {
  const conditionId = requiredEnvironment(environment, "YOPP_EVAL_CONDITION");
  if (!EVALUATION_CONDITION_IDS.includes(conditionId)) throw new Error(`unknown YOPP_EVAL_CONDITION: ${conditionId}`);
  const seed = requiredEnvironment(environment, "YOPP_EVAL_SEED");
  const clockIso = requiredEnvironment(environment, "YOPP_EVAL_CLOCK");
  if (!Number.isFinite(Date.parse(clockIso))) throw new Error("YOPP_EVAL_CLOCK must be an ISO-8601 timestamp");
  const runId = requiredEnvironment(environment, "YOPP_EVAL_RUN_ID");
  const corpusManifestPath = path.resolve(requiredEnvironment(environment, "YOPP_EVAL_CORPUS_MANIFEST"));
  const requestedScope = optionalEnvironment(environment, "YOPP_EVAL_SCOPE");
  const databaseSchema = optionalEnvironment(environment, "YOPP_EVAL_DATABASE_SCHEMA");
  if (databaseSchema && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(databaseSchema)) throw new Error("YOPP_EVAL_DATABASE_SCHEMA must be a safe PostgreSQL schema identifier");
  const scope = requestedScope ?? (conditionId === "no_shard_router" ? "performance-recovery" : "answer-quality");
  if (scope !== "answer-quality" && scope !== "performance-recovery") {
    throw new Error("YOPP_EVAL_SCOPE must be answer-quality or performance-recovery");
  }
  if (conditionId === "no_shard_router" && scope !== "performance-recovery") {
    throw new Error("no_shard_router requires YOPP_EVAL_SCOPE=performance-recovery");
  }
  return Object.freeze({
    conditionInput: Object.freeze({ conditionId, seed, clockIso, scope }),
    runId,
    corpusManifestPath,
    configPath: path.resolve(optionalEnvironment(environment, "YOPP_EVAL_CONFIG_PATH") ?? "scce.config.json"),
    databaseSchema
  });
}

export function ownerInputForEvaluationQuestion(question, evaluation) {
  if (!question || typeof question !== "object" || Array.isArray(question)) throw new Error("question must be an object");
  if (question.schemaVersion !== "1.0") throw new Error("question.schemaVersion must be 1.0");
  if (typeof question.questionId !== "string" || !question.questionId.trim()) throw new Error("question.questionId must be non-empty");
  if (typeof question.category !== "string" || !question.category.trim()) throw new Error("question.category must be non-empty");
  if (typeof question.prompt !== "string" || !question.prompt.trim()) throw new Error("question.prompt must be non-empty");
  const conversationId = typeof question.conversationId === "string" && question.conversationId.trim()
    ? question.conversationId
    : `sealed:${evaluation.runId}:${question.questionId}`;
  const turnIndex = Number.isInteger(question.turnIndex) && question.turnIndex >= 0 ? question.turnIndex : 0;
  return {
    text: question.prompt,
    // Gold answers and protectedMetadata are deliberately not copied into the runtime boundary.
    metadata: {
      questionId: question.questionId,
      conversationId,
      turnIndex,
      category: question.category,
      ...(typeof question.language === "string" ? { language: question.language } : {}),
      ...(typeof question.resourceClass === "string" ? { resourceClass: question.resourceClass } : {}),
      evaluation: {
        runId: evaluation.runId,
        questionId: question.questionId,
        conversationId,
        turnIndex,
        conditionId: evaluation.condition.conditionId,
        configHash: evaluation.condition.configHash,
        cacheNamespace: evaluation.condition.cacheNamespace
      }
    }
  };
}

export async function loadVerifiedCorpusManifest(manifestPath) {
  const absoluteManifestPath = path.resolve(manifestPath);
  const manifest = JSON.parse(await readFile(absoluteManifestPath, "utf8"));
  if (!manifest || manifest.schemaVersion !== "1.0" || !Array.isArray(manifest.documents) || manifest.documents.length === 0) {
    throw new Error("corpus manifest must be schemaVersion 1.0 with at least one document");
  }
  const basePath = path.dirname(absoluteManifestPath);
  const documentBytes = new Map();
  const resolvedPaths = new Map();
  for (const document of manifest.documents) {
    if (!document || typeof document.documentId !== "string" || !document.documentId.trim()) throw new Error("corpus documentId must be non-empty");
    if (typeof document.path !== "string" || !document.path.trim()) throw new Error(`corpus document ${document.documentId} has no path`);
    const resolvedPath = path.resolve(basePath, document.path);
    const bytes = await readFile(resolvedPath);
    documentBytes.set(document.documentId, bytes);
    resolvedPaths.set(document.documentId, resolvedPath);
  }
  return buildVerifiedCorpusIndex({ manifest, manifestPath: absoluteManifestPath, documentBytes, resolvedPaths });
}

/**
 * Build a read-only, fully hashed corpus index. This has no database dependency,
 * which keeps exact citation behavior independently testable.
 */
export function buildVerifiedCorpusIndex({ manifest, manifestPath = "corpus-manifest.json", documentBytes, resolvedPaths = new Map() }) {
  if (!manifest || manifest.schemaVersion !== "1.0" || !Array.isArray(manifest.documents) || manifest.documents.length === 0) {
    throw new Error("corpus manifest must be schemaVersion 1.0 with at least one document");
  }
  const documents = new Map();
  const documentsByHash = new Map();
  for (const descriptor of manifest.documents) {
    if (documents.has(descriptor.documentId)) throw new Error(`duplicate corpus documentId: ${descriptor.documentId}`);
    const bytesValue = documentBytes.get(descriptor.documentId);
    if (bytesValue === undefined) throw new Error(`corpus bytes missing for document: ${descriptor.documentId}`);
    const bytes = Buffer.from(bytesValue);
    const actualHash = sha256(bytes);
    const expectedHash = normalizedSha256(descriptor.sha256);
    if (!expectedHash || actualHash !== expectedHash) throw new Error(`corpus document hash mismatch: ${descriptor.documentId}`);
    if (!Number.isInteger(descriptor.sizeBytes) || descriptor.sizeBytes !== bytes.length) {
      throw new Error(`corpus document size mismatch: ${descriptor.documentId}`);
    }
    const resolvedPath = resolvedPaths.get(descriptor.documentId)
      ?? path.resolve(path.dirname(path.resolve(manifestPath)), descriptor.path);
    const document = Object.freeze({ descriptor: Object.freeze({ ...descriptor }), bytes, sha256: actualHash, resolvedPath });
    documents.set(descriptor.documentId, document);
    const sameHash = documentsByHash.get(actualHash) ?? [];
    sameHash.push(document);
    documentsByHash.set(actualHash, sameHash);
  }
  return Object.freeze({ manifestPath: path.resolve(manifestPath), documents, documentsByHash });
}

/**
 * Emit a citation only if the persisted source version, exact manifest bytes,
 * byte range, UTF-8 text, and span hash all agree. Ambiguity is omission, never
 * a guessed document identity.
 */
export function mapExactCitations({ evidence, sourceVersions, corpus }) {
  const sources = new Map();
  for (const source of sourceVersions ?? []) {
    if (source && typeof source.sourceVersionId === "string") sources.set(source.sourceVersionId, source);
  }
  const citations = [];
  const omissions = [];
  const emitted = new Set();
  for (const span of evidence ?? []) {
    const source = sources.get(String(span?.sourceVersionId ?? ""));
    if (!source) {
      omissions.push(omission(span, "source-version-missing"));
      continue;
    }
    const sourceHash = normalizedSha256(source.contentHash);
    if (!sourceHash) {
      omissions.push(omission(span, "source-version-hash-invalid"));
      continue;
    }
    const matches = corpus.documentsByHash.get(sourceHash) ?? [];
    const document = selectExactDocument(matches, source);
    if (!document) {
      omissions.push(omission(span, matches.length > 1 ? "document-identity-ambiguous" : "source-version-not-in-manifest"));
      continue;
    }
    if (source.byteLength !== document.bytes.length || sourceHash !== document.sha256) {
      omissions.push(omission(span, "source-version-byte-contract-mismatch"));
      continue;
    }
    const startByte = span.byteStart;
    const endByte = span.byteEnd;
    if (!Number.isInteger(startByte) || !Number.isInteger(endByte) || startByte < 0 || endByte < startByte || endByte > document.bytes.length) {
      omissions.push(omission(span, "evidence-byte-range-invalid"));
      continue;
    }
    const slice = document.bytes.subarray(startByte, endByte);
    const quotedText = slice.toString("utf8");
    if (quotedText !== span.text || Buffer.byteLength(span.text, "utf8") !== slice.length) {
      omissions.push(omission(span, "evidence-text-mismatch"));
      continue;
    }
    const sliceHash = sha256(slice);
    if (normalizedSha256(span.contentHash) !== sliceHash) {
      omissions.push(omission(span, "evidence-hash-mismatch"));
      continue;
    }
    const key = `${document.descriptor.documentId}\u0000${startByte}\u0000${endByte}\u0000${sliceHash}`;
    if (emitted.has(key)) continue;
    emitted.add(key);
    citations.push({
      documentId: document.descriptor.documentId,
      startByte,
      endByte,
      sha256: sliceHash,
      quotedText
    });
  }
  return Object.freeze({ citations: Object.freeze(citations), omissions: Object.freeze(omissions) });
}

export function sanitizeAdapterError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s]+/giu, "[redacted-database-url]")
    .replace(/password\s*=\s*[^\s;]+/giu, "password=[redacted]")
    .slice(0, 1000);
}

function selectExactDocument(matches, source) {
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];
  const metadata = source.metadata && typeof source.metadata === "object" && !Array.isArray(source.metadata) ? source.metadata : {};
  const explicitId = [metadata.documentId, metadata.corpusDocumentId, metadata.evaluationDocumentId]
    .find(value => typeof value === "string" && value.trim());
  if (explicitId) return matches.find(candidate => candidate.descriptor.documentId === explicitId);
  const sourceUri = normalizeUri(source.canonicalUri);
  const uriMatches = matches.filter(candidate => {
    const resolved = normalizeUri(candidate.resolvedPath);
    const fileUri = normalizeUri(pathToFileURL(candidate.resolvedPath).href);
    return sourceUri === resolved || sourceUri === fileUri;
  });
  return uriMatches.length === 1 ? uriMatches[0] : undefined;
}

function normalizedSha256(value) {
  if (typeof value !== "string") return undefined;
  const match = value.trim().toLowerCase().match(/^(?:sha256[_:])?([0-9a-f]{64})$/u);
  return match?.[1];
}

function normalizeUri(value) {
  return typeof value === "string" ? value.trim().replaceAll("\\", "/").toLowerCase() : "";
}

function omission(span, reason) {
  return Object.freeze({ evidenceId: String(span?.id ?? ""), sourceVersionId: String(span?.sourceVersionId ?? ""), reason });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requiredEnvironment(environment, key) {
  const value = optionalEnvironment(environment, key);
  if (value === undefined) throw new Error(`missing ${key}`);
  return value;
}

function optionalEnvironment(environment, key) {
  const value = environment?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
