// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { jsonRecord, kernelString } from "./kernel-answer-primitives.js";
import type { EvidenceSpan, JsonValue } from "./types.js";

/**
 * The two axes `sourceKind` could not carry, resolved in one place.
 *
 * `developer_intelligence` said where knowledge came from and nothing about what the file DOES, so production
 * source, a test, a DOM fixture, an example, a README and a package manifest were one kind; and nothing at all
 * recorded whether a proposition is the source speaking about the world or content the source exhibits as an
 * object of its own claims. A test does not assert that Apollo 11 landed on 20 July 1969; it asserts that a
 * function returns true for that string, and the sentence is mentioned rather than used.
 *
 * File role and assertional stance are distinct: a production file can carry a documentary assertion in a
 * comment, and a test file can genuinely assert the expected behaviour of an API. Neither axis is a source kind
 * and neither is a cognitive task type.
 */
export const SOURCE_ARTIFACT_ROLES = [
  "production_source",
  "test_source",
  "fixture",
  "example",
  "documentation",
  "build_tooling",
  "configuration",
  "generated",
  "vendor",
  /** No declaration was found. Distinct from every declared role, and never a synonym for production source. */
  "unknown"
] as const;

export type SourceArtifactRole = typeof SOURCE_ARTIFACT_ROLES[number];

export const ASSERTIONAL_STANCES = [
  "asserted",
  "exhibited",
  "quoted",
  "hypothetical",
  "expected_behavior",
  "negative_control",
  "generated_fixture",
  /** Not measured, which is not the same as not exhibited. */
  "unknown"
] as const;

export type AssertionalStance = typeof ASSERTIONAL_STANCES[number];

/**
 * What decided a role. A path convention may be carried as evidence and may never be the declaration: naming a
 * file a test because its path says so is the string heuristic this axis exists to replace.
 */
export const ARTIFACT_ROLE_DECLARATION_SOURCES = ["project_manifest", "parser", "structural", "path", "none"] as const;

export type ArtifactRoleDeclarationSource = typeof ARTIFACT_ROLE_DECLARATION_SOURCES[number];

export interface SourceArtifactRoleObservation {
  readonly role: SourceArtifactRole;
  readonly source: ArtifactRoleDeclarationSource;
  readonly evidence: readonly string[];
}

export interface SourceArtifactRoleResolution {
  /** The role the project itself declared, or `unknown`. */
  readonly role: SourceArtifactRole;
  readonly declaredBy: ArtifactRoleDeclarationSource;
  /** The manifest, key and pattern that declared it, so the declaration is auditable from the span alone. */
  readonly declaration: readonly string[];
  /** Everything else that was observed about this file's role, carried and never collapsed into the answer. */
  readonly observations: readonly SourceArtifactRoleObservation[];
}

export const UNDECLARED_SOURCE_ARTIFACT_ROLE: SourceArtifactRoleResolution = {
  role: "unknown",
  declaredBy: "none",
  declaration: [],
  observations: []
};

/** Code-point interval, half-open, in the coordinate space of the text evidence spans were cut from. */
export interface ExhibitedRange {
  readonly charStart: number;
  readonly charEnd: number;
}

export interface SpanAssertionalStance {
  /** `exhibited` when the whole span is exhibited content, `asserted` when none of it is, else `unknown`. */
  readonly stance: AssertionalStance;
  /** The exhibited intervals that fall inside this span, in the span's own coordinate space. */
  readonly exhibited: readonly ExhibitedRange[];
  readonly measured: boolean;
  /** Why nothing was measured. Empty when it was. */
  readonly unmeasuredReason: string;
}

const UNMEASURED_STANCE: SpanAssertionalStance = {
  stance: "unknown",
  exhibited: [],
  measured: false,
  unmeasuredReason: "no-exhibited-content-measurement"
};

/**
 * The declared file role carried on a span's provenance.
 *
 * Read from the two places provenance is written, exactly as `resolveEvidenceSourceIdentity` does: the ingestor
 * that writes at the top level and the one that writes under `metadata`. An unrecognised role or declaration
 * source resolves to undeclared rather than being trusted, because a value outside the closed set carries no
 * meaning this contract can honour. Pure.
 */
export function resolveSourceArtifactRole(provenanceJson: JsonValue | undefined): SourceArtifactRoleResolution {
  const provenance = jsonRecord(provenanceJson);
  const metadata = jsonRecord(provenance.metadata);
  const raw = jsonRecord(provenance.artifactRole ?? metadata.artifactRole);
  const declaredBy = declarationSource(kernelString(raw.declaredBy));
  const role = artifactRole(kernelString(raw.role));
  const observations = observationList(raw.observations);
  if (!role || declaredBy === undefined || declaredBy === "none" || declaredBy === "path") {
    return { ...UNDECLARED_SOURCE_ARTIFACT_ROLE, observations };
  }
  return { role, declaredBy, declaration: stringList(raw.declaration), observations };
}

/** The same resolution from a span. Pure. */
export function evidenceSourceArtifactRole(span: EvidenceSpan): SourceArtifactRoleResolution {
  return resolveSourceArtifactRole(span.provenance);
}

