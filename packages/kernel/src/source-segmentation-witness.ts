// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { exportSegmentationAdjacencyFactors } from "./segmentation-forest.js";
import {
  validateSegmentationAdjacencyFactors,
  type SegmentationAdjacencyFactors
} from "./segmentation-adjacency-factors.js";
import {
  validateSegmentationScoreFactors
} from "./segmentation-score-factors.js";
import {
  SURFACE_LATTICE_SCHEMA,
  exportSurfaceSegmentationReplayRecipe,
  validateSurfaceSegmentationReplayRecipe,
  validateSurfaceLattice,
  type SurfaceSegmentationReplayRecipe,
  type SurfaceLattice
} from "./surface-lattice.js";
import type { SegmentationForestLimits } from "./segmentation-forest.js";
import { canonicalGraphemeSegmenter, type NormalizationContract } from "./normalization-contract.js";
import { createHasher, toJsonValue } from "./primitives.js";
import { canonicalDigestHex } from "./canonical-json-digest.js";
import type { Hasher, JsonValue } from "./types.js";

export const SOURCE_SEGMENTATION_WITNESS_SCHEMA =
  "scce.source_segmentation_witness.v2" as const;
export const LANGUAGE_SEGMENTATION_WITNESS_SCHEMA =
  "scce.language_segmentation_witness.v2" as const;
export const SOURCE_SEGMENTATION_FOREST_WITNESS_SCHEMA =
  "scce.source_segmentation_forest_witness.v1" as const;
export const SOURCE_SEGMENTATION_LATTICE_WITNESS_SCHEMA =
  "scce.source_segmentation_lattice_witness.v1" as const;

/**
 * The canonical, non-predictive evidence behind one source segmentation.
 *
 * `fullDag` retains the complete adjacency measure, including arcs that no
 * bounded retained path happened to visit. The bounded path list, boundary
 * marginals, coordinate vector and surface-arc list are deterministic products
 * of the source plus this DAG; persisting them would duplicate producer state.
 *
 * Source text and the source-window UTF-16 range are retained verbatim. Per-
 * grapheme coordinates are reconstructed deterministically from that source.
 * They are evidence, not a language model or a surface-realization fallback.
 */
export interface SourceSegmentationWitness {
  schema: typeof SOURCE_SEGMENTATION_WITNESS_SCHEMA;
  id: string;
  documentId: string;
  ownerDocumentId: string;
  sourceFamilyId: string;
  sourceVersionId?: string;
  sourceUtf16Start: number;
  sourceUtf16End: number;
  text: string;
  evidenceIds: string[];
  lattice: SourceSegmentationLatticeWitness;
  fullDag: {
    factors: SegmentationAdjacencyFactors;
  };
}

const SOURCE_SEGMENTATION_REPLAY = Symbol("scce.source_segmentation_replay");

/** Producer-only replay state for a physical store that replaces, then hydrates, the measured DAG cache. */
export function exportSourceSegmentationReplayRecipe(witness: SourceSegmentationWitness): Readonly<SurfaceSegmentationReplayRecipe> | undefined {
  return (witness as SourceSegmentationWitness & {
    [SOURCE_SEGMENTATION_REPLAY]?: Readonly<SurfaceSegmentationReplayRecipe>;
  })[SOURCE_SEGMENTATION_REPLAY];
}

/** Preserve producer-only state across the logical JSON projection without exposing it on the wire. */
export function transferSourceSegmentationReplayRecipe<T extends object>(
  source: SourceSegmentationWitness,
  target: T
): T {
  const recipe = exportSourceSegmentationReplayRecipe(source);
  if (recipe) Object.defineProperty(target, SOURCE_SEGMENTATION_REPLAY, { value: recipe });
  return target;
}

