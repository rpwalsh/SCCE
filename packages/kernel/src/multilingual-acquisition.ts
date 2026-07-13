import type { EvidenceSpan, JsonValue, LanguageProfile } from "./types.js";
import { clamp01, entropy, featureSet, mean, symbolizeData, toJsonValue, weightedJaccard } from "./primitives.js";

export const LANGUAGE_ACQUISITION_ACTION_IDS = {
  answer: "lang.acq.action.0d5e7b41",
  answerBounded: "lang.acq.action.94a1c0e8",
  learnThenAnswer: "lang.acq.action.6f28d3b0",
  requestEvidence: "lang.acq.action.b7c40a92"
} as const;

export type LanguageAcquisitionActionId = typeof LANGUAGE_ACQUISITION_ACTION_IDS[keyof typeof LANGUAGE_ACQUISITION_ACTION_IDS];

export interface ScriptSegment {
  script: string;
  text: string;
  charStart: number;
  charEnd: number;
  symbolCount: number;
  entropy: number;
}

export interface LanguageCompetence {
  profileId: string;
  scriptCoverage: number;
  ngramCoverage: number;
  continuationCoverage: number;
  evidenceGrounding: number;
  competence: number;
  confidence: number;
  recommendedAction: LanguageAcquisitionActionId;
}

export interface AlignmentPair {
  leftProfileId: string;
  rightProfileId: string;
  scriptOverlap: number;
  shapeOverlap: number;
  charNgramOverlap: number;
  continuationOverlap: number;
  alignment: number;
}

export interface MultilingualAcquisitionReport {
  inputHash: string;
  segments: ScriptSegment[];
  competence: LanguageCompetence[];
  alignments: AlignmentPair[];
  acquisitionNeeds: Array<{ script: string; priority: number; reason: string; evidenceIds: string[] }>;
  audit: JsonValue;
}

export function createMultilingualAcquisitionEngine(options: { hashText?: (text: string) => string } = {}) {
  const hashText = options.hashText ?? hash32;
  return {
    analyze(input: { text: string; profiles: LanguageProfile[]; evidence: EvidenceSpan[] }): MultilingualAcquisitionReport {
      const segments = segmentByScript(input.text);
      const competence = input.profiles.map(profile => competenceFor(profile, input.evidence, segments)).sort((a, b) => b.competence - a.competence);
      const alignments = pairwiseAlignments(input.profiles).sort((a, b) => b.alignment - a.alignment).slice(0, 128);
      const acquisitionNeeds = needsForSegments(segments, competence, input.evidence);
      return {
        inputHash: hashText(input.text),
        segments,
        competence,
        alignments,
        acquisitionNeeds,
        audit: toJsonValue({
          segments: segments.map(segment => ({ script: segment.script, chars: segment.charEnd - segment.charStart, symbolCount: segment.symbolCount, entropy: segment.entropy })),
          competence: competence.slice(0, 24),
          alignments: alignments.slice(0, 24),
          acquisitionNeeds
        })
      };
    },

    compareProfiles(left: LanguageProfile, right: LanguageProfile): AlignmentPair {
      return align(left, right);
    },

    segment(text: string): ScriptSegment[] {
      return segmentByScript(text);
    }
  };
}

export function segmentByScript(text: string): ScriptSegment[] {
  const chars = [...text.normalize("NFC")];
  const segments: ScriptSegment[] = [];
  let currentScript = "";
  let buffer = "";
  let start = 0;
  const flush = (end: number) => {
    if (!buffer.trim()) {
      buffer = "";
      return;
    }
    const symbols = symbolizeData(buffer);
    segments.push({ script: currentScript || "other", text: buffer, charStart: start, charEnd: end, symbolCount: symbols.length, entropy: symbolEntropy(symbols) });
    buffer = "";
  };
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!;
    const script = /\s/u.test(char) ? currentScript : scriptOf(char);
    if (!currentScript) {
      currentScript = script;
      start = i;
    }
    if (script !== currentScript && !/\s/u.test(char)) {
      flush(i);
      currentScript = script;
      start = i;
    }
    buffer += char;
  }
  flush(chars.length);
  return mergeTinySegments(segments);
}

