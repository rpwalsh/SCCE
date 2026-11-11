// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  LANGUAGE_SEGMENTATION_WITNESS_MANIFEST_PATTERN_SCHEMA,
  LANGUAGE_SEGMENTATION_WITNESS_SCHEMA,
  SOURCE_SEGMENTATION_WITNESS_SCHEMA,
  attachSourceSegmentationReplayRecipe,
  canonicalDigestHex,
  canonicalStringify,
  createHasher,
  exportSourceSegmentationReplayRecipe,
  replaySurfaceSegmentationAdjacency,
  validateSourceSegmentationWitness,
  validateSurfaceSegmentationReplayRecipe,
  type NormalizationContract,
  type SourceSegmentationWitness,
  type SurfaceSegmentationReplayRecipe
} from "@scce/kernel";
import {
  DECODED_JSON_BYTE_LEDGER_KEY,
  decodedJsonByteLedger,
  verifyDecodedJsonByteLedger
} from "./decoded-json-byte-ledger.js";

export const SEGMENTATION_WITNESS_ARCHIVE_KEY = "_scceSegmentationWitnessArchive" as const;
export const SOURCE_SEGMENTATION_WITNESS_ARCHIVE_SCHEMA =
  "scce.source_segmentation_witness.postgres_archive.v1" as const;
export const LANGUAGE_SEGMENTATION_MANIFEST_ARCHIVE_SCHEMA =
  "scce.language_segmentation_witness_manifest.postgres_archive.v1" as const;
const hasher = createHasher();

export interface SegmentationArchiveOwnerDocument {
  text: string;
  sourceVersionId: string;
  /** Declared source-role projection; the canonical evidence text remains unchanged. */
  learningText?: string;
}

export interface SegmentationArchiveStorageAccess {
  getOwnerDocuments(ownerDocumentIds: readonly string[]): Promise<ReadonlyMap<string, SegmentationArchiveOwnerDocument>>;
}

export interface SegmentationArchiveValue {
  value: unknown;
  profileId: string;
}

export interface SegmentationArchiveResult {
  value: unknown;
  handled: boolean;
}

interface SourceArchiveReference {
  schema: typeof SOURCE_SEGMENTATION_WITNESS_ARCHIVE_SCHEMA;
  logicalDigest: string;
  replay: SurfaceSegmentationReplayRecipe;
  textView?: "learning";
}

interface ManifestArchiveReference {
  schema: typeof LANGUAGE_SEGMENTATION_MANIFEST_ARCHIVE_SCHEMA;
  logicalDigest: string;
}

interface PreparedSource {
  inputIndex: number;
  logical: SourceSegmentationWitness;
  reference: SourceArchiveReference;
}

/**
 * PostgreSQL storage normalization for the exact source witness.
 *
 * The public witness remains unchanged. Source text is sliced from its
 * evidence-owned document. Replayable DAGs keep only frozen estimator state
 * and count vectors aligned to keys deterministically regenerated from that
 * source. There is no stored-DAG runtime
 * fallback: a source without exact replay state must be re-induced.
 * No graph edge, energy, source scalar, evidence id, owner, or identity is
 * dropped. The full logical digest is checked again after cold hydration.
 */