/** Restore validated producer state after a cold physical archive hydration. */
export function attachSourceSegmentationReplayRecipe<T extends object>(
  target: T,
  recipe: SurfaceSegmentationReplayRecipe,
  hasher: Hasher = createHasher()
): T {
  const validated = validateSurfaceSegmentationReplayRecipe(recipe, hasher);
  Object.defineProperty(target, SOURCE_SEGMENTATION_REPLAY, { value: Object.freeze(validated) });
  return target;
}

export interface SourceSegmentationForestAudit {
  schema: typeof SOURCE_SEGMENTATION_FOREST_WITNESS_SCHEMA;
  id: string;
  latticeId: string;
  estimatorId: string;
  normalizationContractId: string;
  graphemeCount: number;
  pathLimit: number;
  limits: SegmentationForestLimits;
  retainedPathCount: number;
  retainedPathDigest: string;
  boundaryMarginalCount: number;
  boundaryMarginalDigest: string;
  partitionLogZ: number;
  activePartitionLogZ: number;
  retainedPosteriorMass: number;
  omittedPosteriorMass: number;
  prunedArcPosteriorMass: number;
  unretainedDerivationMass: number;
  completion: "complete_within_limits" | "resumable";
  resumeStateDigest?: string;
  audit: JsonValue;
}

/**
 * Evidence-owned sufficient state for exact DAG/forest replay. Rich lattice
 * units repeat canonical identities, boundary vectors, source ids and context
 * strings thousands of times. Those are producer intermediates: the source and
 * exact energy-bearing DAG below own the same learned observation without
 * persisting that denormalized object graph.
 * Forest arrays and source-coordinate indexes are represented by small audit
 * digests and are reconstructed from `text` plus `fullDag` when queried.
 */
export interface SourceSegmentationLatticeWitness {
  schema: typeof SOURCE_SEGMENTATION_LATTICE_WITNESS_SCHEMA;
  id: string;
  sourceSchema: SurfaceLattice["schema"];
  documentId: string;
  sourceFamilyId: string;
  sourceVersionId?: string;
  evidenceIds: string[];
  textHash: string;
  normalizationContract: NormalizationContract;
  populationPosterior: Array<{ populationId: string; probability: number }>;
  sourceUnitCount: number;
  sourceEdgeCount: number;
  segmentationForest: SourceSegmentationForestAudit;
  audit: JsonValue;
}

export interface LanguageSegmentationWitness {
  schema: typeof LANGUAGE_SEGMENTATION_WITNESS_SCHEMA;
  id: string;
  populationModelId: string;
  populations: Array<{
    populationId: string;
    prior: number;
    documents: SourceSegmentationWitness[];
  }>;
  audit: JsonValue;
}

export interface LanguageSegmentationWitnessDocument {
  documentId: string;
  sourceFamilyId?: string;
  sourceVersionId?: string;
  sourceWindow?: {
    ownerDocumentId: string;
    startUtf16: number;
    endUtf16: number;
  };
  text: string;
  evidenceIds?: readonly string[];
  lattice: SurfaceLattice;
}

