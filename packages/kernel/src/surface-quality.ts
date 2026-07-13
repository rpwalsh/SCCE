import type { JsonValue } from "./types.js";
import { toJsonValue } from "./primitives.js";

export const SURFACE_QUALITY_KIND_IDS = {
  canned: "sq.kind.2f81c0a4",
  telemetry: "sq.kind.6b9e13d0",
  controlId: "sq.kind.a4507c2e"
} as const;

export const SURFACE_QUALITY_ISSUE_IDS = {
  controlId: "sq.issue.5d0f2a91",
  telemetry: "sq.issue.8c41b7e3",
  certification: "sq.issue.d29a0c64"
} as const;

export const SURFACE_QUALITY_REJECTION_IDS = {
  blockedSurface: "sq.reject.47c8a1e0"
} as const;

export const PUBLIC_SURFACE_STATUS_TOKENS = {
  workspaceAnswerUnsupported: "[scce:workspace.answer.unsupported]"
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
  const normalized = stripPublicSurfaceStatusTokens(normalizeForQuality(text));
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
  return issues;
}

function stripPublicSurfaceStatusTokens(text: string): string {
  return text.replaceAll(PUBLIC_SURFACE_STATUS_TOKENS.workspaceAnswerUnsupported, " ");
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
