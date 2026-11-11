// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

import { createIdFactory, type IdFactory } from "./ids.js";
import { createLanguageAcquisitionEngine } from "./language.js";
import {
  localEvidenceAnswerClaimSurface,
  localEvidenceAnswerProofExcerpts,
  proposeSourceExactEvidenceAnswer
} from "./local-evidence-runtime.js";
import { createProofCarryingAnswer, type PcaReport } from "./proof-carrying-answer.js";
import { canonicalStringify, createClock, createHasher, featureSet, sourceTextSurface, toJsonValue } from "./primitives.js";
import type { EvidenceSpan, LanguageProfile, SourceTrust, SourceVersion } from "./types.js";

/**
 * The deliberately small, browser-portable SCCE cognitive boundary.
 *
 * This is not a second answer engine. It composes the production identity,
 * language acquisition, exact-evidence answer planning and proof-carrying
 * answer mechanisms. Capabilities that still depend on Node are not exposed.
 */
export interface PortableLearnedSource {
  readonly source: SourceVersion;
  readonly sourceBytes: Uint8Array;
  readonly evidence: EvidenceSpan;
  readonly languageProfile: LanguageProfile;
}

export interface PortableLearnSourceInput {
  namespace: string;
  canonicalUri: string;
  mediaType: string;
  sourceBytes: Uint8Array;
  observedAt: number;
  title?: string;
}

export interface PortableEvidenceAnswer {
  readonly status: "resolved" | "evidence-unavailable";
  readonly answer: string;
  readonly evidenceIds: string[];
  readonly proofExcerpts: Array<{ text: string; evidenceId: string }>;
  readonly proof: PcaReport | null;
}