/** Compile durable source evidence only; this function learns no join surface. */
export function compileLanguageSegmentationWitness(input: {
  populationModelId: string;
  populations: readonly {
    populationId: string;
    prior: number;
    documents: readonly LanguageSegmentationWitnessDocument[];
  }[];
  hasher?: Hasher;
}): LanguageSegmentationWitness {
  const hasher = input.hasher ?? createHasher();
  if (!input.populationModelId) throw new Error("segmentation witness requires a population model id");
  const documentIds = new Set<string>();
  // A final population refit can collapse two selected components onto the
  // same content-addressed population id.  They are then the same component,
  // not two competing populations.  Preserve every assigned source document
  // while coalescing that duplicate identity and its prior mass.
  const populationById = new Map<string, {
    populationId: string;
    prior: number;
    documents: LanguageSegmentationWitnessDocument[];
  }>();
  for (const population of input.populations) {
    if (!population.populationId || !Number.isFinite(population.prior) || population.prior < 0 || population.prior > 1) {
      throw new Error("segmentation witness has an invalid population");
    }
    const existing = populationById.get(population.populationId);
    if (existing) {
      existing.prior += population.prior;
      existing.documents.push(...population.documents);
    } else {
      populationById.set(population.populationId, {
        populationId: population.populationId,
        prior: population.prior,
        documents: [...population.documents]
      });
    }
  }
  const populations = [...populationById.values()]
    .sort((left, right) => left.populationId.localeCompare(right.populationId))
    .map(population => {
      if (!Number.isFinite(population.prior) || population.prior < 0 || population.prior > 1 + 1e-9) {
        throw new Error("segmentation witness has an invalid population");
      }
      const documents = [...population.documents]
        .sort((left, right) => left.documentId.localeCompare(right.documentId))
        .map(document => {
          if (documentIds.has(document.documentId)) throw new Error(`segmentation witness repeats document ${document.documentId}`);
          documentIds.add(document.documentId);
          return compileSourceWitness(document, hasher);
        });
      return { populationId: population.populationId, prior: Math.min(1, population.prior), documents };
    });
  const canonical = {
    schema: LANGUAGE_SEGMENTATION_WITNESS_SCHEMA,
    populationModelId: input.populationModelId,
    populations
  };
  const identity = {
    schema: LANGUAGE_SEGMENTATION_WITNESS_SCHEMA,
    populationModelId: input.populationModelId,
    populations: populations.map(population => ({
      populationId: population.populationId,
      prior: population.prior,
      documentIds: population.documents.map(document => document.id)
    }))
  };
  return {
    ...canonical,
    id: `language_segmentation_witness.${canonicalDigestHex(identity, hasher).slice(0, 40)}`,
    audit: toJsonValue({
      compiler: "kernel.language_segmentation_witness.v2",
      representation: "source_observation_plus_full_dag_sufficient_state",
      populationCount: populations.length,
      inputPopulationCount: input.populations.length,
      coalescedPopulationCount: input.populations.length - populations.length,
      documentCount: documentIds.size,
      fullDagArcCount: populations.reduce((total, population) => total
        + population.documents.reduce((sum, document) => sum + document.fullDag.factors.arcs.length, 0), 0),
      retainedPathCount: populations.reduce((total, population) => total
        + population.documents.reduce((sum, document) => sum + document.lattice.segmentationForest.retainedPathCount, 0), 0),
      exactSourceCoordinates: true,
      predictiveSurfaceModel: false
    })
  };
}

export function validateLanguageSegmentationWitness(value: unknown, hasher: Hasher = createHasher()): asserts value is LanguageSegmentationWitness {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid language segmentation witness");
  const witness = value as LanguageSegmentationWitness;
  if (witness.schema !== LANGUAGE_SEGMENTATION_WITNESS_SCHEMA || typeof witness.id !== "string" || !witness.id
    || typeof witness.populationModelId !== "string" || !witness.populationModelId || !Array.isArray(witness.populations)) {
    throw new Error("invalid language segmentation witness");
  }
  const populationIds = new Set<string>(), documentIds = new Set<string>();
  for (const population of witness.populations) {
    if (!population || typeof population !== "object" || !population.populationId || populationIds.has(population.populationId)
      || !Number.isFinite(population.prior) || population.prior < 0 || population.prior > 1 || !Array.isArray(population.documents)) {
      throw new Error("invalid language segmentation witness population");
    }
    populationIds.add(population.populationId);
    for (const document of population.documents) {
      validateSourceSegmentationWitness(document, hasher);
      if (documentIds.has(document.documentId)) throw new Error("language segmentation witness repeats a document");
      documentIds.add(document.documentId);
    }
  }
  const identity = {
    schema: LANGUAGE_SEGMENTATION_WITNESS_SCHEMA,
    populationModelId: witness.populationModelId,
    populations: witness.populations.map(population => ({
      populationId: population.populationId,
      prior: population.prior,
      documentIds: population.documents.map(document => document.id)
    }))
  };
  if (witness.id !== `language_segmentation_witness.${canonicalDigestHex(identity, hasher).slice(0, 40)}`) {
    throw new Error("language segmentation witness identity changed");
  }
}

