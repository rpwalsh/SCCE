import type { JsonValue } from "./types.js";
import { canonicalStringify, clamp01, featureSet } from "./primitives.js";
import { featureScore, provisionalHeuristicScore, type ScoreTrace } from "./scoring/score-trace.js";

export interface LanguageProfileKey {
  scriptSet: string[];
  direction: "ltr" | "rtl" | "ttb" | string;
  orthographyFingerprint: string;
  charNgramFingerprint: string;
  symbolShapeFingerprint: string;
  punctuationCadence: string;
  boundaryBehavior: string;
  sourceClusterId: string;
}

export interface MultilingualLanguageProfile {
  id: string;
  key: LanguageProfileKey;
  label?: string;
  samples: string[];
  confidence: number;
}

export interface AlignmentAnchor {
  type: "number" | "date" | "name" | "url" | "code" | "formula" | "placeholder";
  text: string;
  positions: Array<{ start: number; end: number }>;
}

export interface AlignmentRecordBase {
  id: string;
  kind: string;
  sourceText: string;
  targetText: string;
  sourceProfileId: string;
  targetProfileId: string;
  evidenceIds: string[];
  score: number;
  alpha: number;
  createdAt: number;
}

export interface LexicalAlignmentRecord extends AlignmentRecordBase {
  kind: "lexical";
  lexicalPairs: Array<{ source: string; target: string; score: number }>;
}

export interface MorphemeAlignmentRecord extends AlignmentRecordBase {
  kind: "morpheme";
  morphemePairs: Array<{ source: string; target: string; score: number }>;
}

export interface PhraseAlignmentRecord extends AlignmentRecordBase {
  kind: "phrase";
  phrasePairs: Array<{ source: string; target: string; score: number }>;
}

export interface FrameAlignmentRecord extends AlignmentRecordBase {
  kind: "frame";
  frameTopologyScore: number;
  semanticClusters: Array<{ sourceFrame: string; targetFrame: string; score: number }>;
}

export type MultilingualTranslationAlignmentRecord = FrameAlignmentRecord;

export interface ConstructAlignmentRecord extends AlignmentRecordBase {
  kind: "construct";
  constructGraphScore: number;
  constructEdges: Array<{ source: string; target: string; weight: number }>;
}

export interface MultilingualRoundTripValidationRecord {
  id: string;
  sourceText: string;
  targetText: string;
  roundTripText: string;
  sourceProfileId: string;
  targetProfileId: string;
  loss: number;
  createdAt: number;
}

export interface MultilingualUserCorrectionAlignmentRecord extends AlignmentRecordBase {
  kind: "correction";
  previousOutput: string;
  correctedOutput: string;
  changedTerms: string[];
  protectedTerms: string[];
  alignmentDelta: number;
}

export type MultilingualTranslationForce = "direct" | "approximate" | "gloss" | "unknown";

export interface MultilingualTranslationPlan {
  sourceText: string;
  targetText: string;
  force: MultilingualTranslationForce;
  lossVector: {
    lexical: number;
    phrase: number;
    frame: number;
    anchor: number;
    hallucination: number;
    roundTrip: number;
  };
  protectedTermPreservation: number;
  alignmentCoverage: number;
  targetFluency: number;
  hallucinationRisk: number;
  roundTripLoss: number;
  evidenceIds: string[];
  uncertainTerms: string[];
  missingAlignments: string[];
  planJson: JsonValue;
  scoreTrace: ScoreTrace[];
}

export interface MultilingualTranslationMemory {
  lexicalAlignments: LexicalAlignmentRecord[];
  corrections: MultilingualUserCorrectionAlignmentRecord[];
}

const BASE_PROFILE_ID = "profile";

export function buildLanguageProfile(text: string, label?: string): MultilingualLanguageProfile {
  const key = profileKeyFromText(text);
  return {
    id: `${BASE_PROFILE_ID}:${hash32(canonicalStringify(key))}`,
    key,
    label,
    samples: [text],
    confidence: 0.72
  };
}