export interface PortableCognitiveRuntime {
  learnSource(input: PortableLearnSourceInput): PortableLearnedSource;
  verifySource(record: PortableLearnedSource): void;
  answer(input: { requestText: string; sources: readonly PortableLearnedSource[] }): PortableEvidenceAnswer;
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function createPortableCognitiveRuntime(options: { idFactory?: IdFactory } = {}): PortableCognitiveRuntime {
  const idFactory = options.idFactory ?? createIdFactory({
    clock: createClock(),
    hasher: createHasher(),
    namespace: "scce-browser-portable-v1"
  });
  const language = createLanguageAcquisitionEngine({ idFactory });
  const proofCarryingAnswer = createProofCarryingAnswer();

  function learnSource(input: PortableLearnSourceInput): PortableLearnedSource {
    if (!input.namespace.trim()) throw new Error("source namespace is required");
    if (!input.canonicalUri.trim()) throw new Error("canonical source URI is required");
    if (!input.mediaType.trim()) throw new Error("source media type is required");
    if (!Number.isSafeInteger(input.observedAt) || input.observedAt < 0) throw new Error("source observedAt must be a non-negative integer");
    if (input.sourceBytes.byteLength < 1) throw new Error("source bytes cannot be empty");

    const sourceBytes = input.sourceBytes.slice();
    const text = utf8Decoder.decode(sourceBytes);
    const sourceId = idFactory.sourceId(input.namespace, input.canonicalUri);
    const contentHash = idFactory.contentHash(sourceBytes);
    const sourceVersionId = ownedSourceVersionId(idFactory, sourceId, contentHash);
    const chunkId = idFactory.chunkId({ sourceVersionId, byteStart: 0, byteEnd: sourceBytes.byteLength, chunkHash: contentHash });
    const evidenceId = idFactory.evidenceId({ sourceVersionId, byteStart: 0, byteEnd: sourceBytes.byteLength, spanHash: contentHash });
    const charEnd = [...text].length;
    const sourceTrust: SourceTrust = {
      identity: 1,
      integrity: 1,
      parserReliability: 1,
      directness: 1,
      authority: 0.5,
      freshness: 1,
      independenceGroup: `source:${String(sourceId)}`,
      accessScope: "owner-local",
      licenseStatus: "user-supplied"
    };
    const source: SourceVersion = {
      sourceId,
      sourceVersionId,
      namespace: input.namespace,
      canonicalUri: input.canonicalUri,
      contentHash,
      mediaType: input.mediaType,
      observedAt: input.observedAt,
      byteLength: sourceBytes.byteLength,
      sourceTrust,
      metadata: toJsonValue({
        ...(input.title?.trim() ? { title: input.title.trim() } : {}),
        runtime: "portable-cognitive-runtime.v1",
        exactSourceBytes: true
      }),
      role: "original"
    };
    const evidence: EvidenceSpan = {
      id: evidenceId,
      sourceId,
      sourceVersionId,
      chunkId,
      contentHash,
      mediaType: input.mediaType,
      byteStart: 0,
      byteEnd: sourceBytes.byteLength,
      charStart: 0,
      charEnd,
      text,
      textPreview: sourceTextSurface(text, 1200),
      languageHints: toJsonValue({ acquisition: "language-profile.v1" }),
      scriptHints: toJsonValue({}),
      trustVector: toJsonValue({ sourceTrust }),
      provenance: toJsonValue({
        forceClass: "direct_evidence",
        epistemicState: "promoted",
        canonicalUri: input.canonicalUri,
        sourceVersionId,
        contentHash,
        byteRange: [0, sourceBytes.byteLength],
        charRange: [0, charEnd],
        sourceFamilyId: String(sourceId)
      }),
      features: featureSet(text, 2000),
      status: "promoted",
      alpha: 1,
      observedAt: input.observedAt,
      sourceIdentity: {
        title: input.title?.trim() ?? "",
        identity: input.title?.trim() ?? input.canonicalUri,
        sourceKind: input.mediaType
      }
    };
    const languageProfile = language.acquire({ sourceVersionId, text, createdAt: input.observedAt });
    const learned = { source, sourceBytes, evidence, languageProfile };
    verifySource(learned);
    return learned;
  }

  function verifySource(record: PortableLearnedSource): void {
    const bytes = record.sourceBytes;
    const text = utf8Decoder.decode(bytes);
    const hash = idFactory.contentHash(bytes);
    const version = ownedSourceVersionId(idFactory, record.source.sourceId, hash);
    const evidenceHash = idFactory.contentHash(bytes.slice(record.evidence.byteStart, record.evidence.byteEnd));
    const expectedEvidenceId = idFactory.evidenceId({
      sourceVersionId: version,
      byteStart: record.evidence.byteStart,
      byteEnd: record.evidence.byteEnd,
      spanHash: evidenceHash
    });
    if (record.source.byteLength !== bytes.byteLength) throw new Error("source byte length does not match exact bytes");
    if (String(record.source.sourceVersionId) !== String(version)) throw new Error("source version identity does not match exact bytes");
    if (String(record.source.contentHash) !== String(hash)) throw new Error("source content hash does not match exact bytes");
    if (record.evidence.byteStart !== 0 || record.evidence.byteEnd !== bytes.byteLength) throw new Error("portable evidence must identify the complete exact source");
    if (record.evidence.text !== text) throw new Error("evidence text does not decode from its exact byte range");
    if (record.evidence.charStart !== 0 || record.evidence.charEnd !== [...text].length) throw new Error("evidence character coordinates do not match exact source text");
    if (String(record.evidence.contentHash) !== String(evidenceHash)) throw new Error("evidence content hash does not match exact bytes");
    if (String(record.evidence.id) !== String(expectedEvidenceId)) throw new Error("evidence identity does not match its exact source range");
    if (String(record.languageProfile.sourceVersionId) !== String(version)) throw new Error("language profile is not owned by this source version");
  }

  function answer(input: { requestText: string; sources: readonly PortableLearnedSource[] }): PortableEvidenceAnswer {
    const requestText = input.requestText.trim();
    if (!requestText) throw new Error("request text is required");
    for (const source of input.sources) verifySource(source);
    const candidate = proposeSourceExactEvidenceAnswer({
      requestText,
      selectedEvidence: input.sources.map(source => source.evidence)
    });
    if (!candidate) return { status: "evidence-unavailable", answer: "", evidenceIds: [], proofExcerpts: [], proof: null };
    const claim = localEvidenceAnswerClaimSurface(candidate);
    const proof = proofCarryingAnswer.certify({ answer: claim, evidence: candidate.evidence, force: "observed" });
    const excerpts = localEvidenceAnswerProofExcerpts(candidate).map(excerpt => ({ text: excerpt.text, evidenceId: String(excerpt.evidenceId) }));
    if (!proof.releaseAnswer || proof.admitted.length < 1 || !excerpts.length) {
      return { status: "evidence-unavailable", answer: "", evidenceIds: [], proofExcerpts: [], proof };
    }
    return {
      status: "resolved",
      answer: proof.releaseAnswer,
      evidenceIds: [...new Set(proof.admitted.flatMap(certificate => certificate.citedSpanIds.map(String)))],
      proofExcerpts: excerpts,
      proof
    };
  }

  return { learnSource, verifySource, answer };
}

function ownedSourceVersionId(
  idFactory: IdFactory,
  sourceId: SourceVersion["sourceId"],
  contentHash: SourceVersion["contentHash"]
): SourceVersion["sourceVersionId"] {
  return idFactory.sourceVersionId(canonicalStringify({
    contract: "scce.owned-source-version.v1",
    role: "original",
    sourceId,
    contentHash
  }));
}