export function isLanguageSegmentationWitness(value: unknown): value is LanguageSegmentationWitness {
  try {
    validateLanguageSegmentationWitness(value);
    return true;
  } catch {
    return false;
  }
}

const sourceCoordinateCache = new WeakMap<SourceSegmentationWitness, readonly number[]>();
const sourceBearingArcCache = new WeakMap<SourceSegmentationWitness, readonly number[]>();

/** Deterministically reconstruct the UTF-16 coordinate for every DAG node. */
export function sourceSegmentationGraphemeUtf16Offsets(witness: SourceSegmentationWitness): readonly number[] {
  const cached = sourceCoordinateCache.get(witness);
  if (cached) return cached;
  const offsets = [...canonicalGraphemeSegmenter().segment(witness.text)].map(segment => segment.index);
  offsets.push(witness.text.length);
  if (offsets.length !== witness.fullDag.factors.nodeCount) {
    throw new Error("source segmentation witness grapheme coordinates differ from its DAG");
  }
  const frozen = Object.freeze(offsets);
  sourceCoordinateCache.set(witness, frozen);
  return frozen;
}

/** Arc ordinals whose exact source slice carries a non-whitespace observation. */
export function sourceSegmentationSurfaceBearingArcIndices(witness: SourceSegmentationWitness): readonly number[] {
  const cached = sourceBearingArcCache.get(witness);
  if (cached) return cached;
  const offsets = sourceSegmentationGraphemeUtf16Offsets(witness);
  const indices: number[] = [];
  witness.fullDag.factors.arcs.forEach((arc, index) => {
    const surface = witness.text.slice(offsets[arc[0]], offsets[arc[1]]);
    if (surface && !/^\s+$/u.test(surface) && !/^\p{Control}+$/u.test(surface)) indices.push(index);
  });
  const frozen = Object.freeze(indices);
  sourceBearingArcCache.set(witness, frozen);
  return frozen;
}

/** Exact evidence-owned source observation for one durable DAG arc. */
export function sourceSegmentationArcObservation(witness: SourceSegmentationWitness, arcIndex: number): {
  arcIndex: number;
  graphemeStart: number;
  graphemeEnd: number;
  utf16Start: number;
  utf16End: number;
  surface: string;
  evidenceIds: string[];
  sourceVersionId?: string;
} {
  const arc = Number.isSafeInteger(arcIndex) ? witness.fullDag.factors.arcs[arcIndex] : undefined;
  if (!arc) throw new Error("segmentation witness arc index is invalid");
  const offsets = sourceSegmentationGraphemeUtf16Offsets(witness);
  const utf16Start = offsets[arc[0]];
  const utf16End = offsets[arc[1]];
  if (utf16Start === undefined || utf16End === undefined) throw new Error("segmentation witness arc coordinates are invalid");
  return {
    arcIndex,
    graphemeStart: arc[0],
    graphemeEnd: arc[1],
    utf16Start,
    utf16End,
    surface: witness.text.slice(utf16Start, utf16End),
    evidenceIds: [...witness.evidenceIds],
    ...(witness.sourceVersionId ? { sourceVersionId: witness.sourceVersionId } : {})
  };
}

