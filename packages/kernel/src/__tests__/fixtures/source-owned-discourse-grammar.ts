// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { canonicalStringify, createClock, createHasher } from "../../primitives.js";
import { createIdFactory } from "../../ids.js";
import { createLanguageAcquisitionEngine } from "../../language.js";
import type { LanguagePatternRecord } from "../../storage.js";
import type { EvidenceSpan, InformationLabel, JsonValue, SourceVersion } from "../../types.js";

/** Complete retained UD sentences supply annotations; no fixture-authored lexical classifications. */
export async function sourceOwnedDiscourseGrammar(question = false) {
  const readerModule = new URL("../../../../adapters-node/src/ud-lexical-corpus.ts", import.meta.url).href;
  const { readUdLexicalGrammar } = await import(readerModule) as { readUdLexicalGrammar(text: string): {
    languageText: string; patterns: Array<{ key: string; support: number; patternJson: JsonValue;
      ranges: Array<{ start: number; end: number }> }> } };
  const fixture = question ? "../../../../adapters-node/src/__tests__/fixtures/ud-ewt-question-excerpt" : "./ud-ewt-discourse-excerpt";
  const text = readFileSync(new URL(`${fixture}.conllu`, import.meta.url), "utf8");
  const provenance = JSON.parse(readFileSync(new URL(`${fixture}.provenance.json`, import.meta.url), "utf8"));
  const hasher = createHasher();
  if (hasher.digestHex(text) !== provenance.excerptSha256) throw new Error("discourse grammar excerpt hash mismatch");
  const ids = createIdFactory({ hasher, clock: createClock({ fixedTime: 1 }), deterministicReplay: true });
  const sourceId = ids.sourceId("workspace", provenance.sourceUri), annotationSourceVersionId = ids.sourceVersionId(text);
  const parsed = readUdLexicalGrammar(text);
  const informationLabel: InformationLabel = { tenantId: "public", principals: [], compartments: [], exportClass: "public", mergePolicy: "same_owner" };
  const sourceTrust = { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1,
    independenceGroup: provenance.sourceUri as string, accessScope: "public", licenseStatus: provenance.license as string };
  const metadata = { lexiconId: "ud-english-ewt-r2.18", language: "en", license: provenance.license as string, sourceSystem: "workspace" };
  const annotationSource: SourceVersion = { sourceId, sourceVersionId: annotationSourceVersionId,
    namespace: "workspace", canonicalUri: provenance.sourceUri, contentHash: ids.contentHash(text), mediaType: "text/plain",
    observedAt: 1, byteLength: Buffer.byteLength(text), sourceTrust, informationLabel, metadata, role: "original" };
  const sourceVersionId = ids.sourceVersionId(canonicalStringify({ sourceId, contentHash: ids.contentHash(parsed.languageText),
    annotationSourceVersionId, transform: "kernel.source_ud_lexical_grammar.v1" }));
  const source: SourceVersion = { ...annotationSource, sourceVersionId, contentHash: ids.contentHash(parsed.languageText),
    byteLength: Buffer.byteLength(parsed.languageText), role: "evidence-derivative", derivation: { kind: "extracted-text",
      transformId: "kernel.source_ud_lexical_grammar.v1", derivedFromSourceVersionId: annotationSourceVersionId,
      originalCoordinateSpace: "source-bytes", redactionMap: [] } };
  const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId, text: parsed.languageText, createdAt: 1 });
  const spans = new Map<string, EvidenceSpan>();
  for (const pattern of parsed.patterns) for (const range of pattern.ranges) {
    const key = `${range.start}:${range.end}`;
    if (spans.has(key)) continue;
    const surface = text.slice(range.start, range.end), hash = ids.contentHash(surface);
    const byteStart = Buffer.byteLength(text.slice(0, range.start)), byteEnd = byteStart + Buffer.byteLength(surface);
    spans.set(key, {
      id: ids.evidenceId({ sourceVersionId: annotationSourceVersionId, byteStart, byteEnd, spanHash: hash }),
      chunkId: ids.chunkId({ sourceVersionId: annotationSourceVersionId, byteStart, byteEnd, chunkHash: hash }),
      sourceId, sourceVersionId: annotationSourceVersionId, contentHash: hash, mediaType: "text/plain", byteStart, byteEnd,
      charStart: range.start, charEnd: range.end, text: surface, textPreview: surface, languageHints: {}, scriptHints: {},
      trustVector: sourceTrust, provenance: { ...provenance, sourceVersionId: annotationSourceVersionId, sourceKind: "lexical_knowledge" },
      features: [], status: "promoted", alpha: 1, observedAt: 1, informationLabel
    });
  }
  const patterns: LanguagePatternRecord[] = parsed.patterns.map(pattern => ({
    id: ids.semanticId("lexical_grammar", { sourceVersionId, key: pattern.key }), profileId: profile.id,
    patternKind: "semantic_role", support: pattern.support, entropy: 0, updatedAt: 1, informationLabel,
    evidenceIds: pattern.ranges.map(range => spans.get(`${range.start}:${range.end}`)!.id),
    patternJson: { ...pattern.patternJson as object, ...metadata, sourceId, sourceVersionId, profileId: profile.id,
      sourceContentHash: source.contentHash, annotationSourceVersionId, annotationSourceContentHash: annotationSource.contentHash }
  }));
  return { patterns, evidence: [...spans.values()], source, annotationSource, profile };
}
