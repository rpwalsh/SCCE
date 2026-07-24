import type { JsonValue } from "./types.js";
import { toJsonValue } from "./primitives.js";

export const SURFACE_QUALITY_KIND_IDS = {
  canned: "sq.kind.2f81c0a4",
  telemetry: "sq.kind.6b9e13d0",
  controlId: "sq.kind.a4507c2e",
  degenerate: "sq.kind.c74490b2"
} as const;

export const SURFACE_QUALITY_ISSUE_IDS = {
  controlId: "sq.issue.5d0f2a91",
  telemetry: "sq.issue.8c41b7e3",
  certification: "sq.issue.d29a0c64",
  repeatedNgram: "sq.issue.0ef857db"
} as const;

export const SURFACE_QUALITY_REJECTION_IDS = {
  blockedSurface: "sq.reject.47c8a1e0"
} as const;

export type SurfaceQualityIssueKind = typeof SURFACE_QUALITY_KIND_IDS[keyof typeof SURFACE_QUALITY_KIND_IDS];

export interface SurfaceQualityIssue {
  id: string;
  kind: SurfaceQualityIssueKind;
  severity: "reject";
  matched: string;
  trace: JsonValue;
}

const CONTROL_ID_PATTERN = /\b(?:surface|mouth|force|pca|scce|workspace|kernel|planner|proof|runtime)\.[a-z0-9_.-]{2,}\b/gu;
const SNAKE_CONTROL_PATTERN = /\b(?:unsupported_prior_only|learned_prior_summary|import_bound|certified_factual_proof|direct_source_spans_unavailable)\b/gu;
const STATUS_TOKEN_PATTERN = /\[scce:[^\]\s]+(?:\s+[^\]]*)?\]/gu;
const LOCALIZATION_KEY_PATTERN = /\bi18n:[a-z0-9_.:-]+\b/gu;
const PROOF_MARKER_PATTERN = /^\s*\[(?:proof|no_proof)\]\s*/giu;
const SYMBOLIC_CONSTRUCT_PATTERN = /(?:[^\s]+\s*[\u{2192}\u{21d2}\u{21e2}]\s*){2,}|(?:\s\u{00b7}\s[^\s]+){2,}/gu;
const TELEMETRY_TERMS = [
  "active import run",
  "import run",
  "graph node",
  "graph edge",
  "hyperedge",
  "shard count",
  "prior count",
  "direct evidence count",
  "language prior count",
  "program prior count",
  "profile excerpt evidence count"
] as const;

export function detectCannedAnswerSpeech(text: string): SurfaceQualityIssue[] {
  const normalized = normalizeForQuality(text);
  const issues: SurfaceQualityIssue[] = [];
  const add = (id: string, kind: SurfaceQualityIssueKind, matched: string, trace: JsonValue = {}) => {
    if (!issues.some(issue => issue.id === id)) issues.push({ id, kind, severity: "reject", matched, trace });
  };
  const controlIds = [...normalized.matchAll(CONTROL_ID_PATTERN)].map(match => match[0]);
  const snakeIds = [...normalized.matchAll(SNAKE_CONTROL_PATTERN)].map(match => match[0]);
  if (controlIds.length || snakeIds.length) {
    add(SURFACE_QUALITY_ISSUE_IDS.controlId, SURFACE_QUALITY_KIND_IDS.controlId, [...controlIds, ...snakeIds].slice(0, 4).join(" "), toJsonValue({ controlIds: controlIds.slice(0, 16), snakeIds: snakeIds.slice(0, 16) }));
  }
  const statusTokens = [...normalized.matchAll(STATUS_TOKEN_PATTERN)].map(match => match[0]);
  if (statusTokens.length) {
    add(SURFACE_QUALITY_ISSUE_IDS.certification, SURFACE_QUALITY_KIND_IDS.canned, statusTokens.slice(0, 4).join(" "), toJsonValue({ detector: "sq.det.6a1f8074", statusTokens: statusTokens.slice(0, 16) }));
  }
  const localizationKeys = [...normalized.matchAll(LOCALIZATION_KEY_PATTERN)].map(match => match[0]);
  const proofMarkers = [...normalized.matchAll(PROOF_MARKER_PATTERN)].map(match => match[0]);
  const symbolicConstructs = [...normalized.matchAll(SYMBOLIC_CONSTRUCT_PATTERN)].map(match => match[0]);
  if (localizationKeys.length || proofMarkers.length || symbolicConstructs.length) {
    add(
      SURFACE_QUALITY_ISSUE_IDS.controlId,
      SURFACE_QUALITY_KIND_IDS.controlId,
      [...localizationKeys, ...proofMarkers, ...symbolicConstructs].slice(0, 4).join(" "),
      toJsonValue({ localizationKeys: localizationKeys.slice(0, 16), proofMarkers: proofMarkers.slice(0, 16), symbolicConstructs: symbolicConstructs.slice(0, 16) })
    );
  }
  const telemetryHits = TELEMETRY_TERMS.filter(term => normalized.includes(term));
  const numericInventory = /\b\d+\b/u.test(normalized);
  if (telemetryHits.length >= 3 && numericInventory) {
    add(SURFACE_QUALITY_ISSUE_IDS.telemetry, SURFACE_QUALITY_KIND_IDS.telemetry, telemetryHits.slice(0, 4).join("; "), toJsonValue({ telemetryHits, numericInventory }));
  }
  const certificationBoilerplate =
    (normalized.includes("cannot certify") && (normalized.includes("external factual claim") || normalized.includes("available evidence") || normalized.includes("direct evidence"))) ||
    (normalized.includes("no sentence certified") && normalized.includes("available evidence")) ||
    (normalized.includes("hydrated brain") && normalized.includes("active import run"));
  if (certificationBoilerplate) {
    add(SURFACE_QUALITY_ISSUE_IDS.certification, SURFACE_QUALITY_KIND_IDS.canned, boundedMatchedText(normalized), toJsonValue({ detector: "sq.det.1e4b9a70" }));
  }
  const repeatedNgram = concentratedRepeatedNgram(normalized);
  if (repeatedNgram) {
    add(
      SURFACE_QUALITY_ISSUE_IDS.repeatedNgram,
      SURFACE_QUALITY_KIND_IDS.degenerate,
      repeatedNgram.ngram.join(" "),
      toJsonValue({
        detector: "sq.det.3a7d1e42",
        lexicalTokenCount: repeatedNgram.lexicalTokenCount,
        uniqueTokenRatio: repeatedNgram.uniqueTokenRatio,
        ngramSize: repeatedNgram.ngram.length,
        nonOverlappingOccurrences: repeatedNgram.nonOverlappingOccurrences,
        repeatedTokenCoverage: repeatedNgram.repeatedTokenCoverage,
        residualTokenCount: repeatedNgram.residualTokenCount,
        mixedPunctuationRun: repeatedNgram.mixedPunctuationRun
      })
    );
  }
  return issues;
}