function compileSourceWitness(document: LanguageSegmentationWitnessDocument, hasher: Hasher): SourceSegmentationWitness {
  if (!document.documentId || typeof document.text !== "string") throw new Error("invalid segmentation witness document");
  const validation = validateSurfaceLattice(document.lattice, document.text);
  if (!validation.valid) throw new Error(`invalid source lattice for segmentation witness: ${validation.issues.join(",")}`);
  if (document.lattice.documentId !== document.documentId) throw new Error("segmentation witness document and lattice ids differ");
  if (document.sourceVersionId && document.lattice.sourceVersionId
    && document.sourceVersionId !== document.lattice.sourceVersionId) throw new Error("segmentation witness source versions differ");
  const exported = exportSegmentationAdjacencyFactors(document.lattice.segmentationForest);
  validateSegmentationAdjacencyFactors(exported.factors);
  const replayRecipe = exportSurfaceSegmentationReplayRecipe(document.lattice);
  if (exported.unitIds.length !== exported.factors.arcs.length) throw new Error("segmentation witness DAG unit count differs from arc count");
  const unitsById = new Map(document.lattice.units.map(unit => [unit.id, unit]));
  const unitIdSet = new Set<string>();
  exported.unitIds.forEach((unitId, index) => {
    const unit = unitsById.get(unitId);
    const arc = exported.factors.arcs[index];
    if (!unit || !arc || unit.graphemeStart !== arc[0] || unit.graphemeEnd !== arc[1]) {
      throw new Error("segmentation witness DAG refers to an invalid source unit");
    }
    if (unitIdSet.has(unitId)) throw new Error("segmentation witness DAG repeats a source unit");
    unitIdSet.add(unitId);
  });
  if (exported.scoreRecipe) validateSegmentationScoreFactors(exported.scoreRecipe, exported.factors);
  const sourceWindow = document.sourceWindow ?? {
    ownerDocumentId: document.documentId,
    startUtf16: 0,
    endUtf16: document.text.length
  };
  if (!sourceWindow.ownerDocumentId || !Number.isSafeInteger(sourceWindow.startUtf16) || sourceWindow.startUtf16 < 0
    || !Number.isSafeInteger(sourceWindow.endUtf16) || sourceWindow.endUtf16 - sourceWindow.startUtf16 !== document.text.length) {
    throw new Error("segmentation witness has inconsistent source coordinates");
  }
  const graphemeUtf16Offsets = [...canonicalGraphemeSegmenter().segment(document.text)].map(segment => segment.index);
  graphemeUtf16Offsets.push(document.text.length);
  if (graphemeUtf16Offsets.length !== exported.factors.nodeCount) {
    throw new Error("segmentation witness grapheme coordinate count differs from DAG nodes");
  }
  const forest = document.lattice.segmentationForest;
  for (const path of forest.paths) {
    if (path.unitIds.some(unitId => !unitIdSet.has(unitId))) {
      throw new Error("segmentation witness path refers to an invalid source unit");
    }
  }
  const boundaryMarginals = forest.boundaryMarginals.map(marginal =>
    [marginal.positionGrapheme, marginal.boundaryProbability] as const);
  const segmentationForest: SourceSegmentationForestAudit = {
    schema: SOURCE_SEGMENTATION_FOREST_WITNESS_SCHEMA,
    id: forest.id,
    latticeId: forest.latticeId,
    estimatorId: forest.estimatorId,
    normalizationContractId: forest.normalizationContractId,
    graphemeCount: forest.graphemeCount,
    pathLimit: forest.pathLimit,
    limits: structuredClone(forest.limits),
    retainedPathCount: forest.paths.length,
    retainedPathDigest: canonicalDigestHex(forest.paths.map(path => ({
      id: path.id,
      unitIds: path.unitIds,
      energy: path.energy,
      energyTrace: path.energyTrace,
      posterior: path.posterior
    })), hasher),
    boundaryMarginalCount: boundaryMarginals.length,
    boundaryMarginalDigest: canonicalDigestHex(boundaryMarginals, hasher),
    partitionLogZ: forest.partitionLogZ,
    activePartitionLogZ: forest.activePartitionLogZ,
    retainedPosteriorMass: forest.retainedPosteriorMass,
    omittedPosteriorMass: forest.omittedPosteriorMass,
    prunedArcPosteriorMass: forest.prunedArcPosteriorMass,
    unretainedDerivationMass: forest.unretainedDerivationMass,
    completion: forest.completion,
    ...(forest.resumeState ? { resumeStateDigest: canonicalDigestHex(forest.resumeState, hasher) } : {}),
    audit: structuredClone(forest.audit)
  };
  const lattice: SourceSegmentationLatticeWitness = {
    schema: SOURCE_SEGMENTATION_LATTICE_WITNESS_SCHEMA,
    id: document.lattice.id,
    sourceSchema: document.lattice.schema,
    documentId: document.lattice.documentId,
    sourceFamilyId: document.lattice.sourceFamilyId,
    ...(document.lattice.sourceVersionId ? { sourceVersionId: String(document.lattice.sourceVersionId) } : {}),
    evidenceIds: [...document.lattice.evidenceIds],
    textHash: document.lattice.textHash,
    normalizationContract: structuredClone(document.lattice.normalizationContract),
    populationPosterior: structuredClone(document.lattice.populationPosterior),
    sourceUnitCount: document.lattice.units.length,
    sourceEdgeCount: document.lattice.edges.length,
    segmentationForest,
    audit: toJsonValue({
      sourceAudit: document.lattice.audit,
      sourceUnitIdentityDigest: canonicalDigestHex(document.lattice.units.map(unit => unit.id), hasher),
      sourceEdgeIdentityDigest: canonicalDigestHex(document.lattice.edges.map(edge => edge.id), hasher),
      exactSourceSlicesFromDagCoordinates: true,
      richSurfaceUnitProjectionPersisted: false,
      derivedForestArraysPersisted: false,
      derivedCoordinateIndexesPersisted: false
    })
  };
  const canonical = {
    schema: SOURCE_SEGMENTATION_WITNESS_SCHEMA,
    documentId: document.documentId,
    ownerDocumentId: sourceWindow.ownerDocumentId,
    sourceFamilyId: document.sourceFamilyId ?? document.lattice.sourceFamilyId,
    ...(document.sourceVersionId ?? document.lattice.sourceVersionId
      ? { sourceVersionId: String(document.sourceVersionId ?? document.lattice.sourceVersionId) }
      : {}),
    sourceUtf16Start: sourceWindow.startUtf16,
    sourceUtf16End: sourceWindow.endUtf16,
    text: document.text,
    evidenceIds: [...new Set((document.evidenceIds ?? document.lattice.evidenceIds).map(String))].sort(),
    lattice,
    fullDag: {
      factors: structuredClone(exported.factors)
    }
  };
  const result: SourceSegmentationWitness = {
    ...canonical,
    id: `source_segmentation_witness.${canonicalDigestHex(canonical, hasher).slice(0, 40)}`
  };
  if (replayRecipe) Object.defineProperty(result, SOURCE_SEGMENTATION_REPLAY, { value: replayRecipe });
  return result;
}

