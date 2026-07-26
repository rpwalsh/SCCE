import { clamp01, createHasher, entropy, toJsonValue } from "./primitives.js";
import {
  scoreBoundaryState,
  type BoundaryEstimatorState,
  type BoundaryFeatureVector,
  type BoundaryObservation
} from "./boundary-estimator.js";
import {
  buildSegmentationForest,
  SEGMENTATION_FOREST_SCHEMA,
  type SegmentationForestLimits,
  type SurfaceSegmentationForest
} from "./segmentation-forest.js";
import { dominantScriptId, segmentUnicodeSurfaceV2 } from "./unicode-segmentation-v2.js";
import type { EvidenceId, Hasher, JsonValue, SourceVersionId } from "./types.js";
import {
  canonicalGraphemeSegmenter,
  canonicalNormalizationContract,
  normalizeCanonicalSurface,
  type NormalizationContract
} from "./normalization-contract.js";
import {
  createCanonicalIdentity,
  type CanonicalIdentity
} from "./canonical-identity.js";

export const SURFACE_LATTICE_SCHEMA = "scce.surface_lattice.v3" as const;
export const UNTRAINED_BOUNDARY_ESTIMATOR_ID = "boundary_estimator.untrained-neutral.v1" as const;

export type SurfaceLatticeUnitKind =
  | "grapheme"
  | "surface_segment"
  | "lexical"
  | "phrase_candidate"
  | "numeric"
  | "date"
  | "quote"
  | "code_symbol"
  | "markup_structure"
  | "table_cell"
  | "line"
  | "sentence_like"
  | "paragraph"
  | "repeated_sequence";

export type SurfaceLatticeEdgeKind =
  | "sequence"
  | "contains"
  | "recurs_with"
  | "licensed_overlap";

export type SurfaceLatticeOverlapClass =
  | "base_partition"
  | "segmentation_alternative"
  | "structure";

export interface SurfaceBoundaryEvidence {
  positionByte: number;
  positionCodePoint: number;
  positionGrapheme: number;
  boundaryProbability: number;
  estimatorId: string;
  features: BoundaryFeatureVector;
}

export interface SurfaceLatticeUnit {
  id: string;
  occurrenceId: string;
  normalizedFormId: string;
  surfaceFormClassId: string;
  canonicalIdentities: {
    occurrence: CanonicalIdentity;
    normalizedForm: CanonicalIdentity;
    surfaceFormClass: CanonicalIdentity;
  };
  proposalSources: SurfaceLatticeUnitKind[];
  kind: SurfaceLatticeUnitKind;
  overlapClass: SurfaceLatticeOverlapClass;
  surface: string;
  normalized: string;
  byteStart: number;
  byteEnd: number;
  utf16Start: number;
  utf16End: number;
  codePointStart: number;
  codePointEnd: number;
  graphemeStart: number;
  graphemeEnd: number;
  scriptId: string;
  recurrenceCount: number;
  entropy: number;
  predictability: number;
  leftContextSketch: string[];
  rightContextSketch: string[];
  boundaryBefore: SurfaceBoundaryEvidence;
  boundaryAfter: SurfaceBoundaryEvidence;
  evidenceIds: string[];
  sourceVersionId?: string;
}

export interface SurfaceLatticeEdge {
  id: string;
  fromUnitId: string;
  toUnitId: string;
  kind: SurfaceLatticeEdgeKind;
  weight: number;
}

export interface SurfaceLattice {
  schema: typeof SURFACE_LATTICE_SCHEMA;
  id: string;
  documentId: string;
  sourceVersionId?: string;
  evidenceIds: string[];
  textHash: string;
  normalizationContract: NormalizationContract;
  units: SurfaceLatticeUnit[];
  edges: SurfaceLatticeEdge[];
  segmentationForest: SurfaceSegmentationForest;
  audit: JsonValue;
}

export interface SurfaceLatticeValidation {
  valid: boolean;
  issues: string[];
}

export interface SurfaceLatticeBuildOptions {
  documentId: string;
  text: string;
  sourceVersionId?: SourceVersionId | string;
  evidenceIds?: readonly (EvidenceId | string)[];
  hasher?: Hasher;
  maxUnits?: number;
  maxEdges?: number;
  segmentationPathLimit?: number;
  segmentationForestLimits?: Partial<SegmentationForestLimits>;
  boundaryEstimator?: BoundaryEstimatorState;
  boundaryFeatureContext?: CompiledBoundaryFeatureContext;
  normalizationContract?: NormalizationContract;
}

export interface CompiledBoundaryFeatureContext {
  schema: "scce.boundary_feature_context.v1";
  id: string;
  sourceDocumentCount: number;
  documentCountBySurfaceFormClass: Record<string, number>;
  classCountByBoundaryContext: Record<string, number>;
}

export interface BoundaryAnchor {
  documentId: string;
  positionGrapheme: number;
  outcome: "boundary" | "continuation";
  signalKind: Exclude<BoundaryObservation["signalKind"], "packed_forest_marginal">;
  sourceId: string;
  confidence: number;
}

interface CandidateUnit {
  kind: SurfaceLatticeUnitKind;
  surface: string;
  utf16Start: number;
  utf16End: number;
  codePointStart: number;
  codePointEnd: number;
}

interface QuotientedCandidateUnit extends CandidateUnit {
  proposalSources: SurfaceLatticeUnitKind[];
}

interface SurfaceCoordinateIndex {
  utf16ToByte: number[];
  utf16ToCodePoint: number[];
  utf16ToGraphemeStart: number[];
  utf16ToGraphemeEnd: number[];
}

const GRAPHEME_SEGMENTER = canonicalGraphemeSegmenter();