export async function encodeSegmentationWitnessArchives(
  inputs: readonly SegmentationArchiveValue[],
  storage: SegmentationArchiveStorageAccess
): Promise<SegmentationArchiveResult[]> {
  const results: SegmentationArchiveResult[] = inputs.map(input => ({ value: input.value, handled: false }));
  const sources: PreparedSource[] = [];

  inputs.forEach((input, inputIndex) => {
    const root = record(input.value);
    if (!root) return;
    if (root.schema === SOURCE_SEGMENTATION_WITNESS_SCHEMA) {
      if (Object.hasOwn(root, SEGMENTATION_WITNESS_ARCHIVE_KEY)) fail("source witness is already a physical archive");
      validateSourceSegmentationWitness(input.value);
      const logical = input.value as SourceSegmentationWitness;
      if (Object.keys(logical.fullDag).sort().join(",") !== "factors") fail("source witness full DAG has noncanonical members");
      const replay = exportSourceSegmentationReplayRecipe(logical);
      if (!replay) fail("source segmentation witness lacks exact replay state; re-induction is required");
      const validated = validateSurfaceSegmentationReplayRecipe(replay);
      const reference: SourceArchiveReference = {
        schema: SOURCE_SEGMENTATION_WITNESS_ARCHIVE_SCHEMA,
        logicalDigest: canonicalDigestHex(logical, hasher),
        replay: validated
      };
      sources.push({ inputIndex, logical, reference });
      return;
    }
    if (root.schema === LANGUAGE_SEGMENTATION_WITNESS_MANIFEST_PATTERN_SCHEMA) {
      results[inputIndex] = { value: encodeManifest(root, input.profileId), handled: true };
    }
  });

  const ownerIds = [...new Set(sources.map(source => source.logical.ownerDocumentId))];
  const owners = ownerIds.length ? await storage.getOwnerDocuments(ownerIds) : new Map<string, SegmentationArchiveOwnerDocument>();
  if (owners.size !== ownerIds.length || ownerIds.some(id => !owners.has(id))) {
    fail("segmentation witness archive is missing its evidence-owned document");
  }
  for (const source of sources) {
    const owner = owners.get(source.logical.ownerDocumentId)!;
    if (source.logical.sourceVersionId && owner.sourceVersionId !== source.logical.sourceVersionId) {
      fail("segmentation witness source version differs from its evidence owner");
    }
    if (source.logical.sourceUtf16End > owner.text.length) fail("segmentation witness source range exceeds its evidence owner");
    let text = owner.text.slice(source.logical.sourceUtf16Start, source.logical.sourceUtf16End);
    if (text !== source.logical.text && owner.learningText !== undefined) {
      if (owner.learningText.length !== owner.text.length) fail("segmentation witness learning projection changes source coordinates");
      text = owner.learningText.slice(source.logical.sourceUtf16Start, source.logical.sourceUtf16End);
      source.reference.textView = "learning";
    }
    if (text !== source.logical.text || hasher.digestHex(text) !== source.logical.lattice.textHash) {
      fail("segmentation witness source slice differs from its evidence owner");
    }
  }

  for (const source of sources) {
    const { text: _text, fullDag: _fullDag, ...header } = source.logical;
    results[source.inputIndex] = {
      value: {
        ...header,
        [SEGMENTATION_WITNESS_ARCHIVE_KEY]: source.reference,
        [DECODED_JSON_BYTE_LEDGER_KEY]: decodedJsonByteLedger(source.logical)
      },
      handled: true
    };
  }
  return results;
}

/** Restore exact archives; validated pre-v35 logical rows remain read-only until source re-induction rewrites them. */
export async function decodeSegmentationWitnessArchives(
  inputs: readonly SegmentationArchiveValue[],
  storage: SegmentationArchiveStorageAccess
): Promise<SegmentationArchiveResult[]> {
  const results: SegmentationArchiveResult[] = inputs.map(input => ({ value: input.value, handled: false }));
  const sources: Array<{ inputIndex: number; header: Record<string, unknown>; reference: SourceArchiveReference }> = [];

  inputs.forEach((input, inputIndex) => {
    const root = record(input.value);
    if (!root) return;
    const rawReference = record(root[SEGMENTATION_WITNESS_ARCHIVE_KEY]);
    if (rawReference?.schema === SOURCE_SEGMENTATION_WITNESS_ARCHIVE_SCHEMA) {
      const reference = sourceReference(rawReference);
      exactKeys(root, sourceWireKeys(root.sourceVersionId !== undefined), "source segmentation witness archive");
      sources.push({ inputIndex, header: root, reference });
      return;
    }
    if (rawReference?.schema === LANGUAGE_SEGMENTATION_MANIFEST_ARCHIVE_SCHEMA) {
      results[inputIndex] = { value: decodeManifest(root, input.profileId, manifestReference(rawReference)), handled: true };
      return;
    }
    // Pre-v35 brains already own complete logical witnesses. Keep those rows
    // readable during the storage-format upgrade without pretending that they
    // have replay state: every newly induced write still has to take the
    // compact archive path above, and attempting to rewrite a legacy witness
    // still requires source re-induction in encodeSegmentationWitnessArchives.
    if (root.schema === SOURCE_SEGMENTATION_WITNESS_SCHEMA && typeof root.documentId === "string") {
      validateSourceSegmentationWitness(input.value);
      results[inputIndex] = { value: input.value, handled: true };
      return;
    }
    if (looksLikeLogicalManifest(root)) {
      // encodeManifest performs the strict legacy manifest validation,
      // including source-witness uniqueness and profile-bound pattern ids.
      encodeManifest(root, input.profileId);
      results[inputIndex] = { value: input.value, handled: true };
    }
  });

  const ownerIds = [...new Set(sources.map(source => String(source.header.ownerDocumentId)))];
  const owners = ownerIds.length ? await storage.getOwnerDocuments(ownerIds) : new Map<string, SegmentationArchiveOwnerDocument>();
  if (owners.size !== ownerIds.length || ownerIds.some(id => !owners.has(id))) {
    fail("segmentation witness archive is missing its evidence-owned document");
  }
  for (const source of sources) {
    if (typeof source.header.documentId !== "string" || !source.header.documentId
      || typeof source.header.ownerDocumentId !== "string" || !source.header.ownerDocumentId
      || typeof source.header.sourceFamilyId !== "string" || !source.header.sourceFamilyId
      || !natural(source.header.sourceUtf16Start) || !natural(source.header.sourceUtf16End)
      || source.header.sourceUtf16End < source.header.sourceUtf16Start
      || !Array.isArray(source.header.evidenceIds)
      || !source.header.evidenceIds.every(id => typeof id === "string")) {
      fail("invalid source segmentation witness archive header");
    }
    const owner = owners.get(String(source.header.ownerDocumentId))!;
    if (source.header.sourceVersionId !== undefined && owner.sourceVersionId !== source.header.sourceVersionId) {
      fail("segmentation witness source version differs from its evidence owner");
    }
    if (source.header.sourceUtf16End > owner.text.length) fail("segmentation witness source range exceeds its evidence owner");
    const ownerText = source.reference.textView === "learning" ? owner.learningText : owner.text;
    if (ownerText === undefined || ownerText.length !== owner.text.length) fail("segmentation witness learning projection is missing or changes source coordinates");
    const text = ownerText.slice(source.header.sourceUtf16Start, source.header.sourceUtf16End);
    const lattice = requiredRecord(source.header.lattice, "source segmentation lattice archive");
    if (typeof lattice.textHash !== "string" || hasher.digestHex(text) !== lattice.textHash) {
      fail("segmentation witness source slice differs from its lattice hash");
    }
    const replayRecipe = validateSurfaceSegmentationReplayRecipe(source.reference.replay, hasher);
    const factors = replaySurfaceSegmentationAdjacency({
      recipe: replayRecipe,
      documentId: source.header.documentId,
      sourceFamilyId: source.header.sourceFamilyId,
      text,
      ...(typeof source.header.sourceVersionId === "string" ? { sourceVersionId: source.header.sourceVersionId } : {}),
      evidenceIds: source.header.evidenceIds,
      normalizationContract: lattice.normalizationContract as NormalizationContract,
      hasher
    });
    const {
      [SEGMENTATION_WITNESS_ARCHIVE_KEY]: _reference,
      [DECODED_JSON_BYTE_LEDGER_KEY]: _ledger,
      ...header
    } = source.header;
    const logical = { ...header, text, fullDag: { factors } } as SourceSegmentationWitness;
    validateSourceSegmentationWitness(logical);
    verifyDecodedJsonByteLedger(source.header, logical);
    if (canonicalDigestHex(logical, hasher) !== source.reference.logicalDigest) {
      fail("segmentation witness logical digest changed");
    }
    results[source.inputIndex] = {
      value: attachSourceSegmentationReplayRecipe(logical, replayRecipe),
      handled: true
    };
  }
  return results;
}