export function validateSourceSegmentationWitness(value: unknown, hasher: Hasher = createHasher()): asserts value is SourceSegmentationWitness {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid source segmentation witness");
  const witness = value as SourceSegmentationWitness;
  if (witness.schema !== SOURCE_SEGMENTATION_WITNESS_SCHEMA || typeof witness.id !== "string" || !witness.id
    || typeof witness.documentId !== "string" || !witness.documentId || typeof witness.ownerDocumentId !== "string" || !witness.ownerDocumentId
    || typeof witness.sourceFamilyId !== "string" || !witness.sourceFamilyId || typeof witness.text !== "string"
    || !Number.isSafeInteger(witness.sourceUtf16Start) || witness.sourceUtf16Start < 0
    || !Number.isSafeInteger(witness.sourceUtf16End) || witness.sourceUtf16End - witness.sourceUtf16Start !== witness.text.length
    || !Array.isArray(witness.evidenceIds) || !witness.evidenceIds.every(id => typeof id === "string")
    || new Set(witness.evidenceIds).size !== witness.evidenceIds.length || !witness.fullDag
    || Object.hasOwn(witness.fullDag, "scoreRecipe")
    || Object.keys(witness.fullDag).sort().join(",") !== "factors") {
    throw new Error("invalid source segmentation witness");
  }
  validateSegmentationAdjacencyFactors(witness.fullDag.factors);
  validateLatticeWitness(witness.lattice, witness, witness.fullDag.factors);
  if (witness.lattice.textHash !== hasher.digestHex(witness.text)) {
    throw new Error("source segmentation witness text hash changed");
  }
  const { id: _id, ...canonical } = witness;
  if (witness.id !== `source_segmentation_witness.${canonicalDigestHex(canonical, hasher).slice(0, 40)}`) {
    throw new Error("source segmentation witness identity changed");
  }
}