interface RepeatedNgramConcentration {
  ngram: string[];
  lexicalTokenCount: number;
  uniqueTokenRatio: number;
  nonOverlappingOccurrences: number;
  repeatedTokenCoverage: number;
  residualTokenCount: number;
  mixedPunctuationRun: string;
}

/**
 * Rejects only high-confidence cyclic surfaces. Two clean repetitions remain
 * admissible for labels and rhetoric; a short two-cycle is rejected only when
 * it leaves stray lexical material and ends in a mixed punctuation run.
 */
function concentratedRepeatedNgram(text: string): RepeatedNgramConcentration | undefined {
  const tokens = [...text.matchAll(/[\p{Letter}\p{Mark}\p{Number}_]+/gu)]
    .map(match => match[0])
    .slice(0, 128);
  if (tokens.length < 4) return undefined;
  const uniqueTokenRatio = new Set(tokens).size / tokens.length;
  const punctuationRuns = [...text.matchAll(/[\p{Punctuation}\p{Symbol}]+/gu)].map(match => match[0]);
  const mixedPunctuationRun = punctuationRuns.find(run => new Set([...run]).size > 1) ?? "";
  const candidates: RepeatedNgramConcentration[] = [];
  const maximumNgramSize = Math.min(6, Math.floor(tokens.length / 2));
  for (let ngramSize = 2; ngramSize <= maximumNgramSize; ngramSize++) {
    const positionsByNgram = new Map<string, number[]>();
    for (let index = 0; index + ngramSize <= tokens.length; index++) {
      const ngram = tokens.slice(index, index + ngramSize);
      const key = ngram.join("\u0001");
      const positions = positionsByNgram.get(key) ?? [];
      positions.push(index);
      positionsByNgram.set(key, positions);
    }
    for (const [key, positions] of positionsByNgram) {
      const nonOverlapping: number[] = [];
      for (const position of positions) {
        const previous = nonOverlapping.at(-1);
        if (previous === undefined || position >= previous + ngramSize) nonOverlapping.push(position);
      }
      if (nonOverlapping.length < 2) continue;
      const repeatedTokenCoverage = nonOverlapping.length * ngramSize / tokens.length;
      const residualTokenCount = tokens.length - nonOverlapping.length * ngramSize;
      const ngram = key.split("\u0001");
      const meanTokenLength = ngram.reduce((sum, token) => sum + [...token].length, 0) / ngram.length;
      const excessiveCycle = nonOverlapping.length >= 3
        && repeatedTokenCoverage >= 0.6
        && uniqueTokenRatio <= 0.55;
      const malformedShortCycle = tokens.length <= 12
        && nonOverlapping.length === 2
        && repeatedTokenCoverage >= 0.7
        && residualTokenCount >= 1
        && residualTokenCount <= 2
        && uniqueTokenRatio <= 0.65
        && meanTokenLength <= 4
        && Boolean(mixedPunctuationRun);
      if (!excessiveCycle && !malformedShortCycle) continue;
      candidates.push({
        ngram,
        lexicalTokenCount: tokens.length,
        uniqueTokenRatio,
        nonOverlappingOccurrences: nonOverlapping.length,
        repeatedTokenCoverage,
        residualTokenCount,
        mixedPunctuationRun
      });
    }
  }
  return candidates.sort((left, right) =>
    right.repeatedTokenCoverage - left.repeatedTokenCoverage
    || right.ngram.length - left.ngram.length
    || left.ngram.join("\u0001").localeCompare(right.ngram.join("\u0001"))
  )[0];
}

function normalizeForQuality(text: string): string {
  let out = "";
  let pendingSpace = false;
  for (const char of text.normalize("NFKC").toLocaleLowerCase()) {
    if (isWhitespace(char)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) out += " ";
    pendingSpace = false;
    out += char;
  }
  return out.trim();
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f" || char === "\v";
}

function boundedMatchedText(text: string): string {
  return text.length <= 160 ? text : `${text.slice(0, 157)}...`;
}