export function profileKeyFromText(text: string): LanguageProfileKey {
  const scriptSet = Array.from(new Set(Array.from(text).map(getScriptCategory))).filter(Boolean);
  const direction = scriptSet.includes("arabic") || scriptSet.includes("hebrew") ? "rtl" : "ltr";
  const orthographyFingerprint = canonicalStringify(
    Array.from(new Set(Array.from(text).filter((ch) => /\p{L}/u.test(ch)))).slice(0, 64).sort()
  );
  const charNgramFingerprint = canonicalStringify(featureSet(text, 64).slice(0, 16));
  const symbolShapeFingerprint = canonicalStringify(
    Array.from(new Set(Array.from(text).filter((ch) => /[^\p{L}\p{N}\s]/u.test(ch)))).sort()
  );
  const punctuationCadence = canonicalStringify(
    [".", ",", "?", "!", ";", ":"].map((symbol) => ({ symbol, count: countOccurrences(text, symbol) })) )
  ;
  const boundaryBehavior = canonicalStringify({
    paragraphs: Math.min(8, (text.match(/\n\n+/g) || []).length),
    sentences: Math.min(8, (text.match(/[.!?]/g) || []).length)
  });
  const sourceClusterId = `cluster:${hash32(`${scriptSet.join(",")}:${direction}:${orthographyFingerprint}:${symbolShapeFingerprint}`)}`;
  return {
    scriptSet,
    direction,
    orthographyFingerprint,
    charNgramFingerprint,
    symbolShapeFingerprint,
    punctuationCadence,
    boundaryBehavior,
    sourceClusterId
  };
}

export function clusterLanguageProfiles(profiles: MultilingualLanguageProfile[]): MultilingualLanguageProfile[] {
  const clusters = new Map<string, MultilingualLanguageProfile>();
  for (const profile of profiles) {
    const key = profile.key.sourceClusterId;
    const existing = clusters.get(key);
    if (!existing) {
      clusters.set(key, { ...profile, confidence: profile.confidence });
    } else {
      existing.samples.push(...profile.samples);
      existing.confidence = clamp01((existing.confidence + profile.confidence) / 2);
    }
  }
  return Array.from(clusters.values());
}

