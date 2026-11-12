// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { isAlias, parseDocument, visit } from "yaml";
import { anchorSymbolUnits } from "./primitives.js";
import type { LearnedRequestOmittedSlotAudit, LearnedRequestOmittedSlotDemand } from "./source-construction-request-binding.js";
import type { RequestValueResolver, ResolvedRequestValue } from "./semantic-answer-construct.js";
import { normalizeCanonicalSurface } from "./normalization-contract.js";
import type { EvidenceSpan } from "./types.js";

const MAX_STRUCTURED_SOURCE_CHARS = 2 * 1024 * 1024;
const MAX_STRUCTURED_NODES = 32_768;
const MAX_STRUCTURED_CANDIDATES = 8_192;
const MAX_SCALAR_CHARS = 512;

type StructuredScalar = string | number | boolean;
type StructuredValue = StructuredScalar | null | StructuredValue[] | { [key: string]: StructuredValue };

interface StructuredContextValue { key: string; value: string }
interface StructuredCandidate { key: string; value: string; path: string[]; context: StructuredContextValue[] }
interface CandidateMatch { span: EvidenceSpan; candidate: StructuredCandidate; selector: StructuredContextValue; subject: string; ownerScore: number }
interface StructuredCandidateCollection { candidates: StructuredCandidate[]; complete: boolean }