function competenceFor(profile: LanguageProfile, evidence: EvidenceSpan[], segments: ScriptSegment[]): LanguageCompetence {
  const scriptMass = new Map(profile.scripts.map(item => [item.script, item.mass]));
  const requestedScripts = new Map<string, number>();
  for (const segment of segments) requestedScripts.set(segment.script, (requestedScripts.get(segment.script) ?? 0) + Math.max(1, segment.charEnd - segment.charStart));
  const totalRequested = Math.max(1, [...requestedScripts.values()].reduce((sum, value) => sum + value, 0));
  const scriptCoverage = [...requestedScripts.entries()].reduce((sum, [script, mass]) => sum + (scriptMass.get(script) ?? 0) * mass / totalRequested, 0);
  const profileNgrams = new Set(profile.charNgrams.map(item => item.ngram));
  const requestedNgrams = new Set(segments.flatMap(segment => charNgrams(segment.text.toLowerCase(), 3)));
  const ngramCoverage = requestedNgrams.size ? [...requestedNgrams].filter(ngram => profileNgrams.has(ngram)).length / requestedNgrams.size : 0;
  const continuationCoverage = continuationScore(profile);
  const groundingFeatures = new Set(evidence.flatMap(span => span.features.slice(0, 256)));
  const segmentFeatures = featureSet(segments.map(segment => segment.text).join("\n"), 512);
  const evidenceGrounding = segmentFeatures.length ? segmentFeatures.filter(feature => groundingFeatures.has(feature)).length / segmentFeatures.length : 0;
  const competence = clamp01(0.32 * scriptCoverage + 0.26 * ngramCoverage + 0.18 * continuationCoverage + 0.24 * evidenceGrounding);
  const confidence = clamp01(0.35 * Math.min(1, profile.charNgrams.length / 96) + 0.25 * Math.min(1, profile.symbolShapes.length / 24) + 0.2 * Math.min(1, evidence.length / 12) + 0.2 * (1 - profile.entropy / Math.max(1, profile.entropy + 8)));
  const recommendedAction = competence >= 0.62 && confidence >= 0.48
    ? LANGUAGE_ACQUISITION_ACTION_IDS.answer
    : competence >= 0.38
      ? LANGUAGE_ACQUISITION_ACTION_IDS.answerBounded
      : evidence.length >= 2
        ? LANGUAGE_ACQUISITION_ACTION_IDS.learnThenAnswer
        : LANGUAGE_ACQUISITION_ACTION_IDS.requestEvidence;
  return { profileId: profile.id, scriptCoverage, ngramCoverage, continuationCoverage, evidenceGrounding, competence, confidence, recommendedAction };
}

function pairwiseAlignments(profiles: readonly LanguageProfile[]): AlignmentPair[] {
  const out: AlignmentPair[] = [];
  for (let i = 0; i < profiles.length; i++) {
    for (let j = i + 1; j < profiles.length; j++) out.push(align(profiles[i]!, profiles[j]!));
  }
  return out;
}

function align(left: LanguageProfile, right: LanguageProfile): AlignmentPair {
  const scriptOverlap = weightedJaccard(left.scripts.map(item => item.script), right.scripts.map(item => item.script));
  const shapeOverlap = weightedJaccard(left.symbolShapes.map(item => item.shape), right.symbolShapes.map(item => item.shape));
  const charNgramOverlap = weightedJaccard(left.charNgrams.map(item => item.ngram), right.charNgrams.map(item => item.ngram));
  const continuationOverlap = weightedJaccard(continuations(left), continuations(right));
  const alignment = clamp01(0.28 * scriptOverlap + 0.22 * shapeOverlap + 0.32 * charNgramOverlap + 0.18 * continuationOverlap);
  return { leftProfileId: left.id, rightProfileId: right.id, scriptOverlap, shapeOverlap, charNgramOverlap, continuationOverlap, alignment };
}