export function isSegmentationWitnessArchive(value: unknown): boolean {
  const schema = record(record(value)?.[SEGMENTATION_WITNESS_ARCHIVE_KEY])?.schema;
  return schema === SOURCE_SEGMENTATION_WITNESS_ARCHIVE_SCHEMA
    || schema === LANGUAGE_SEGMENTATION_MANIFEST_ARCHIVE_SCHEMA;
}

function encodeManifest(root: Record<string, unknown>, profileId: string): Record<string, unknown> {
  exactKeys(root, ["schema", "id", "witnessSchema", "populationModelId", "populations", "audit"], "language segmentation manifest");
  if (typeof root.id !== "string" || !root.id || typeof root.populationModelId !== "string" || !root.populationModelId
    || !Array.isArray(root.populations) || root.witnessSchema !== LANGUAGE_SEGMENTATION_WITNESS_SCHEMA) fail("invalid language segmentation manifest");
  const seenWitnesses = new Set<string>();
  const populations = root.populations.map(value => {
    const population = requiredRecord(value, "language segmentation manifest population");
    exactKeys(population, ["populationId", "prior", "sourceWitnesses"], "language segmentation manifest population");
    if (typeof population.populationId !== "string" || !population.populationId || !finiteProbability(population.prior)
      || !Array.isArray(population.sourceWitnesses)) fail("invalid language segmentation manifest population");
    const witnessIds = population.sourceWitnesses.map(value => {
      const source = requiredRecord(value, "language segmentation manifest source");
      exactKeys(source, ["witnessId", "patternId"], "language segmentation manifest source");
      if (typeof source.witnessId !== "string" || !source.witnessId || seenWitnesses.has(source.witnessId)
        || source.patternId !== archivePatternId(source.witnessId, profileId)) fail("invalid language segmentation manifest source");
      seenWitnesses.add(source.witnessId);
      return source.witnessId;
    });
    return { populationId: population.populationId, prior: population.prior, witnessIds };
  });
  const reference: ManifestArchiveReference = {
    schema: LANGUAGE_SEGMENTATION_MANIFEST_ARCHIVE_SCHEMA,
    logicalDigest: canonicalDigestHex(root, hasher)
  };
  return {
    schema: root.schema,
    id: root.id,
    populationModelId: root.populationModelId,
    populations,
    audit: root.audit,
    [SEGMENTATION_WITNESS_ARCHIVE_KEY]: reference,
    [DECODED_JSON_BYTE_LEDGER_KEY]: decodedJsonByteLedger(root)
  };
}

