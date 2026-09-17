// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { jsonRecord, kernelString } from "./kernel-answer-primitives.js";
import type { EvidenceSpan, JsonValue } from "./types.js";

/**
 * The licence a corpus declares for itself, carried on provenance beside the file role.
 *
 * An ingested repository's spans can be cited verbatim and its constructions shape generated wording, so which
 * licence a span came from is a property of the answer rather than acquisition bookkeeping. It is recorded at
 * the producer, from the repository's own machine-readable declarations, never inferred from licence prose.
 *
 * A licence that could not be read is undeclared, which is a measurement that was not made and is therefore not
 * a permission. The reason it could not be read is carried rather than collapsed, so the difference between
 * "this project declares nothing", "this project declares something this reader has no parser for" and "this
 * project declares two conflicting things" survives to whoever has to decide policy.
 *
 * This axis is provenance. It is not a source kind, not a cognitive task type, and not a retrieval gate.
 */
export const LICENSE_DECLARATION_SOURCES = [
  /** A package manifest's own licence field. */
  "package_manifest",
  /** An SPDX identifier tag inside the project's licence file. */
  "license_file",
  /** An SPDX document's declared package licence. */
  "spdx_document",
  /** Nothing readable declared one. */
  "none"
] as const;

export type LicenseDeclarationSource = typeof LICENSE_DECLARATION_SOURCES[number];

export interface SourceLicenseObservation {
  /** The identifier as declared, never normalized into a family or a policy class. */
  readonly license: string;
  readonly source: LicenseDeclarationSource;
  readonly evidence: readonly string[];
}

export interface UnreadableLicenseDeclaration {
  /** Repository-relative file the declaration was expected in. */
  readonly file: string;
  /** The field or tag it was expected under. */
  readonly key: string;
  readonly reason: string;
}

export interface SourceDeclaredLicenseResolution {
  /** The declared identifier verbatim. Empty exactly when nothing readable declared one. */
  readonly license: string;
  readonly declaredBy: LicenseDeclarationSource;
  /** The file, key and value that declared it, so the declaration is auditable from the span alone. */
  readonly declaration: readonly string[];
  /** Every other licence seen, including ones a lower-authority or ambiguous source carried. */
  readonly observations: readonly SourceLicenseObservation[];
  /** Why a declaration that exists could not be read. Carried forward, never a verdict. */
  readonly unreadable: readonly UnreadableLicenseDeclaration[];
}

export const UNDECLARED_SOURCE_LICENSE: SourceDeclaredLicenseResolution = {
  license: "",
  declaredBy: "none",
  declaration: [],
  observations: [],
  unreadable: []
};

/** Whether a resolution names a licence at all. Undeclared is not a licence and is never a permission. Pure. */
export function isLicenseDeclared(resolution: SourceDeclaredLicenseResolution): boolean {
  return resolution.declaredBy !== "none" && resolution.license.length > 0;
}

/**
 * The declared licence carried on a span's provenance.
 *
 * Read from the two places provenance is written, exactly as `resolveSourceArtifactRole` does: the ingestor that
 * writes at the top level and the one that writes under `metadata`. A declaration source outside the closed set
 * resolves to undeclared, because a value this contract cannot honour carries no meaning. Pure.
 */
export function resolveSourceDeclaredLicense(provenanceJson: JsonValue | undefined): SourceDeclaredLicenseResolution {
  const provenance = jsonRecord(provenanceJson);
  const metadata = jsonRecord(provenance.metadata);
  const raw = jsonRecord(provenance.license ?? metadata.license);
  const declaredBy = declarationSource(kernelString(raw.declaredBy));
  const license = kernelString(raw.license)?.trim() ?? "";
  const observations = observationList(raw.observations);
  const unreadable = unreadableList(raw.unreadable);
  if (!declaredBy || declaredBy === "none" || !license) {
    return { ...UNDECLARED_SOURCE_LICENSE, observations, unreadable };
  }
  return { license, declaredBy, declaration: stringList(raw.declaration), observations, unreadable };
}

/** The same resolution from a span. Pure. */
export function evidenceSourceDeclaredLicense(span: EvidenceSpan): SourceDeclaredLicenseResolution {
  return resolveSourceDeclaredLicense(span.provenance);
}

function declarationSource(value: string | undefined): LicenseDeclarationSource | undefined {
  return LICENSE_DECLARATION_SOURCES.find(source => source === value);
}

function stringList(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.map(item => kernelString(item) ?? "").filter(Boolean) : [];
}

function observationList(value: JsonValue | undefined): SourceLicenseObservation[] {
  if (!Array.isArray(value)) return [];
  const out: SourceLicenseObservation[] = [];
  for (const item of value) {
    const record = jsonRecord(item);
    const license = kernelString(record.license)?.trim();
    const source = declarationSource(kernelString(record.source));
    if (!license || !source) continue;
    out.push({ license, source, evidence: stringList(record.evidence) });
  }
  return out;
}

function unreadableList(value: JsonValue | undefined): UnreadableLicenseDeclaration[] {
  if (!Array.isArray(value)) return [];
  const out: UnreadableLicenseDeclaration[] = [];
  for (const item of value) {
    const record = jsonRecord(item);
    const reason = kernelString(record.reason);
    if (!reason) continue;
    out.push({ file: kernelString(record.file) ?? "", key: kernelString(record.key) ?? "", reason });
  }
  return out;
}