function validateLatticeWitness(
  lattice: SourceSegmentationLatticeWitness,
  source: SourceSegmentationWitness,
  factors: SegmentationAdjacencyFactors
): void {
  if (!lattice || lattice.schema !== SOURCE_SEGMENTATION_LATTICE_WITNESS_SCHEMA || typeof lattice.id !== "string" || !lattice.id
    || lattice.sourceSchema !== SURFACE_LATTICE_SCHEMA || lattice.documentId !== source.documentId
    || typeof lattice.sourceFamilyId !== "string" || !lattice.sourceFamilyId || typeof lattice.textHash !== "string" || !lattice.textHash
    || !Array.isArray(lattice.evidenceIds) || !lattice.evidenceIds.every(id => typeof id === "string")
    || !Number.isSafeInteger(lattice.sourceUnitCount) || lattice.sourceUnitCount < factors.arcs.length
    || !Number.isSafeInteger(lattice.sourceEdgeCount) || lattice.sourceEdgeCount < 0 || !Array.isArray(lattice.populationPosterior)
    || Object.hasOwn(lattice, "graphemeUtf16Offsets") || Object.hasOwn(lattice, "surfaceBearingArcIndices")) {
    throw new Error("invalid source segmentation witness lattice");
  }
  sourceSegmentationGraphemeUtf16Offsets(source);
  validateForestWitness(lattice.segmentationForest, factors);
}

function validateForestWitness(forest: SourceSegmentationForestAudit, factors: SegmentationAdjacencyFactors): void {
  if (!forest || forest.schema !== SOURCE_SEGMENTATION_FOREST_WITNESS_SCHEMA || typeof forest.id !== "string" || !forest.id
    || typeof forest.latticeId !== "string" || !forest.latticeId || typeof forest.estimatorId !== "string" || !forest.estimatorId
    || typeof forest.normalizationContractId !== "string" || !forest.normalizationContractId
    || !Number.isSafeInteger(forest.graphemeCount) || forest.graphemeCount !== factors.nodeCount - 1
    || !Number.isSafeInteger(forest.pathLimit) || forest.pathLimit < 1
    || !Number.isSafeInteger(forest.retainedPathCount) || forest.retainedPathCount < 0 || forest.retainedPathCount > forest.pathLimit
    || !Number.isSafeInteger(forest.boundaryMarginalCount) || forest.boundaryMarginalCount !== factors.nodeCount
    || !digest(forest.retainedPathDigest) || !digest(forest.boundaryMarginalDigest)
    || forest.resumeStateDigest !== undefined && !digest(forest.resumeStateDigest)
    || !finite(forest.partitionLogZ) || !finite(forest.activePartitionLogZ)
    || !probability(forest.retainedPosteriorMass) || !probability(forest.omittedPosteriorMass)
    || !probability(forest.prunedArcPosteriorMass) || !probability(forest.unretainedDerivationMass)
    || !forest.limits || typeof forest.limits !== "object" || Array.isArray(forest.limits)
    || Object.hasOwn(forest, "paths") || Object.hasOwn(forest, "boundaryMarginals") || Object.hasOwn(forest, "resumeState")
    || !["complete_within_limits", "resumable"].includes(forest.completion)) {
    throw new Error("invalid source segmentation forest witness");
  }
}

const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const probability = (value: unknown): value is number => finite(value) && value >= 0 && value <= 1;