function decodeManifest(root: Record<string, unknown>, profileId: string, reference: ManifestArchiveReference): Record<string, unknown> {
  exactKeys(root, ["schema", "id", "populationModelId", "populations", "audit", SEGMENTATION_WITNESS_ARCHIVE_KEY,
    DECODED_JSON_BYTE_LEDGER_KEY], "language segmentation manifest archive");
  if (root.schema !== LANGUAGE_SEGMENTATION_WITNESS_MANIFEST_PATTERN_SCHEMA || typeof root.id !== "string" || !root.id
    || typeof root.populationModelId !== "string" || !root.populationModelId || !Array.isArray(root.populations)) {
    fail("invalid language segmentation manifest archive");
  }
  const seenWitnesses = new Set<string>();
  const populations = root.populations.map(value => {
    const population = requiredRecord(value, "language segmentation manifest archive population");
    exactKeys(population, ["populationId", "prior", "witnessIds"], "language segmentation manifest archive population");
    if (typeof population.populationId !== "string" || !population.populationId || !finiteProbability(population.prior)
      || !Array.isArray(population.witnessIds)) fail("invalid language segmentation manifest archive population");
    const sourceWitnesses = population.witnessIds.map(witnessId => {
      if (typeof witnessId !== "string" || !witnessId || seenWitnesses.has(witnessId)) {
        fail("invalid language segmentation manifest archive source");
      }
      seenWitnesses.add(witnessId);
      return { witnessId, patternId: archivePatternId(witnessId, profileId) };
    });
    return { populationId: population.populationId, prior: population.prior, sourceWitnesses };
  });
  const logical = {
    schema: root.schema,
    id: root.id,
    witnessSchema: LANGUAGE_SEGMENTATION_WITNESS_SCHEMA,
    populationModelId: root.populationModelId,
    populations,
    audit: root.audit
  };
  if (canonicalDigestHex(logical, hasher) !== reference.logicalDigest) {
    fail("language segmentation manifest logical digest changed");
  }
  verifyDecodedJsonByteLedger(root, logical);
  return logical;
}

function archivePatternId(witnessId: string, profileId: string): string {
  return `segmentation_archive.${hasher.digestHex(canonicalStringify([witnessId, profileId]))}`;
}

function sourceReference(value: Record<string, unknown>): SourceArchiveReference {
  exactKeys(value, ["schema", "logicalDigest", "replay", ...(value.textView !== undefined ? ["textView"] : [])], "source witness archive reference");
  if (value.textView !== undefined && value.textView !== "learning") fail("invalid source witness text view");
  if (value.schema !== SOURCE_SEGMENTATION_WITNESS_ARCHIVE_SCHEMA || !digest(value.logicalDigest)) {
    fail("invalid source witness archive reference");
  }
  const replay = validateSurfaceSegmentationReplayRecipe(value.replay, hasher);
  return { schema: value.schema, logicalDigest: value.logicalDigest, replay,
    ...(value.textView === "learning" ? { textView: "learning" as const } : {}) } as unknown as SourceArchiveReference;
}

function manifestReference(value: Record<string, unknown>): ManifestArchiveReference {
  exactKeys(value, ["schema", "logicalDigest"], "language segmentation manifest archive reference");
  if (value.schema !== LANGUAGE_SEGMENTATION_MANIFEST_ARCHIVE_SCHEMA || !digest(value.logicalDigest)) {
    fail("invalid language segmentation manifest archive reference");
  }
  return value as unknown as ManifestArchiveReference;
}

function sourceWireKeys(hasSourceVersion: boolean): string[] {
  return ["schema", "id", "documentId", "ownerDocumentId", "sourceFamilyId",
    ...(hasSourceVersion ? ["sourceVersionId"] : []), "sourceUtf16Start", "sourceUtf16End", "evidenceIds", "lattice",
    SEGMENTATION_WITNESS_ARCHIVE_KEY, DECODED_JSON_BYTE_LEDGER_KEY];
}

function looksLikeLogicalManifest(root: Record<string, unknown>): boolean {
  return root.schema === LANGUAGE_SEGMENTATION_WITNESS_MANIFEST_PATTERN_SCHEMA
    && typeof root.populationModelId === "string" && Array.isArray(root.populations);
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function natural(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function finiteProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  return record(value) ?? fail(`invalid ${label}`);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  if (Object.keys(value).sort().join(",") !== [...expected].sort().join(",")) fail(`invalid ${label}`);
}

function fail(message: string): never {
  throw new Error(message);
}