/**
 * What a span's own text is, measured against the exhibited intervals the ingestor recorded for its file.
 *
 * A retrieval span is a paragraph-sized chunk, so it is usually neither wholly exhibited nor wholly asserted;
 * the honest span-level answer is the intervals, and the single stance belongs to a proposition. A whole file is
 * never refused here, and a mixed span reports `unknown`, which downstream reasoning may carry. Pure.
 */
export function resolveSpanAssertionalStance(provenanceJson: JsonValue | undefined): SpanAssertionalStance {
  const provenance = jsonRecord(provenanceJson);
  const metadata = jsonRecord(provenance.metadata);
  const block = jsonRecord(provenance.exhibitedContent ?? metadata.exhibitedContent);
  if (block.measured !== true) {
    const reason = kernelString(block.unmeasuredReason);
    return reason ? { ...UNMEASURED_STANCE, unmeasuredReason: reason } : UNMEASURED_STANCE;
  }
  const range = charRange(provenance.charRange);
  if (!range) return { ...UNMEASURED_STANCE, unmeasuredReason: "span-carries-no-char-range" };
  const fileRanges = rangeList(block.ranges);
  const exhibited: ExhibitedRange[] = [];
  for (const candidate of fileRanges) {
    const charStart = Math.max(candidate.charStart, range.charStart);
    const charEnd = Math.min(candidate.charEnd, range.charEnd);
    if (charEnd > charStart) exhibited.push({ charStart: charStart - range.charStart, charEnd: charEnd - range.charStart });
  }
  const width = range.charEnd - range.charStart;
  const covered = exhibited.reduce((sum, item) => sum + (item.charEnd - item.charStart), 0);
  const stance: AssertionalStance = covered === 0 ? "asserted" : covered >= width ? "exhibited" : "unknown";
  return { stance, exhibited, measured: true, unmeasuredReason: "" };
}

/**
 * The stance of one proposition inside a span, which is the question factual commitment actually asks.
 *
 * "Does this proposition have authority to support this claim?" rather than "what kind of file did it come
 * from?". A proposition wholly inside an exhibited interval is mentioned rather than used; one disjoint from
 * every interval is the source speaking. The comparison runs over code points because that is the coordinate
 * space the chunker and the ingestor both record, and it is bounded by the span's own length. Pure.
 */
export function propositionAssertionalStance(span: EvidenceSpan, proposition: string): AssertionalStance {
  const measurement = resolveSpanAssertionalStance(span.provenance);
  if (!measurement.measured) return "unknown";
  const located = locateCodePoints(String(span.text ?? ""), proposition);
  if (!located) return "unknown";
  const inside = measurement.exhibited.some(range => located.charStart >= range.charStart && located.charEnd <= range.charEnd);
  if (inside) return "exhibited";
  const overlaps = measurement.exhibited.some(range => located.charStart < range.charEnd && located.charEnd > range.charStart);
  return overlaps ? "unknown" : "asserted";
}

/** Code-point interval of `needle` inside `haystack`, or undefined when it does not occur. Pure. */
function locateCodePoints(haystack: string, needle: string): ExhibitedRange | undefined {
  const trimmed = needle.trim();
  if (!trimmed) return undefined;
  const utf16Index = haystack.indexOf(trimmed);
  if (utf16Index < 0) return undefined;
  const charStart = [...haystack.slice(0, utf16Index)].length;
  return { charStart, charEnd: charStart + [...trimmed].length };
}

function artifactRole(value: string | undefined): SourceArtifactRole | undefined {
  return SOURCE_ARTIFACT_ROLES.find(role => role === value);
}

function declarationSource(value: string | undefined): ArtifactRoleDeclarationSource | undefined {
  return ARTIFACT_ROLE_DECLARATION_SOURCES.find(source => source === value);
}

function stringList(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.map(item => kernelString(item) ?? "").filter(Boolean) : [];
}

function observationList(value: JsonValue | undefined): SourceArtifactRoleObservation[] {
  if (!Array.isArray(value)) return [];
  const out: SourceArtifactRoleObservation[] = [];
  for (const item of value) {
    const record = jsonRecord(item);
    const role = artifactRole(kernelString(record.role));
    const source = declarationSource(kernelString(record.source));
    if (!role || !source) continue;
    out.push({ role, source, evidence: stringList(record.evidence) });
  }
  return out;
}

function charRange(value: JsonValue | undefined): ExhibitedRange | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const charStart = Number(value[0]);
  const charEnd = Number(value[1]);
  if (!Number.isFinite(charStart) || !Number.isFinite(charEnd) || charEnd <= charStart) return undefined;
  return { charStart, charEnd };
}

function rangeList(value: JsonValue | undefined): ExhibitedRange[] {
  if (!Array.isArray(value)) return [];
  const out: ExhibitedRange[] = [];
  for (const item of value) {
    const range = charRange(item as JsonValue);
    if (range) out.push(range);
  }
  // Literals nest (a template holds expressions holding literals), so overlapping intervals are merged before
  // any coverage is measured; summing them raw would report a span as more exhibited than its own width.
  const sorted = out.sort((left, right) => left.charStart - right.charStart);
  const merged: ExhibitedRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.charStart <= last.charEnd) merged[merged.length - 1] = { charStart: last.charStart, charEnd: Math.max(last.charEnd, range.charEnd) };
    else merged.push(range);
  }
  return merged;
}