function scalarSurface(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return undefined;
  const surface = String(value).normalize("NFC").trim();
  return surface && [...surface].length <= MAX_SCALAR_CHARS ? surface : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function structuredMediaKind(span: EvidenceSpan): "json" | "yaml" | undefined {
  const mediaType = String(span.mediaType ?? "").toLocaleLowerCase();
  const provenance = record(span.provenance);
  const uri = String(provenance.uri ?? provenance.canonicalUri ?? provenance.relativePath ?? "").toLocaleLowerCase();
  if (mediaType.includes("json") || /\.json(?:$|[?#])/u.test(uri)) return "json";
  if (mediaType.includes("yaml") || /\.ya?ml(?:$|[?#])/u.test(uri)) return "yaml";
  return undefined;
}

function isStructuredValue(value: unknown, remaining = { count: MAX_STRUCTURED_NODES }): value is StructuredValue {
  remaining.count--;
  if (remaining.count < 0) return false;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(item => isStructuredValue(item, remaining));
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.entries(value).every(([key, item]) => Boolean(key) && isStructuredValue(item, remaining));
}

function parseStructuredSource(span: EvidenceSpan): StructuredValue | undefined {
  const kind = structuredMediaKind(span);
  const text = String(span.text ?? span.textPreview ?? "");
  if (!kind || !text || [...text].length > MAX_STRUCTURED_SOURCE_CHARS) return undefined;
  try {
    const value: unknown = kind === "json"
      ? JSON.parse(text)
      : (() => {
          const document = parseDocument(text, { uniqueKeys: true });
          if (document.errors.length) return undefined;
          let alias = false;
          visit(document, (_key, node) => { if (isAlias(node)) alias = true; });
          if (alias) return undefined;
          return document.toJS({ maxAliasCount: 0 });
        })();
    return isStructuredValue(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Candidate context is deliberately only the same map/list item's scalar siblings. */
function collectCandidates(root: StructuredValue): StructuredCandidateCollection {
  const candidates: StructuredCandidate[] = [];
  const append = (candidate: StructuredCandidate): boolean => {
    if (candidates.length >= MAX_STRUCTURED_CANDIDATES) return false;
    candidates.push(candidate); return true;
  };
  const visitValue = (value: StructuredValue, path: string[], parentKey?: string): boolean => {
    const scalar = scalarSurface(value);
    if (scalar !== undefined) {
      return !parentKey || append({ key: parentKey, value: scalar, path, context: [] });
    }
    if (value === null) return true;
    if (Array.isArray(value)) {
      for (const item of value) if (!visitValue(item, path, parentKey)) return false;
      return true;
    }
    const entries = Object.entries(value);
    const localScalars = entries.flatMap(([key, item]) => {
      const surface = scalarSurface(item);
      return surface === undefined ? [] : [{ key, value: surface }];
    });
    for (const [key, item] of entries) {
      const surface = scalarSurface(item);
      if (surface !== undefined) {
        if (!append({ key, value: surface, path: [...path, key], context: localScalars.filter(row => row.key !== key) })) return false;
      } else if (!visitValue(item, [...path, key], key)) return false;
    }
    return true;
  };
  const complete = visitValue(root, []);
  return { candidates, complete };
}

function orderedUnits(surface: string): string[] {
  return anchorSymbolUnits(surface).map(unit => normalizeCanonicalSurface(unit)).filter(Boolean);
}

function contiguousUnitBinding(surface: string, learnedSurface: string): boolean {
  const value = orderedUnits(surface), learned = orderedUnits(learnedSurface);
  return value.length > 0 && learned.some((_, start) => value.every((unit, offset) => learned[start + offset] === unit));
}

function contiguousBindings(surface: string, learnedSurfaces: readonly string[]): string[] {
  return learnedSurfaces.filter(learned => contiguousUnitBinding(surface, learned));
}

function provenanceUnits(span: EvidenceSpan): string[] {
  const provenance = record(span.provenance), metadata = record(provenance.metadata);
  return orderedUnits([provenance.title, provenance.identity, provenance.uri, provenance.canonicalUri, provenance.relativePath,
    metadata.title, metadata.identity, metadata.relativePath].filter(value => typeof value === "string").map(value => {
      try { return decodeURIComponent(String(value)); } catch { return String(value); }
    }).join(" "));
}

function requestMatchesDemand(requestText: string, demand: LearnedRequestOmittedSlotDemand): boolean {
  return normalizeCanonicalSurface(requestText.replace(/[.!?\u3002\uFF01\uFF1F]+\s*$/u, "")) === normalizeCanonicalSurface(demand.requestSurface);
}

function matchingSubject(span: EvidenceSpan, demand: LearnedRequestOmittedSlotDemand, selector: StructuredContextValue): string {
  const owner = new Set(provenanceUnits(span));
  const ownerSurface = demand.matchedRoleSurfaces.map(row => row.surface)
    .filter(surface => orderedUnits(surface).some(unit => owner.has(unit)))
    .sort((left, right) => [...right].length - [...left].length || left.localeCompare(right))[0];
  return ownerSurface ?? selector.value;
}

function resolveStructuredValue(demandAudit: LearnedRequestOmittedSlotAudit,
  requestText: string, evidence: readonly EvidenceSpan[]): ResolvedRequestValue | undefined {
  const demand = demandAudit.status === "value_demand" ? demandAudit.demand : undefined;
  if (!demand || !requestMatchesDemand(requestText, demand)) return undefined;
  if (!demand.matchedLiteralSurfaces.length || !demand.matchedRoleSurfaces.length) return undefined;
  const learnedSurfaces = [...demand.matchedLiteralSurfaces, ...demand.matchedRoleSurfaces.map(row => row.surface)];
  const ownerUnits = new Set(demand.matchedRoleSurfaces.flatMap(row => orderedUnits(row.surface)));
  const parsed = evidence.flatMap(span => {
    if (span.status !== "promoted") return [];
    const root = parseStructuredSource(span);
    if (root === undefined) return [];
    const collected = collectCandidates(root);
    return [{ span, ...collected }];
  });
  if (parsed.some(row => !row.complete)) return undefined;
  const requireOwner = parsed.length > 1;
  const matches: CandidateMatch[] = [];
  for (const { span, candidates } of parsed) {
    const ownerScore = [...new Set(provenanceUnits(span))].filter(unit => ownerUnits.has(unit)).length;
    if (requireOwner && ownerScore === 0) continue;
    for (const candidate of candidates) {
      if (contiguousBindings(candidate.key, demand.matchedLiteralSurfaces).length !== 1
        || contiguousBindings(candidate.value, learnedSurfaces).length) continue;
      const selectors = candidate.context.flatMap(item => demand.matchedRoleSurfaces.flatMap(role =>
        contiguousUnitBinding(item.key, role.surface) && contiguousUnitBinding(item.value, role.surface)
          ? [{ item, role }] : []));
      // A target key without a same-record key/value selector does not identify which structured assertion was asked.
      if (selectors.length !== 1) continue;
      matches.push({ span, candidate, selector: selectors[0]!.item, subject: matchingSubject(span, demand, selectors[0]!.item), ownerScore });
    }
  }
  const bestOwnerScore = Math.max(0, ...matches.map(match => match.ownerScore));
  const selected = requireOwner ? matches.filter(match => match.ownerScore === bestOwnerScore) : matches;
  if (selected.length !== 1) return undefined;
  const match = selected[0]!;
  return {
    value: match.candidate.value,
    subject: match.subject,
    relationId: demand.relationId,
    requestedRoleId: demand.requestedRoleId,
    evidenceIds: [String(match.span.id)]
  };
}

/** Resolves a formally parsed JSON/YAML scalar only under a unique learned omitted-slot demand. */
export function structuredSourceRequestValueResolver(demandAudit: LearnedRequestOmittedSlotAudit): RequestValueResolver {
  return { id: "resolver.structured_source", resolve: (requestText, evidence) => resolveStructuredValue(demandAudit, requestText, evidence) };
}