export function buildSurfaceLattice(options: SurfaceLatticeBuildOptions): SurfaceLattice {
  const hasher = options.hasher ?? createHasher();
  const normalizationContract = options.normalizationContract ?? canonicalNormalizationContract(hasher);
  const maxUnits = Math.max(64, Math.floor(options.maxUnits ?? 4096));
  const maxEdges = Math.max(64, Math.floor(options.maxEdges ?? 8192));
  const text = options.text;
  const model = segmentUnicodeSurfaceV2(text, hasher);
  const evidenceIds = (options.evidenceIds ?? []).map(String).sort();
  const sourceVersionId = options.sourceVersionId === undefined ? undefined : String(options.sourceVersionId);
  const occurrenceSourceVersionId = sourceVersionId
    ?? `source_version.content.${hasher.digestHex(text).slice(0, 48)}`;
  const estimatorId = options.boundaryEstimator?.id ?? UNTRAINED_BOUNDARY_ESTIMATOR_ID;
  const latticeId = `surface_lattice.${hasher.digestHex(JSON.stringify([
    SURFACE_LATTICE_SCHEMA,
    options.documentId,
    sourceVersionId,
    evidenceIds,
    hasher.digestHex(text),
    estimatorId,
    normalizationContract.id
  ])).slice(0, 32)}`;
  const coordinates = buildSurfaceCoordinateIndex(text);
  const codePointIndexByUtf16 = coordinates.utf16ToCodePoint;
  const transitionEntropyByPosition = localTransitionEntropyByPosition(text);
  const normalizedCounts = new Map<string, number>();

  const rawBaseCandidates = graphemeCandidates(text, coordinates);
  const rawHigherCandidates = [
    ...surfaceSegmentCandidates(model.surfaceSegments),
    ...lexicalCandidates(model.lexicalSegments),
    ...phraseCandidates(text, model.lexicalSegments),
    ...regexSpanCandidates(text, codePointIndexByUtf16, "numeric", /[+-]?(?:\d+(?:[.,:]\d+)*|\d*\.\d+)%?/gu),
    ...regexSpanCandidates(text, codePointIndexByUtf16, "date", /\b(?:\d{4}-\d{2}-\d{2}|\d{1,4}[/.]\d{1,2}[/.]\d{1,4})\b/gu),
    ...quoteSpanCandidates(text, codePointIndexByUtf16),
    ...regexSpanCandidates(text, codePointIndexByUtf16, "code_symbol", /[$_\p{Letter}][$_\p{Letter}\p{Number}]{1,64}/gu),
    ...markupCandidates(text, codePointIndexByUtf16),
    ...tableCellCandidates(text, codePointIndexByUtf16),
    ...lineCandidates(text, codePointIndexByUtf16),
    ...paragraphCandidates(text, codePointIndexByUtf16),
    ...sentenceLikeCandidates(text, codePointIndexByUtf16),
    ...repeatedSequenceCandidates(text, model.lexicalSegments)
  ];
  const candidates = quotientCandidateUnits(
    [...rawBaseCandidates, ...rawHigherCandidates],
    coordinates
  );
  const baseCandidates = candidates.filter(candidate =>
    candidate.proposalSources.includes("grapheme"));
  const higherCandidates = candidates.filter(candidate =>
    !candidate.proposalSources.includes("grapheme"));
  const corpusFeaturesByPosition = corpusBoundaryFeaturesByPosition({
    candidates: higherCandidates,
    model,
    coordinates,
    normalizationContract,
    context: options.boundaryFeatureContext,
    hasher
  });

  for (const candidate of candidates) {
    const key = recurrenceKey(candidate, normalizationContract);
    normalizedCounts.set(key, (normalizedCounts.get(key) ?? 0) + 1);
  }

  const units: SurfaceLatticeUnit[] = [];
  const seen = new Set<string>();
  const orderedCandidates = [
    ...baseCandidates.sort(compareCandidateUnits),
    ...higherCandidates.sort(compareCandidateUnits)
  ];
  const effectiveMaxUnits = Math.max(maxUnits, baseCandidates.length);
  for (const candidate of orderedCandidates) {
    if (units.length >= effectiveMaxUnits) break;
    if (!candidate.surface) continue;
    const identity = `${candidate.kind}\u0001${candidate.codePointStart}\u0001${candidate.codePointEnd}\u0001${candidate.surface}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const normalized = normalizeSurface(candidate.surface, normalizationContract);
    const recurrenceCount = normalizedCounts.get(recurrenceKey(candidate, normalizationContract)) ?? 1;
    const before = boundaryEvidenceAt({
      text,
      positionCodePoint: candidate.codePointStart,
      positionByte: coordinates.utf16ToByte[candidate.utf16Start] ?? 0,
      positionGrapheme: coordinates.utf16ToGraphemeStart[candidate.utf16Start] ?? 0,
      structuralBoundary: structuralBoundaryAt(candidate.codePointStart, candidate.codePointEnd, text, codePointIndexByUtf16),
      transitionEntropyByPosition,
      repeatedContextSupport: recurrenceCount,
      learnedFeatures: corpusFeaturesByPosition.get(
        coordinates.utf16ToGraphemeStart[candidate.utf16Start] ?? 0
      ),
      boundaryEstimator: options.boundaryEstimator
    });
    const after = boundaryEvidenceAt({
      text,
      positionCodePoint: candidate.codePointEnd,
      positionByte: coordinates.utf16ToByte[candidate.utf16End] ?? Buffer.byteLength(text, "utf8"),
      positionGrapheme: coordinates.utf16ToGraphemeEnd[candidate.utf16End] ?? baseCandidates.length,
      structuralBoundary: structuralBoundaryAt(candidate.codePointStart, candidate.codePointEnd, text, codePointIndexByUtf16),
      transitionEntropyByPosition,
      repeatedContextSupport: recurrenceCount,
      learnedFeatures: corpusFeaturesByPosition.get(
        coordinates.utf16ToGraphemeEnd[candidate.utf16End] ?? baseCandidates.length
      ),
      boundaryEstimator: options.boundaryEstimator
    });
    const occurrenceIdentity = createCanonicalIdentity({
        kind: "surface_occurrence",
        fields: {
          sourceVersionId: occurrenceSourceVersionId,
          documentId: options.documentId,
          byteStart: coordinates.utf16ToByte[candidate.utf16Start] ?? 0,
          byteEnd: coordinates.utf16ToByte[candidate.utf16End] ?? Buffer.byteLength(text, "utf8"),
          exactSurfaceHash: hasher.digestHex(candidate.surface)
        },
        normalizationContract,
        hasher
      });
    const normalizedFormIdentity = createCanonicalIdentity({
      kind: "normalized_surface_form",
      fields: {
        normalizationContractId: normalizationContract.id,
        normalizedSurface: normalized
      },
      normalizationContract,
      hasher
    });
    const surfaceFormClassIdentity = createCanonicalIdentity({
      kind: "surface_form_class",
      fields: {
        normalizationContractId: normalizationContract.id,
        normalizedSurfaceFormId: normalizedFormIdentity.id,
        unicodeScriptId: dominantScriptId(candidate.surface)
      },
      normalizationContract,
      hasher
    });
    units.push({
      id: `surface_arc.${hasher.digestHex(occurrenceIdentity.id).slice(0, 40)}`,
      occurrenceId: occurrenceIdentity.id,
      normalizedFormId: normalizedFormIdentity.id,
      surfaceFormClassId: surfaceFormClassIdentity.id,
      canonicalIdentities: {
        occurrence: occurrenceIdentity,
        normalizedForm: normalizedFormIdentity,
        surfaceFormClass: surfaceFormClassIdentity
      },
      proposalSources: candidate.proposalSources,
      kind: candidate.kind,
      overlapClass: overlapClassFor(candidate.kind),
      surface: candidate.surface,
      normalized,
      byteStart: coordinates.utf16ToByte[candidate.utf16Start] ?? 0,
      byteEnd: coordinates.utf16ToByte[candidate.utf16End] ?? Buffer.byteLength(text, "utf8"),
      utf16Start: candidate.utf16Start,
      utf16End: candidate.utf16End,
      codePointStart: candidate.codePointStart,
      codePointEnd: candidate.codePointEnd,
      graphemeStart: coordinates.utf16ToGraphemeStart[candidate.utf16Start] ?? 0,
      graphemeEnd: coordinates.utf16ToGraphemeEnd[candidate.utf16End] ?? baseCandidates.length,
      scriptId: dominantScriptId(candidate.surface),
      recurrenceCount,
      entropy: entropy([...frequency([...candidate.surface]).values()]),
      predictability: clamp01(Math.log1p(recurrenceCount) / 8),
      leftContextSketch: contextSketch(model.lexicalSegments, candidate.codePointStart, "left"),
      rightContextSketch: contextSketch(model.lexicalSegments, candidate.codePointEnd, "right"),
      boundaryBefore: before,
      boundaryAfter: after,
      evidenceIds,
      ...(sourceVersionId ? { sourceVersionId } : {})
    });
  }

  const effectiveMaxEdges = maxEdges + Math.max(0, baseCandidates.length - 1);
  const edges = latticeEdges(units, hasher, effectiveMaxEdges);
  const segmentationForest = buildSegmentationForest({
    latticeId,
    estimatorId,
    units,
    pathLimit: options.segmentationPathLimit,
    limits: options.segmentationForestLimits,
    normalizationContractId: normalizationContract.id,
    hasher
  });
  const countsByKind = new Map<SurfaceLatticeUnitKind, number>();
  for (const unit of units) countsByKind.set(unit.kind, (countsByKind.get(unit.kind) ?? 0) + 1);
  return {
    schema: SURFACE_LATTICE_SCHEMA,
    id: latticeId,
    documentId: options.documentId,
    ...(sourceVersionId ? { sourceVersionId } : {}),
    evidenceIds,
    textHash: hasher.digestHex(text),
    normalizationContract,
    units,
    edges,
    segmentationForest,
    audit: toJsonValue({
      builder: "kernel.surface_lattice.v3",
      normalizationContractId: normalizationContract.id,
      inputUtf16Length: text.length,
      inputBytes: Buffer.byteLength(text, "utf8"),
      inputCodePoints: [...text].length,
      inputGraphemes: rawBaseCandidates.length,
      detectorProposals: rawBaseCandidates.length + rawHigherCandidates.length,
      canonicalCandidateUnits: candidates.length,
      duplicateProposalsCollapsed: rawBaseCandidates.length + rawHigherCandidates.length - candidates.length,
      candidateUnits: candidates.length,
      persistedUnits: units.length,
      persistedEdges: edges.length,
      unitCapReached: candidates.length > units.length,
      baseCoverageOverride: baseCandidates.length > maxUnits,
      edgeCapReached: edges.length >= effectiveMaxEdges,
      unitsByKind: Object.fromEntries([...countsByKind.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
      boundaryEstimator: {
        id: estimatorId,
        status: options.boundaryEstimator ? "corpus_fitted" : "untrained_neutral",
        trainingStatisticsId: options.boundaryEstimator && "trainingStatisticsId" in options.boundaryEstimator
          ? options.boundaryEstimator.trainingStatisticsId
          : undefined,
        populationModelId: options.boundaryEstimator && "populationModelId" in options.boundaryEstimator
          ? options.boundaryEstimator.populationModelId
          : undefined
      },
      segmentationForestId: segmentationForest.id,
      retainedSegmentationPosteriorMass: segmentationForest.retainedPosteriorMass,
      omittedSegmentationPosteriorMass: segmentationForest.omittedPosteriorMass,
      segmentationCompletion: segmentationForest.completion,
      segmentationResumeToken: segmentationForest.resumeState?.token
    })
  };
}

export function canonicalSurfaceSequence(
  lattice: SurfaceLattice
): SurfaceLatticeUnit[] {
  const selected = lattice.segmentationForest.paths[0];
  if (!selected) return [];
  const unitsById = new Map(lattice.units.map(unit => [unit.id, unit]));
  return selected.unitIds
    .map(unitId => {
      const unit = unitsById.get(unitId);
      if (!unit) throw new Error(`segmentation forest references missing unit ${unitId}`);
      return unit;
    })
    .filter(unit => unit.surface.length > 0 && !/^\s+$/u.test(unit.surface) && !/^\p{Control}+$/u.test(unit.surface));
}

/**
 * Compiles boundary supervision without treating detector proposals as truth.
 * Repeated phrases must recur across documents before they can anchor a
 * decision. All unanchored positions use exact packed-forest marginals.
 */
export function collectBoundaryTrainingObservations(input: {
  lattices: readonly SurfaceLattice[];
  anchors?: readonly BoundaryAnchor[];
}): BoundaryObservation[] {
  const observations: BoundaryObservation[] = [];
  const lattices = [...input.lattices].sort((left, right) => left.id.localeCompare(right.id));
  const documentsByUnitClass = new Map<string, Set<string>>();
  const unitsByContext = new Map<string, Set<string>>();
  for (const lattice of lattices) {
    for (const unit of lattice.units) {
      if (unit.overlapClass === "base_partition") continue;
      const documents = documentsByUnitClass.get(unit.surfaceFormClassId) ?? new Set<string>();
      documents.add(lattice.documentId);
      documentsByUnitClass.set(unit.surfaceFormClassId, documents);
      const contextKey = boundaryContextKey(unit);
      const classes = unitsByContext.get(contextKey) ?? new Set<string>();
      classes.add(unit.surfaceFormClassId);
      unitsByContext.set(contextKey, classes);
    }
  }
  const anchorsByDocument = new Map<string, BoundaryAnchor[]>();
  for (const anchor of input.anchors ?? []) {
    if (!anchor.sourceId.trim()) throw new Error("boundary anchor requires a sourceId");
    const bucket = anchorsByDocument.get(anchor.documentId) ?? [];
    bucket.push(anchor);
    anchorsByDocument.set(anchor.documentId, bucket);
  }

  for (const lattice of lattices) {
    const graphemes = lattice.units
      .filter(unit => unit.overlapClass === "base_partition")
      .sort(comparePersistedUnits);
    const hypotheses = lattice.units.filter(unit => unit.overlapClass !== "base_partition");
    const featuresByPosition = new Map<number, BoundaryFeatureVector>();
    const anchoredPositions = new Set<number>();
    for (let position = 1; position < graphemes.length; position += 1) {
      featuresByPosition.set(position, { ...graphemes[position - 1]!.boundaryAfter.features });
    }

    for (const unit of hypotheses) {
      const documentSupport = documentsByUnitClass.get(unit.surfaceFormClassId)?.size ?? 1;
      const recurrenceFeature = clamp01(Math.log1p(Math.max(0, documentSupport - 1)) / 6);
      const spanLength = Math.max(1, unit.graphemeEnd - unit.graphemeStart);
      const compressionFeature = clamp01(recurrenceFeature * (1 - 1 / spanLength));
      const substitutionFeature = clamp01(
        Math.log1p(Math.max(0, (unitsByContext.get(boundaryContextKey(unit))?.size ?? 1) - 1)) / 6
      );
      for (let position = Math.max(1, unit.graphemeStart);
        position <= Math.min(graphemes.length - 1, unit.graphemeEnd);
        position += 1) {
        const current = featuresByPosition.get(position);
        if (!current) continue;
        current.crossDocumentRecurrence = Math.max(current.crossDocumentRecurrence, recurrenceFeature);
        current.predictiveCompressionGain = Math.max(current.predictiveCompressionGain, compressionFeature);
        current.stableSubstitutionSupport = Math.max(current.stableSubstitutionSupport, substitutionFeature);
        current.exactPhraseRecurrence = Math.max(current.exactPhraseRecurrence, recurrenceFeature);
        current.constructionReuse = Math.max(current.constructionReuse, substitutionFeature);
      }

      if (documentSupport >= 2 && unit.overlapClass === "segmentation_alternative") {
        const mass = Math.max(1, Math.log1p(documentSupport));
        for (const position of [unit.graphemeStart, unit.graphemeEnd]) {
          if (position <= 0 || position >= graphemes.length) continue;
          anchoredPositions.add(position);
          observations.push({
            sourceDocumentId: lattice.documentId,
            features: featuresByPosition.get(position)!,
            positiveMass: mass,
            negativeMass: 0,
            supervision: "independent_anchor",
            signalKind: "exact_repeated_phrase",
            signalId: `crossdoc.endpoint.${lattice.id}.${unit.id}.${position}`
          });
        }
        for (let position = unit.graphemeStart + 1; position < unit.graphemeEnd; position += 1) {
          if (position <= 0 || position >= graphemes.length) continue;
          anchoredPositions.add(position);
          observations.push({
            sourceDocumentId: lattice.documentId,
            features: featuresByPosition.get(position)!,
            positiveMass: 0,
            negativeMass: mass,
            supervision: "independent_anchor",
            signalKind: "cross_document_recurrence",
            signalId: `crossdoc.interior.${lattice.id}.${unit.id}.${position}`
          });
        }
      }

      if (unit.overlapClass === "structure"
        && unit.proposalSources.some(source =>
          source === "markup_structure"
          || source === "table_cell"
          || source === "line"
          || source === "paragraph")) {
        for (const position of [unit.graphemeStart, unit.graphemeEnd]) {
          if (position <= 0 || position >= graphemes.length) continue;
          anchoredPositions.add(position);
          observations.push({
            sourceDocumentId: lattice.documentId,
            features: featuresByPosition.get(position)!,
            positiveMass: 1,
            negativeMass: 0,
            supervision: "independent_anchor",
            signalKind: "structured_anchor",
            signalId: `structure.endpoint.${lattice.id}.${unit.id}.${position}`
          });
        }
      }
    }

    for (const anchor of anchorsByDocument.get(lattice.documentId) ?? []) {
      const features = featuresByPosition.get(anchor.positionGrapheme);
      if (!features || anchor.positionGrapheme <= 0 || anchor.positionGrapheme >= graphemes.length) continue;
      anchoredPositions.add(anchor.positionGrapheme);
      observations.push({
        sourceDocumentId: lattice.documentId,
        features,
        positiveMass: anchor.outcome === "boundary" ? clamp01(anchor.confidence) : 0,
        negativeMass: anchor.outcome === "continuation" ? clamp01(anchor.confidence) : 0,
        supervision: "independent_anchor",
        signalKind: anchor.signalKind,
        signalId: `external.${lattice.id}.${anchor.sourceId}.${anchor.positionGrapheme}`
      });
    }

    const marginals = new Map(lattice.segmentationForest.boundaryMarginals
      .map(row => [row.positionGrapheme, row.boundaryProbability]));
    for (let position = 1; position < graphemes.length; position += 1) {
      if (anchoredPositions.has(position)) continue;
      const probability = clamp01(marginals.get(position) ?? 0.5);
      observations.push({
        sourceDocumentId: lattice.documentId,
        features: featuresByPosition.get(position)!,
        positiveMass: probability,
        negativeMass: 1 - probability,
        supervision: "latent_marginal",
        signalKind: "packed_forest_marginal",
        signalId: `latent.${lattice.segmentationForest.id}.${position}`
      });
    }
  }
  return observations;
}

export function compileBoundaryFeatureContext(input: {
  lattices: readonly SurfaceLattice[];
  hasher?: Hasher;
}): CompiledBoundaryFeatureContext {
  const hasher = input.hasher ?? createHasher();
  const documentsByClass = new Map<string, Set<string>>();
  const classesByContext = new Map<string, Set<string>>();
  for (const lattice of input.lattices) {
    for (const unit of lattice.units) {
      if (unit.overlapClass === "base_partition") continue;
      const documents = documentsByClass.get(unit.surfaceFormClassId) ?? new Set<string>();
      documents.add(lattice.documentId);
      documentsByClass.set(unit.surfaceFormClassId, documents);
      const contextKey = boundaryContextKey(unit);
      const classes = classesByContext.get(contextKey) ?? new Set<string>();
      classes.add(unit.surfaceFormClassId);
      classesByContext.set(contextKey, classes);
    }
  }
  const canonical = {
    schema: "scce.boundary_feature_context.v1" as const,
    sourceDocumentCount: new Set(input.lattices.map(lattice => lattice.documentId)).size,
    documentCountBySurfaceFormClass: Object.fromEntries(
      [...documentsByClass.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, value.size])
    ),
    classCountByBoundaryContext: Object.fromEntries(
      [...classesByContext.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, value.size])
    )
  };
  return {
    ...canonical,
    id: `boundary_feature_context.${hasher.digestHex(JSON.stringify(canonical)).slice(0, 40)}`
  };
}

function boundaryContextKey(unit: SurfaceLatticeUnit): string {
  return boundaryContextKeyParts(unit.leftContextSketch, unit.rightContextSketch);
}

function boundaryContextKeyParts(left: readonly string[], right: readonly string[]): string {
  return `${left.join("\u001f")}\u001e${right.join("\u001f")}`;
}

export function validateSurfaceLattice(lattice: SurfaceLattice, text: string): SurfaceLatticeValidation {
  const issues: string[] = [];
  const bytes = Buffer.from(text, "utf8");
  const graphemes = lattice.units
    .filter(unit => unit.kind === "grapheme")
    .sort(comparePersistedUnits);
  const occurrenceIds = new Set<string>();
  for (const unit of lattice.units) {
    if (occurrenceIds.has(unit.occurrenceId)) {
      issues.push(`duplicate_occurrence:${unit.occurrenceId}`);
    }
    occurrenceIds.add(unit.occurrenceId);
    if (!unit.proposalSources.length) issues.push(`missing_proposal_source:${unit.id}`);
  }
  let byteCursor = 0;
  let utf16Cursor = 0;
  let codePointCursor = 0;
  let graphemeCursor = 0;
  for (const unit of graphemes) {
    if (unit.byteStart !== byteCursor
      || unit.utf16Start !== utf16Cursor
      || unit.codePointStart !== codePointCursor
      || unit.graphemeStart !== graphemeCursor) {
      issues.push(`base_gap:${unit.id}`);
    }
    if (bytes.subarray(unit.byteStart, unit.byteEnd).toString("utf8") !== unit.surface
      || text.slice(unit.utf16Start, unit.utf16End) !== unit.surface) {
      issues.push(`coordinate_mismatch:${unit.id}`);
    }
    byteCursor = unit.byteEnd;
    utf16Cursor = unit.utf16End;
    codePointCursor = unit.codePointEnd;
    graphemeCursor = unit.graphemeEnd;
  }
  if (byteCursor !== bytes.length
    || utf16Cursor !== text.length
    || codePointCursor !== [...text].length
    || graphemeCursor !== graphemes.length) {
    issues.push("base_partition_incomplete");
  }
  if (graphemes.map(unit => unit.surface).join("") !== text) {
    issues.push("base_partition_reconstruction");
  }
  if (lattice.segmentationForest.schema !== SEGMENTATION_FOREST_SCHEMA
    || lattice.segmentationForest.latticeId !== lattice.id
    || lattice.segmentationForest.graphemeCount !== graphemes.length) {
    issues.push("segmentation_forest_identity");
  }
  if (lattice.segmentationForest.boundaryMarginals.length !== graphemes.length + 1
    || lattice.segmentationForest.boundaryMarginals[0]?.boundaryProbability !== 1
    || lattice.segmentationForest.boundaryMarginals.at(-1)?.boundaryProbability !== 1
    || lattice.segmentationForest.boundaryMarginals.some((row, index) =>
      row.positionGrapheme !== index
      || row.boundaryProbability < 0
      || row.boundaryProbability > 1)) {
    issues.push("segmentation_boundary_marginals");
  }
  const unitsById = new Map(lattice.units.map(unit => [unit.id, unit]));
  let retainedMass = 0;
  for (const path of lattice.segmentationForest.paths) {
    let cursor = 0;
    retainedMass += path.posterior;
    for (const unitId of path.unitIds) {
      const unit = unitsById.get(unitId);
      if (!unit) {
        issues.push(`segmentation_missing_unit:${unitId}`);
        continue;
      }
      if (unit.graphemeStart !== cursor || unit.graphemeEnd <= unit.graphemeStart) {
        issues.push(`segmentation_gap:${path.id}:${unitId}`);
      }
      cursor = unit.graphemeEnd;
    }
    if (cursor !== graphemes.length) issues.push(`segmentation_incomplete:${path.id}`);
    if (path.posterior < 0 || path.posterior > 1) issues.push(`segmentation_posterior:${path.id}`);
  }
  if (graphemes.length > 0 && lattice.segmentationForest.paths.length === 0) {
    issues.push("segmentation_forest_empty");
  }
  if (Math.abs(retainedMass - lattice.segmentationForest.retainedPosteriorMass) > 1e-8
    || retainedMass > 1 + 1e-8) {
    issues.push("segmentation_retained_mass");
  }
  if (Math.abs(
    lattice.segmentationForest.retainedPosteriorMass
    + lattice.segmentationForest.omittedPosteriorMass
    - 1
  ) > 1e-8
    || Math.abs(
      lattice.segmentationForest.prunedArcPosteriorMass
      + lattice.segmentationForest.unretainedDerivationMass
      - lattice.segmentationForest.omittedPosteriorMass
    ) > 1e-8) {
    issues.push("segmentation_posterior_conservation");
  }
  if (lattice.segmentationForest.paths.some(path =>
    Math.abs(
      path.energyTrace.boundary
      + path.energyTrace.continuation
      + path.energyTrace.anchor
      + path.energyTrace.description
      + path.energyTrace.population
      + path.energyTrace.semanticContext
      - path.energyTrace.total
    ) > 1e-8
    || Math.abs(path.energyTrace.total - path.energy) > 1e-8)) {
    issues.push("segmentation_energy_trace");
  }
  if ((lattice.segmentationForest.completion === "resumable")
    !== Boolean(lattice.segmentationForest.resumeState)) {
    issues.push("segmentation_resume_state");
  }
  for (const unit of lattice.units) {
    if (unit.byteStart < 0 || unit.byteEnd < unit.byteStart || unit.byteEnd > bytes.length
      || unit.utf16Start < 0 || unit.utf16End < unit.utf16Start || unit.utf16End > text.length
      || unit.codePointStart < 0 || unit.codePointEnd < unit.codePointStart
      || unit.graphemeStart < 0 || unit.graphemeEnd < unit.graphemeStart) {
      issues.push(`coordinate_range:${unit.id}`);
      continue;
    }
    if (bytes.subarray(unit.byteStart, unit.byteEnd).toString("utf8") !== unit.surface
      || text.slice(unit.utf16Start, unit.utf16End) !== unit.surface) {
      issues.push(`coordinate_mismatch:${unit.id}`);
    }
  }
  return { valid: issues.length === 0, issues };
}

function buildSurfaceCoordinateIndex(text: string): SurfaceCoordinateIndex {
  const utf16ToByte = new Array<number>(text.length + 1).fill(0);
  const utf16ToCodePoint = new Array<number>(text.length + 1).fill(0);
  let codePoint = 0;
  let utf16 = 0;
  let byte = 0;
  for (const char of text) {
    utf16ToByte[utf16] = byte;
    utf16ToCodePoint[utf16] = codePoint;
    for (let offset = 1; offset < char.length; offset += 1) {
      utf16ToByte[utf16 + offset] = byte;
      utf16ToCodePoint[utf16 + offset] = codePoint;
    }
    utf16 += char.length;
    byte += Buffer.byteLength(char, "utf8");
    codePoint += 1;
    utf16ToByte[utf16] = byte;
    utf16ToCodePoint[utf16] = codePoint;
  }
  const utf16ToGraphemeStart = new Array<number>(text.length + 1).fill(0);
  const utf16ToGraphemeEnd = new Array<number>(text.length + 1).fill(0);
  let grapheme = 0;
  for (const row of GRAPHEME_SEGMENTER.segment(text)) {
    const start = row.index;
    const end = start + row.segment.length;
    for (let position = start; position < end; position += 1) {
      utf16ToGraphemeStart[position] = grapheme;
      utf16ToGraphemeEnd[position] = position === start ? grapheme : grapheme + 1;
    }
    utf16ToGraphemeStart[end] = grapheme + 1;
    utf16ToGraphemeEnd[end] = grapheme + 1;
    grapheme += 1;
  }
  return { utf16ToByte, utf16ToCodePoint, utf16ToGraphemeStart, utf16ToGraphemeEnd };
}

function codePointAtUtf16(indexByUtf16: readonly number[], utf16: number): number {
  const bounded = Math.max(0, Math.min(indexByUtf16.length - 1, utf16));
  return indexByUtf16[bounded] ?? 0;
}

function utf16AtCodePoint(text: string, codePoint: number): number {
  let utf16 = 0;
  let current = 0;
  for (const char of text) {
    if (current >= codePoint) return utf16;
    utf16 += char.length;
    current += 1;
  }
  return text.length;
}

function graphemeCandidates(text: string, coordinates: SurfaceCoordinateIndex): CandidateUnit[] {
  const out: CandidateUnit[] = [];
  for (const row of GRAPHEME_SEGMENTER.segment(text)) {
    const utf16Start = row.index;
    const utf16End = row.index + row.segment.length;
    out.push({
      kind: "grapheme",
      surface: row.segment,
      utf16Start,
      utf16End,
      codePointStart: codePointAtUtf16(coordinates.utf16ToCodePoint, utf16Start),
      codePointEnd: codePointAtUtf16(coordinates.utf16ToCodePoint, utf16End)
    });
  }
  return out;
}

function surfaceSegmentCandidates(segments: ReturnType<typeof segmentUnicodeSurfaceV2>["surfaceSegments"]): CandidateUnit[] {
  return segments
    .filter(segment => segment.kind !== "whitespace" && segment.surface.length > 0)
    .map(segment => ({
      kind: "surface_segment" as const,
      surface: segment.surface,
      utf16Start: segment.utf16Start,
      utf16End: segment.utf16End,
      codePointStart: segment.codePointStart,
      codePointEnd: segment.codePointEnd
    }));
}

function lexicalCandidates(segments: ReturnType<typeof segmentUnicodeSurfaceV2>["lexicalSegments"]): CandidateUnit[] {
  return segments.map(segment => ({
    kind: "lexical" as const,
    surface: segment.surface,
    utf16Start: segment.utf16Start,
    utf16End: segment.utf16End,
    codePointStart: segment.codePointStart,
    codePointEnd: segment.codePointEnd
  }));
}

function phraseCandidates(
  text: string,
  segments: ReturnType<typeof segmentUnicodeSurfaceV2>["lexicalSegments"]
): CandidateUnit[] {
  const out: CandidateUnit[] = [];
  const limit = Math.min(segments.length, 4096);
  for (let start = 0; start < limit; start += 1) {
    for (let width = 2; width <= 5 && start + width <= limit; width += 1) {
      const first = segments[start]!;
      const last = segments[start + width - 1]!;
      out.push({
        kind: "phrase_candidate",
        surface: text.slice(first.utf16Start, last.utf16End),
        utf16Start: first.utf16Start,
        utf16End: last.utf16End,
        codePointStart: first.codePointStart,
        codePointEnd: last.codePointEnd
      });
    }
  }
  return out;
}

function regexSpanCandidates(
  text: string,
  indexByUtf16: readonly number[],
  kind: SurfaceLatticeUnitKind,
  regex: RegExp
): CandidateUnit[] {
  const out: CandidateUnit[] = [];
  for (const match of text.matchAll(regex)) {
    const surface = match[0];
    if (!surface) continue;
    const start = match.index ?? 0;
    const end = start + surface.length;
    out.push({
      kind,
      surface,
      utf16Start: start,
      utf16End: end,
      codePointStart: codePointAtUtf16(indexByUtf16, start),
      codePointEnd: codePointAtUtf16(indexByUtf16, end)
    });
  }
  return out;
}

function quoteSpanCandidates(text: string, indexByUtf16: readonly number[]): CandidateUnit[] {
  const openers = new Map<string, string>([["\"", "\""], ["'", "'"], ["“", "”"], ["‘", "’"], ["「", "」"], ["『", "』"]]);
  const out: CandidateUnit[] = [];
  for (const [open, close] of openers) {
    let cursor = 0;
    while (cursor < text.length) {
      const start = text.indexOf(open, cursor);
      if (start < 0) break;
      const end = text.indexOf(close, start + open.length);
      if (end < 0 || end === start) break;
      const utf16End = end + close.length;
      const surface = text.slice(start, utf16End);
      if (surface.length <= 512) {
        out.push({
          kind: "quote",
          surface,
          utf16Start: start,
          utf16End,
          codePointStart: codePointAtUtf16(indexByUtf16, start),
          codePointEnd: codePointAtUtf16(indexByUtf16, utf16End)
        });
      }
      cursor = utf16End;
    }
  }
  return out;
}

function markupCandidates(text: string, indexByUtf16: readonly number[]): CandidateUnit[] {
  return regexSpanCandidates(
    text,
    indexByUtf16,
    "markup_structure",
    /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]{0,1024}>/gu
  );
}

function tableCellCandidates(text: string, indexByUtf16: readonly number[]): CandidateUnit[] {
  const out = regexSpanCandidates(
    text,
    indexByUtf16,
    "table_cell",
    /<(?:td|th)\b[^>]*>[\s\S]*?<\/(?:td|th)>/giu
  );
  let lineStart = 0;
  for (const line of text.split(/(\r?\n)/u)) {
    if (line === "\n" || line === "\r\n") {
      lineStart += line.length;
      continue;
    }
    const separators = [...line.matchAll(/[|\t]/gu)].map(match => match.index ?? 0);
    if (separators.length === 0) {
      lineStart += line.length;
      continue;
    }
    const boundaries = [0, ...separators.map(index => index + 1), line.length];
    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const rawStart = boundaries[index]!;
      const rawEnd = index < separators.length ? separators[index]! : boundaries[index + 1]!;
      const raw = line.slice(rawStart, rawEnd);
      const leading = raw.search(/\S/u);
      if (leading < 0) continue;
      const trimmed = raw.trimEnd();
      const utf16Start = lineStart + rawStart + leading;
      const utf16End = lineStart + rawStart + trimmed.length;
      if (utf16End <= utf16Start) continue;
      out.push({
        kind: "table_cell",
        surface: text.slice(utf16Start, utf16End),
        utf16Start,
        utf16End,
        codePointStart: codePointAtUtf16(indexByUtf16, utf16Start),
        codePointEnd: codePointAtUtf16(indexByUtf16, utf16End)
      });
    }
    lineStart += line.length;
  }
  return out;
}

function lineCandidates(text: string, indexByUtf16: readonly number[]): CandidateUnit[] {
  return structuralSpanCandidates(text, indexByUtf16, "line", /\r?\n/u);
}

function paragraphCandidates(text: string, indexByUtf16: readonly number[]): CandidateUnit[] {
  return structuralSpanCandidates(text, indexByUtf16, "paragraph", /\r?\n\s*\r?\n/u);
}

function structuralSpanCandidates(
  text: string,
  indexByUtf16: readonly number[],
  kind: SurfaceLatticeUnitKind,
  separator: RegExp
): CandidateUnit[] {
  const out: CandidateUnit[] = [];
  let start = 0;
  for (const match of text.matchAll(new RegExp(separator.source, `${separator.flags.includes("u") ? "u" : ""}g`))) {
    const end = match.index ?? 0;
    pushStructuralCandidate(out, text, indexByUtf16, kind, start, end);
    start = end + match[0].length;
  }
  pushStructuralCandidate(out, text, indexByUtf16, kind, start, text.length);
  return out;
}

function pushStructuralCandidate(
  out: CandidateUnit[],
  text: string,
  indexByUtf16: readonly number[],
  kind: SurfaceLatticeUnitKind,
  start: number,
  end: number
): void {
  const surface = text.slice(start, end).trim();
  if (!surface) return;
  const leading = text.slice(start, end).search(/\S/u);
  const utf16Start = start + Math.max(0, leading);
  const utf16End = utf16Start + surface.length;
  out.push({
    kind,
    surface,
    utf16Start,
    utf16End,
    codePointStart: codePointAtUtf16(indexByUtf16, utf16Start),
    codePointEnd: codePointAtUtf16(indexByUtf16, utf16End)
  });
}

function sentenceLikeCandidates(text: string, indexByUtf16: readonly number[]): CandidateUnit[] {
  const out: CandidateUnit[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    const terminal = /[\p{Sentence_Terminal};]/u.test(char);
    if (!terminal) continue;
    const end = i + char.length;
    pushStructuralCandidate(out, text, indexByUtf16, "sentence_like", start, end);
    start = end;
  }
  if (!out.length) pushStructuralCandidate(out, text, indexByUtf16, "sentence_like", 0, text.length);
  return out;
}

function repeatedSequenceCandidates(text: string, segments: ReturnType<typeof segmentUnicodeSurfaceV2>["lexicalSegments"]): CandidateUnit[] {
  const counts = new Map<string, number>();
  const occurrences = new Map<string, Array<{ start: number; end: number }>>();
  for (let width = 2; width <= 4; width++) {
    for (let index = 0; index <= segments.length - width; index++) {
      const window = segments.slice(index, index + width);
      const key = window.map(segment => segment.normalized).join("\u0001");
      counts.set(key, (counts.get(key) ?? 0) + 1);
      const bucket = occurrences.get(key) ?? [];
      if (bucket.length < 16) bucket.push({ start: index, end: index + width });
      occurrences.set(key, bucket);
    }
  }
  const out: CandidateUnit[] = [];
  for (const [key, count] of counts) {
    if (count < 2) continue;
    for (const occurrence of occurrences.get(key) ?? []) {
      const first = segments[occurrence.start];
      const last = segments[occurrence.end - 1];
      if (!first || !last) continue;
      out.push({
        kind: "repeated_sequence",
        surface: text.slice(first.utf16Start, last.utf16End),
        utf16Start: first.utf16Start,
        utf16End: last.utf16End,
        codePointStart: first.codePointStart,
        codePointEnd: last.codePointEnd
      });
    }
  }
  return out;
}

function contextSketch(
  lexical: ReturnType<typeof segmentUnicodeSurfaceV2>["lexicalSegments"],
  codePointPosition: number,
  direction: "left" | "right"
): string[] {
  const nearby = direction === "left"
    ? lexical.filter(segment => segment.codePointEnd <= codePointPosition).slice(-3)
    : lexical.filter(segment => segment.codePointStart >= codePointPosition).slice(0, 3);
  return nearby.map(segment => segment.normalized);
}

function boundaryEvidenceAt(input: {
  text: string;
  positionByte: number;
  positionCodePoint: number;
  positionGrapheme: number;
  structuralBoundary: number;
  transitionEntropyByPosition: ReadonlyMap<number, number>;
  repeatedContextSupport: number;
  learnedFeatures?: Partial<BoundaryFeatureVector>;
  boundaryEstimator?: BoundaryEstimatorState;
}): SurfaceBoundaryEvidence {
  const chars = [...input.text];
  const left = chars[input.positionCodePoint - 1] ?? "";
  const right = chars[input.positionCodePoint] ?? "";
  const whitespaceAdjacent = left && right ? Number(/\s/u.test(left) || /\s/u.test(right)) : 1;
  const punctuationAdjacent = Number(isPunctuation(left) || isPunctuation(right));
  const lineBreakAdjacent = Number(left === "\n" || right === "\n" || left === "\r" || right === "\r");
  const scriptTransition = left && right && !/\s/u.test(left) && !/\s/u.test(right) && dominantScriptId(left) !== dominantScriptId(right) ? 1 : 0;
  const localTransitionEntropy = clamp01((input.transitionEntropyByPosition.get(input.positionCodePoint) ?? 0) / 4);
  const repeatedContextSupport = clamp01(Math.log1p(input.repeatedContextSupport) / 6);
  const features: BoundaryFeatureVector = {
    whitespaceAdjacent,
    punctuationAdjacent,
    lineBreakAdjacent,
    scriptTransition,
    structuralBoundary: input.structuralBoundary,
    localTransitionEntropy,
    repeatedContextSupport,
    crossDocumentRecurrence: clamp01(input.learnedFeatures?.crossDocumentRecurrence ?? 0),
    predictiveCompressionGain: clamp01(input.learnedFeatures?.predictiveCompressionGain ?? 0),
    stableSubstitutionSupport: clamp01(input.learnedFeatures?.stableSubstitutionSupport ?? 0),
    exactPhraseRecurrence: clamp01(input.learnedFeatures?.exactPhraseRecurrence ?? 0),
    constructionReuse: clamp01(input.learnedFeatures?.constructionReuse ?? 0)
  };
  return {
    positionByte: input.positionByte,
    positionCodePoint: input.positionCodePoint,
    positionGrapheme: input.positionGrapheme,
    boundaryProbability: input.boundaryEstimator
      ? scoreBoundaryState(input.boundaryEstimator, features)
      : 0.5,
    estimatorId: input.boundaryEstimator?.id ?? UNTRAINED_BOUNDARY_ESTIMATOR_ID,
    features
  };
}

function corpusBoundaryFeaturesByPosition(input: {
  candidates: readonly QuotientedCandidateUnit[];
  model: ReturnType<typeof segmentUnicodeSurfaceV2>;
  coordinates: SurfaceCoordinateIndex;
  normalizationContract: NormalizationContract;
  context?: CompiledBoundaryFeatureContext;
  hasher: Hasher;
}): Map<number, Partial<BoundaryFeatureVector>> {
  const out = new Map<number, Partial<BoundaryFeatureVector>>();
  if (!input.context) return out;
  for (const candidate of input.candidates) {
    const normalizedIdentity = createCanonicalIdentity({
      kind: "normalized_surface_form",
      fields: {
        normalizationContractId: input.normalizationContract.id,
        normalizedSurface: normalizeSurface(candidate.surface, input.normalizationContract)
      },
      normalizationContract: input.normalizationContract,
      hasher: input.hasher
    });
    const classId = createCanonicalIdentity({
      kind: "surface_form_class",
      fields: {
        normalizationContractId: input.normalizationContract.id,
        normalizedSurfaceFormId: normalizedIdentity.id,
        unicodeScriptId: dominantScriptId(candidate.surface)
      },
      normalizationContract: input.normalizationContract,
      hasher: input.hasher
    }).id;
    const contextKey = boundaryContextKeyParts(
      contextSketch(input.model.lexicalSegments, candidate.codePointStart, "left"),
      contextSketch(input.model.lexicalSegments, candidate.codePointEnd, "right")
    );
    const documentSupport = input.context.documentCountBySurfaceFormClass[classId] ?? 0;
    const classSupport = input.context.classCountByBoundaryContext[contextKey] ?? 0;
    const recurrence = clamp01(Math.log1p(Math.max(0, documentSupport - 1)) / 6);
    const substitution = clamp01(Math.log1p(Math.max(0, classSupport - 1)) / 6);
    const graphemeStart = input.coordinates.utf16ToGraphemeStart[candidate.utf16Start] ?? 0;
    const graphemeEnd = input.coordinates.utf16ToGraphemeEnd[candidate.utf16End] ?? graphemeStart;
    const spanLength = Math.max(1, graphemeEnd - graphemeStart);
    const compression = clamp01(recurrence * (1 - 1 / spanLength));
    for (let position = Math.max(1, graphemeStart); position <= graphemeEnd; position += 1) {
      const current = out.get(position) ?? {};
      out.set(position, {
        crossDocumentRecurrence: Math.max(current.crossDocumentRecurrence ?? 0, recurrence),
        predictiveCompressionGain: Math.max(current.predictiveCompressionGain ?? 0, compression),
        stableSubstitutionSupport: Math.max(current.stableSubstitutionSupport ?? 0, substitution),
        exactPhraseRecurrence: Math.max(current.exactPhraseRecurrence ?? 0, recurrence),
        constructionReuse: Math.max(current.constructionReuse ?? 0, substitution)
      });
    }
  }
  return out;
}

function structuralBoundaryAt(startCodePoint: number, endCodePoint: number, text: string, indexByUtf16: readonly number[]): number {
  const startUtf16 = utf16AtCodePoint(text, startCodePoint);
  const endUtf16 = utf16AtCodePoint(text, endCodePoint);
  const before = text.slice(Math.max(0, startUtf16 - 2), startUtf16);
  const after = text.slice(endUtf16, Math.min(text.length, endUtf16 + 2));
  void indexByUtf16;
  return Number(/\n\s*$/u.test(before) || /^\s*\n/u.test(after));
}

function localTransitionEntropyByPosition(text: string): Map<number, number> {
  const chars = [...text];
  const pairCounts = new Map<string, number>();
  for (let index = 0; index < chars.length - 1; index++) {
    const key = `${charClass(chars[index]!)}\u0001${charClass(chars[index + 1]!)}`;
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }
  const out = new Map<number, number>();
  for (let position = 1; position < chars.length; position++) {
    const window: number[] = [];
    for (let offset = -4; offset <= 4; offset++) {
      const left = chars[position + offset - 1];
      const right = chars[position + offset];
      if (!left || !right) continue;
      window.push(pairCounts.get(`${charClass(left)}\u0001${charClass(right)}`) ?? 1);
    }
    out.set(position, entropy(window));
  }
  return out;
}

function latticeEdges(units: readonly SurfaceLatticeUnit[], hasher: Hasher, maxEdges: number): SurfaceLatticeEdge[] {
  const edges: SurfaceLatticeEdge[] = [];
  const byKind = new Map<SurfaceLatticeUnitKind, SurfaceLatticeUnit[]>();
  for (const unit of units) {
    for (const kind of unit.proposalSources) {
      const bucket = byKind.get(kind) ?? [];
      bucket.push(unit);
      byKind.set(kind, bucket);
    }
  }
  const graphemes = [...(byKind.get("grapheme") ?? [])].sort(comparePersistedUnits);
  for (let index = 0; index < graphemes.length - 1; index += 1) {
    pushEdge(edges, hasher, graphemes[index]!.id, graphemes[index + 1]!.id, "sequence", 1);
  }
  const alternatives = units
    .filter(unit => unit.overlapClass === "segmentation_alternative")
    .sort(comparePersistedUnits);
  for (let leftIndex = 0; leftIndex < alternatives.length && edges.length < maxEdges; leftIndex += 1) {
    const left = alternatives[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < alternatives.length && edges.length < maxEdges; rightIndex += 1) {
      const right = alternatives[rightIndex]!;
      if (right.codePointStart >= left.codePointEnd) break;
      const nested = (left.codePointStart <= right.codePointStart && left.codePointEnd >= right.codePointEnd)
        || (right.codePointStart <= left.codePointStart && right.codePointEnd >= left.codePointEnd);
      if (!nested) pushEdge(edges, hasher, left.id, right.id, "licensed_overlap", 1);
    }
  }
  for (const [kind, items] of byKind) {
    if (kind === "grapheme") continue;
    const sorted = [...items].sort((a, b) => a.codePointStart - b.codePointStart || a.codePointEnd - b.codePointEnd);
    for (let i = 0; i < sorted.length - 1 && edges.length < maxEdges; i++) {
      pushEdge(edges, hasher, sorted[i]!.id, sorted[i + 1]!.id, "sequence", kind === "lexical" ? 0.92 : 0.72);
    }
  }
  const lexical = units.filter(unit => unit.proposalSources.includes("lexical"));
  const containers = units.filter(unit =>
    unit.proposalSources.some(kind =>
      kind === "line"
      || kind === "sentence_like"
      || kind === "paragraph"
      || kind === "repeated_sequence"
      || kind === "phrase_candidate"
      || kind === "quote"
      || kind === "markup_structure"
      || kind === "table_cell")
  );
  for (const container of containers) {
    for (const unit of lexical) {
      if (edges.length >= maxEdges) break;
      if (unit.codePointStart >= container.codePointStart && unit.codePointEnd <= container.codePointEnd && unit.id !== container.id) {
        pushEdge(edges, hasher, container.id, unit.id, "contains", 0.8);
      }
    }
  }
  const recurring = new Map<string, SurfaceLatticeUnit[]>();
  for (const unit of units.filter(item => item.recurrenceCount > 1 && !item.proposalSources.includes("grapheme"))) {
    const bucket = recurring.get(unit.surfaceFormClassId) ?? [];
    bucket.push(unit);
    recurring.set(unit.surfaceFormClassId, bucket);
  }
  for (const items of recurring.values()) {
    const sorted = [...items].sort((a, b) => a.codePointStart - b.codePointStart);
    for (let i = 0; i < sorted.length - 1 && edges.length < maxEdges; i++) {
      pushEdge(edges, hasher, sorted[i]!.id, sorted[i + 1]!.id, "recurs_with", clamp01(Math.log1p(sorted.length) / 6));
    }
  }
  return [...new Map(edges.map(edge => [edge.id, edge])).values()];
}

function pushEdge(
  edges: SurfaceLatticeEdge[],
  hasher: Hasher,
  fromUnitId: string,
  toUnitId: string,
  kind: SurfaceLatticeEdgeKind,
  weight: number
): void {
  edges.push({
    id: `surface_edge.${hasher.digestHex(JSON.stringify([fromUnitId, toUnitId, kind])).slice(0, 32)}`,
    fromUnitId,
    toUnitId,
    kind,
    weight: clamp01(weight)
  });
}

function quotientCandidateUnits(
  candidates: readonly CandidateUnit[],
  coordinates: SurfaceCoordinateIndex
): QuotientedCandidateUnit[] {
  const groups = new Map<string, CandidateUnit[]>();
  for (const candidate of candidates) {
    if (!candidate.surface) continue;
    const byteStart = coordinates.utf16ToByte[candidate.utf16Start] ?? 0;
    const byteEnd = coordinates.utf16ToByte[candidate.utf16End] ?? byteStart;
    const key = `${byteStart}\u001f${byteEnd}\u001f${candidate.surface}`;
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, proposals]) => {
      const ordered = [...proposals].sort(compareCandidateUnits);
      const representative = ordered.find(candidate => candidate.kind === "grapheme")
        ?? [...ordered].sort((left, right) =>
          proposalPriority(left.kind) - proposalPriority(right.kind)
          || compareCandidateUnits(left, right))[0]!;
      return {
        ...representative,
        proposalSources: [...new Set(proposals.map(candidate => candidate.kind))].sort()
      };
    });
}

function proposalPriority(kind: SurfaceLatticeUnitKind): number {
  if (["date", "numeric", "quote", "code_symbol", "markup_structure", "table_cell"].includes(kind)) return 0;
  if (["repeated_sequence", "phrase_candidate", "sentence_like", "paragraph", "line"].includes(kind)) return 1;
  if (kind === "lexical") return 2;
  return 3;
}

function recurrenceKey(
  candidate: CandidateUnit,
  normalizationContract: NormalizationContract
): string {
  return normalizeSurface(candidate.surface, normalizationContract);
}

function normalizeSurface(
  surface: string,
  normalizationContract: NormalizationContract
): string {
  return normalizeCanonicalSurface(surface, normalizationContract).replace(/\s+/gu, " ").trim();
}

function overlapClassFor(kind: SurfaceLatticeUnitKind): SurfaceLatticeOverlapClass {
  if (kind === "grapheme") return "base_partition";
  if (kind === "line" || kind === "paragraph" || kind === "markup_structure" || kind === "table_cell") return "structure";
  return "segmentation_alternative";
}

function comparePersistedUnits(left: SurfaceLatticeUnit, right: SurfaceLatticeUnit): number {
  return left.utf16Start - right.utf16Start
    || left.utf16End - right.utf16End
    || unitKindRank(left.kind) - unitKindRank(right.kind)
    || left.id.localeCompare(right.id);
}

function compareCandidateUnits(left: CandidateUnit, right: CandidateUnit): number {
  return left.codePointStart - right.codePointStart
    || left.codePointEnd - right.codePointEnd
    || unitKindRank(left.kind) - unitKindRank(right.kind)
    || left.surface.localeCompare(right.surface);
}

function unitKindRank(kind: SurfaceLatticeUnitKind): number {
  return [
    "paragraph",
    "line",
    "sentence_like",
    "repeated_sequence",
    "markup_structure",
    "table_cell",
    "quote",
    "date",
    "numeric",
    "code_symbol",
    "phrase_candidate",
    "lexical",
    "surface_segment",
    "grapheme"
  ].indexOf(kind);
}

function frequency(symbols: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const symbol of symbols) out.set(symbol, (out.get(symbol) ?? 0) + 1);
  return out;
}

function isPunctuation(value: string): boolean {
  return Boolean(value && /\p{Punctuation}/u.test(value));
}

function charClass(value: string): string {
  if (!value) return "boundary";
  if (/\s/u.test(value)) return "space";
  if (/\p{Number}/u.test(value)) return "number";
  if (/\p{Punctuation}/u.test(value)) return "punctuation";
  return dominantScriptId(value);
}