function needsForSegments(segments: readonly ScriptSegment[], competence: readonly LanguageCompetence[], evidence: readonly EvidenceSpan[]): MultilingualAcquisitionReport["acquisitionNeeds"] {
  const byScript = new Map<string, { chars: number; entropy: number[] }>();
  for (const segment of segments) {
    const row = byScript.get(segment.script) ?? { chars: 0, entropy: [] };
    row.chars += segment.charEnd - segment.charStart;
    row.entropy.push(segment.entropy);
    byScript.set(segment.script, row);
  }
  const bestCompetence = competence[0]?.competence ?? 0;
  const evidenceIds = evidence.slice(0, 12).map(span => String(span.id));
  return [...byScript.entries()].map(([script, row]) => {
    const priority = clamp01((1 - bestCompetence) * 0.58 + Math.min(1, row.chars / 400) * 0.24 + mean(row.entropy) / 12 * 0.18);
    return { script, priority, reason: `script=${script}; competence=${bestCompetence.toFixed(3)}; chars=${row.chars}`, evidenceIds };
  }).filter(item => item.priority > 0.22).sort((a, b) => b.priority - a.priority);
}

function mergeTinySegments(segments: ScriptSegment[]): ScriptSegment[] {
  if (segments.length <= 1) return segments;
  const out: ScriptSegment[] = [];
  for (const segment of segments) {
    const previous = out[out.length - 1];
    if (previous && segment.script === previous.script && segment.charEnd - segment.charStart < 4) {
      previous.text += segment.text;
      previous.charEnd = segment.charEnd;
      previous.symbolCount += segment.symbolCount;
      previous.entropy = symbolEntropy(symbolizeData(previous.text));
    } else out.push({ ...segment });
  }
  return out;
}

function continuationScore(profile: LanguageProfile): number {
  const c = continuations(profile);
  return clamp01(c.length / 96);
}

function continuations(profile: LanguageProfile): string[] {
  const kn = profile.kneserNey as { summary?: { topContinuations?: Array<{ symbol: string }> }; topContinuation?: Array<[string, number]> } | undefined;
  return [
    ...(kn?.summary?.topContinuations?.map(item => item.symbol) ?? []),
    ...(kn?.topContinuation?.map(item => item[0]) ?? [])
  ].filter(Boolean);
}

function charNgrams(text: string, n: number): string[] {
  const chars = [...text];
  const out: string[] = [];
  for (let i = 0; i <= chars.length - n; i++) out.push(chars.slice(i, i + n).join(""));
  return out;
}

function symbolEntropy(symbols: readonly string[]): number {
  const counts = new Map<string, number>();
  for (const symbol of symbols) counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
  return entropy([...counts.values()]);
}

function scriptOf(char: string): string {
  if (/\p{Script=Latin}/u.test(char)) return "script:Latn";
  if (/\p{Script=Arabic}/u.test(char)) return "script:Arab";
  if (/\p{Script=Hebrew}/u.test(char)) return "script:Hebr";
  if (/\p{Script=Han}/u.test(char)) return "script:Hani";
  if (/\p{Script=Hangul}/u.test(char)) return "script:Hang";
  if (/\p{Script=Hiragana}/u.test(char)) return "script:Hira";
  if (/\p{Script=Katakana}/u.test(char)) return "script:Kana";
  if (/\p{Script=Cyrillic}/u.test(char)) return "script:Cyrl";
  if (/\p{Script=Devanagari}/u.test(char)) return "script:Deva";
  if (/\p{Script=Thai}/u.test(char)) return "script:Thai";
  if (/\p{Script=Greek}/u.test(char)) return "script:Greek";
  if (/\p{Number}/u.test(char)) return "script:Zyyy:number";
  return "script:Zxxx";
}

function hash32(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return `mh_${(h >>> 0).toString(16)}`;
}