export function extractAlignmentAnchors(text: string): AlignmentAnchor[] {
  const anchors: AlignmentAnchor[] = [];
  anchors.push({ type: "number", text: "", positions: extractPositions(text, /\d+(?:[.,]\d+)?/g) });
  anchors.push({ type: "url", text: "", positions: extractPositions(text, /https?:\/\/[\w\-._~:/?#[\]@!$&'()*+,;=%]+/g) });
  anchors.push({ type: "code", text: "", positions: extractPositions(text, /[`@#]\w+|\w+\(.*?\)|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g) });
  anchors.push({ type: "date", text: "", positions: extractPositions(text, /\d{1,4}[\/\-]\d{1,2}[\/\-]\d{1,4}/g) });
  return anchors.filter((anchor) => anchor.positions.length > 0);
}

export function trainLexicalAlignment(source: string, target: string, sourceProfile: MultilingualLanguageProfile, targetProfile: MultilingualLanguageProfile, evidenceIds: string[] = []): LexicalAlignmentRecord {
  const sourceTokens = tokenizeForAlignment(source);
  const targetTokens = tokenizeForAlignment(target);
  const pairs = new Map<string, { source: string; target: string; score: number }>();
  for (const s of sourceTokens) {
    for (const t of targetTokens) {
      const weight = s.toLowerCase() === t.toLowerCase() ? 1 : tokenSimilarity(s, t);
      if (weight <= 0) continue;
      const key = `${s}↔${t}`;
      const existing = pairs.get(key);
      if (existing) {
        existing.score = clamp01(existing.score + weight * 0.4);
      } else {
        pairs.set(key, { source: s, target: t, score: clamp01(weight * 0.8) });
      }
    }
  }
  return {
    id: `lex:${hash32(source + target + sourceProfile.id + targetProfile.id)}`,
    kind: "lexical",
    sourceText: source,
    targetText: target,
    sourceProfileId: sourceProfile.id,
    targetProfileId: targetProfile.id,
    evidenceIds,
    score: clamp01(mean(Array.from(pairs.values(), (item) => item.score)) || 0),
    alpha: 0.72,
    createdAt: Date.now(),
    lexicalPairs: Array.from(pairs.values()).sort((a, b) => b.score - a.score).slice(0, 128)
  };
}

export function realizeTargetSurface(plan: MultilingualTranslationPlan, lexicalAlignments: LexicalAlignmentRecord[]): MultilingualTranslationPlan {
  const sourceTokens = tokenizeForAlignment(plan.sourceText);
  const replacement = sourceTokens.map((token) => {
    if (looksProtectedAnchor(token)) return token;
    const candidate = findBestAlignment(token, lexicalAlignments);
    if (!candidate) return token;
    if (!isReliableAlignment(token, candidate.target, candidate.score)) return token;
    return candidate.target;
  }).join(" ");
  const uncertainTerms = sourceTokens.filter((token) => {
    if (looksProtectedAnchor(token)) return false;
    const candidate = findBestAlignment(token, lexicalAlignments);
    if (!candidate) return true;
    return !isReliableAlignment(token, candidate.target, candidate.score);
  });
  const alignmentCoverage = sourceTokens.length ? (sourceTokens.length - uncertainTerms.length) / sourceTokens.length : 0;
  const provisional = {
    ...plan,
    targetText: replacement,
    alignmentCoverage: clamp01(alignmentCoverage),
    targetFluency: clamp01(plan.targetFluency + 0.05),
    hallucinationRisk: clamp01(plan.hallucinationRisk + (uncertainTerms.length > 0 ? 0.1 : 0)),
    uncertainTerms,
    missingAlignments: uncertainTerms
  };
  const guarded = applyPreservationGuards(provisional);
  return {
    ...guarded,
    scoreTrace: [...guarded.scoreTrace, ...translationScoreTrace(guarded)]
  };
}

export function buildTranslationPlan(
  sourceText: string,
  sourceProfile: MultilingualLanguageProfile,
  targetProfile: MultilingualLanguageProfile,
  lexicalAlignments: LexicalAlignmentRecord[],
  evidenceIds: string[] = []
): MultilingualTranslationPlan {
  const anchors = extractAlignmentAnchors(sourceText);
  const protectedTermPreservation = clamp01(anchors.length / Math.max(1, sourceText.length / 20));
  const plan: MultilingualTranslationPlan = {
    sourceText,
    targetText: sourceText,
    force: "unknown",
    lossVector: {
      lexical: 0,
      phrase: 0,
      frame: 0,
      anchor: 0,
      hallucination: 0,
      roundTrip: 0
    },
    protectedTermPreservation,
    alignmentCoverage: 0,
    targetFluency: 0.45,
    hallucinationRisk: 0.18,
    roundTripLoss: 0,
    evidenceIds,
    uncertainTerms: [],
    missingAlignments: [],
    scoreTrace: [],
    planJson: toJsonValue({
      sourceProfileId: sourceProfile.id,
      targetProfileId: targetProfile.id,
      anchors: anchors.map((anchor) => ({
        type: anchor.type,
        text: anchor.text,
        positions: anchor.positions.map((position) => ({ start: position.start, end: position.end }))
      })),
      alignmentCount: lexicalAlignments.length
    })
  };
  return realizeTargetSurface(plan, lexicalAlignments);
}

export function applyUserCorrection(
  memory: MultilingualTranslationMemory,
  sourceText: string,
  previousOutput: string,
  correctedOutput: string,
  sourceProfileId: string,
  targetProfileId: string,
  protectedTerms: string[] = []
): MultilingualUserCorrectionAlignmentRecord {
  const changedTerms = diffTokens(previousOutput, correctedOutput);
  const record: MultilingualUserCorrectionAlignmentRecord = {
    id: `cor:${hash32(sourceText + correctedOutput + Date.now())}`,
    kind: "correction",
    sourceText,
    targetText: correctedOutput,
    sourceProfileId,
    targetProfileId,
    evidenceIds: [],
    score: 0.98,
    alpha: 0.95,
    createdAt: Date.now(),
    previousOutput,
    correctedOutput,
    changedTerms,
    protectedTerms,
    alignmentDelta: clamp01(changedTerms.length / Math.max(1, correctedOutput.split(" ").length))
  };
  memory.corrections.push(record);
  return record;
}

export function validateRoundTrip(source: string, roundTrip: string): MultilingualRoundTripValidationRecord {
  const sourceTokens = tokenizeForAlignment(source);
  const roundTripTokens = new Set(tokenizeForAlignment(roundTrip));
  const shared = sourceTokens.filter((token) => roundTripTokens.has(token)).length;
  const loss = 1 - clamp01(sourceTokens.length ? shared / sourceTokens.length : 0);
  return {
    id: `rt:${hash32(source + roundTrip + Date.now())}`,
    sourceText: source,
    targetText: roundTrip,
    roundTripText: roundTrip,
    sourceProfileId: "unknown",
    targetProfileId: "unknown",
    loss,
    createdAt: Date.now()
  };
}

function getScriptCategory(char: string): string {
  const code = char.codePointAt(0) ?? 0;
  if ((code >= 0x0600 && code <= 0x06FF) || (code >= 0x0750 && code <= 0x077F)) return "arabic";
  if ((code >= 0x0400 && code <= 0x04FF) || (code >= 0x0500 && code <= 0x052F)) return "cyrillic";
  if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF)) return "han";
  if ((code >= 0x3040 && code <= 0x309F)) return "hiragana";
  if ((code >= 0x30A0 && code <= 0x30FF)) return "katakana";
  if ((code >= 0xAC00 && code <= 0xD7AF)) return "hangul";
  if ((code >= 0x0000 && code <= 0x00FF)) return "latin";
  return "common";
}

function toJsonValue(value: Record<string, JsonValue>): JsonValue {
  return value as JsonValue;
}

function tokenizeForAlignment(text: string): string[] {
  return Array.from(new Set(text.match(/https?:\/\/\S+|\d{1,4}[\/\-]\d{1,2}[\/\-]\d{1,4}|\p{L}[\p{L}\p{N}_-]*/gu) || [])).slice(0, 128);
}

function extractPositions(text: string, pattern: RegExp) {
  const positions: Array<{ start: number; end: number }> = [];
  const regex = new RegExp(pattern.source, pattern.flags.replace("g", "") + "g");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) {
    positions.push({ start: match.index, end: match.index + match[0].length });
    if (!regex.global) break;
  }
  return positions;
}

function findBestAlignment(token: string, alignments: LexicalAlignmentRecord[]) {
  let best: { source: string; target: string; score: number } | undefined;
  for (const record of alignments) {
    for (const pair of record.lexicalPairs) {
      if (pair.source.toLowerCase() === token.toLowerCase()) {
        if (!best || pair.score > best.score) best = pair;
      }
    }
  }
  return best;
}

function tokenSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a.toLowerCase() === b.toLowerCase()) return 1;
  const common = Array.from(new Set(a.toLowerCase().split("").filter((ch) => b.toLowerCase().includes(ch))));
  return clamp01(common.length / Math.max(a.length, b.length));
}

function diffTokens(left: string, right: string): string[] {
  const leftTokens = tokenizeForAlignment(left);
  const rightTokens = new Set(tokenizeForAlignment(right));
  return leftTokens.filter((token) => !rightTokens.has(token));
}

function countOccurrences(text: string, substring: string): number {
  let count = 0;
  let idx = 0;
  while ((idx = text.indexOf(substring, idx)) !== -1) {
    count += 1;
    idx += substring.length || 1;
  }
  return count;
}

function hash32(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function looksProtectedAnchor(token: string): boolean {
  return /^https?:\/\//i.test(token) || /\d{1,4}[\/\-]\d{1,2}[\/\-]\d{1,4}/.test(token);
}

function isReliableAlignment(source: string, target: string, score: number): boolean {
  const hasUnderscoreToken = source.includes("_") || target.includes("_");
  if (hasUnderscoreToken) return false;
  if (/\d/.test(source) && source !== target) return false;
  return score >= 0.35;
}

function applyPreservationGuards(plan: MultilingualTranslationPlan): MultilingualTranslationPlan {
  const sourceAnchors = extractAnchors(plan.sourceText);
  const targetAnchors = extractAnchors(plan.targetText);
  const missingAnchors = sourceAnchors.filter(anchor => !targetAnchors.includes(anchor));
  if (!missingAnchors.length) return plan;
  const guardedText = restoreAnchors(plan.targetText, missingAnchors);
  return {
    ...plan,
    targetText: guardedText,
    force: "unknown",
    hallucinationRisk: clamp01(plan.hallucinationRisk + 0.2),
    uncertainTerms: [...new Set([...plan.uncertainTerms, ...missingAnchors])],
    missingAlignments: [...new Set([...plan.missingAlignments, ...missingAnchors])],
    lossVector: {
      ...plan.lossVector,
      anchor: clamp01(plan.lossVector.anchor + 0.25),
      hallucination: clamp01(plan.lossVector.hallucination + 0.1)
    }
  };
}

function extractAnchors(text: string): string[] {
  const urls = text.match(/https?:\/\/\S+/giu) ?? [];
  const dates = text.match(/\b\d{1,4}[\/-]\d{1,2}[\/-]\d{1,4}\b/gu) ?? [];
  const numerics = text.match(/\b\d+(?:\.\d+)?\b/g) ?? [];
  const codeish = text.match(/\b[a-zA-Z_]+[a-zA-Z0-9_]*\.[a-zA-Z_]+[a-zA-Z0-9_]*\b/g) ?? [];
  return [...new Set([...urls, ...dates, ...numerics, ...codeish])];
}

function restoreAnchors(target: string, anchors: readonly string[]): string {
  if (!anchors.length) return target;
  return `${target}${target.endsWith(".") ? "" : "."} ${anchors.join(" ")}`.trim();
}

function translationScoreTrace(plan: MultilingualTranslationPlan): ScoreTrace[] {
  const anchorPreservation = clamp01(1 - plan.lossVector.anchor);
  return [
    featureScore({
      value: plan.alignmentCoverage,
      range: [0, 1],
      meaning: "translation lexical/phrase alignment coverage",
      inputs: ["alignmentCoverage"],
      provenance: ["multilingual-translation.ts:realizeTargetSurface"]
    }),
    featureScore({
      value: anchorPreservation,
      range: [0, 1],
      meaning: "translation anchor preservation",
      inputs: ["lossVector.anchor"],
      provenance: ["multilingual-translation.ts:applyPreservationGuards"]
    }),
    provisionalHeuristicScore({
      value: clamp01(0.5 * plan.alignmentCoverage + 0.3 * anchorPreservation + 0.2 * (1 - plan.hallucinationRisk)),
      range: [0, 1],
      meaning: "translation plan confidence heuristic",
      inputs: ["alignmentCoverage", "anchorPreservation", "hallucinationRisk"],
      provenance: ["multilingual-translation.ts:translationScoreTrace"],
      failureModes: ["low_resource_language", "morphology_mismatch", "anchor_noise"]
    })
  ];
}