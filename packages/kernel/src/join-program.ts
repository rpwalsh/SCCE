// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { buildSurfaceScalarCoordinateIndex, normalizeSurfaceLatticeSurface, type SurfaceLattice, type SurfaceLatticeUnit } from "./surface-lattice.js";
import { exportSegmentationAdjacencyFactors, segmentationSurfaceAdjacencies } from "./segmentation-forest.js";
import { createSegmentationAdjacencyQuery, validateSegmentationAdjacencyFactors, type SegmentationAdjacencyFactors } from "./segmentation-adjacency-factors.js";
import { createNormalizedSurfaceFormIdentity, createSurfaceFormClassIdentity } from "./canonical-identity.js";
import { dominantScriptId } from "./unicode-segmentation-v2.js";
import { clamp01, createHasher, toJsonValue } from "./primitives.js";
import type { Hasher, JsonValue } from "./types.js";
import {
  canonicalNormalizationContract,
  canonicalGraphemeSegmenter,
  normalizeCanonicalSurface,
  assertNormalizationContract,
  type NormalizationContract
} from "./normalization-contract.js";

export const JOIN_PROGRAM_SCHEMA = "scce.join_program.v4" as const;
export const JOIN_PROGRAM_MIXTURE_SCHEMA = "scce.join_program_mixture.v4" as const;
export const JOIN_PROGRAM_LOCAL_FACTORS_SCHEMA = "scce.join_program_local_factors.v1" as const;
export const JOIN_PROGRAM_GLOBAL_FACTORS_SCHEMA = "scce.join_program_global_factors.v1" as const;

export interface JoinGlobalFactorDocument {
  constructionId?: string;
  discourseStateId?: string;
  normalizedOverrides?: Array<[arcIndex: number, normalized: string]>;
  baseChoices: number[];
  paths: Array<[posterior: number, overrides: number[]]>;
}
export interface JoinProgramGlobalFactors {
  schema: typeof JOIN_PROGRAM_GLOBAL_FACTORS_SCHEMA;
  documents: JoinGlobalFactorDocument[];
}

export interface JoinLocalFactorDocument {
  documentId: string;
  constructionId?: string;
  sourceVersionId?: string;
  text: string;
  evidenceIds: string[];
  contexts: Array<[scaleId: string] | [scaleId: string, explicitSurfaceFormClassId: string]>;
  graph: SegmentationAdjacencyFactors;
  units: Array<null | [contextIndex: number, boundaryBucket: number, evidenceRefs: number[]] | [contextIndex: number, boundaryBucket: number, evidenceRefs: number[], utf16Start: number, utf16End: number]>;
}
export interface JoinProgramLocalFactors {
  schema: typeof JOIN_PROGRAM_LOCAL_FACTORS_SCHEMA;
  normalizationContract: NormalizationContract;
  documents: JoinLocalFactorDocument[];
}

function sourceGeometry(text: string): { utf16: number[]; bytes: number[]; utf16Bytes: number[] } {
  const utf16 = [0], bytes = [0], utf16Bytes = buildSurfaceScalarCoordinateIndex(text).utf16ToByte;
  for (const segment of canonicalGraphemeSegmenter().segment(text)) {
    utf16.push(segment.index + segment.segment.length);
    bytes.push(utf16Bytes[utf16.at(-1)!]!);
  }
  return { utf16, bytes, utf16Bytes };
}

function splitsCodePoint(text: string, index: number): boolean {
  const before = text.charCodeAt(index - 1), after = text.charCodeAt(index);
  return before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF;
}

export function isJoinProgramLocalFactors(value: unknown): value is JoinProgramLocalFactors {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    if (row.schema !== JOIN_PROGRAM_LOCAL_FACTORS_SCHEMA || Object.keys(row).some(key => !["schema", "normalizationContract", "documents"].includes(key)) || !Array.isArray(row.documents)) return false;
    assertNormalizationContract(row.normalizationContract as NormalizationContract);
    const documentIds = new Set<string>();
    for (const raw of Array.from(row.documents)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
      const doc = raw as Record<string, unknown>;
      if (Object.keys(doc).some(key => !["documentId", "constructionId", "sourceVersionId", "text", "evidenceIds", "contexts", "graph", "units"].includes(key))
        || typeof doc.documentId !== "string" || !doc.documentId || documentIds.has(doc.documentId) || typeof doc.text !== "string"
        || (Object.hasOwn(doc, "constructionId") && (typeof doc.constructionId !== "string" || !doc.constructionId))
        || (Object.hasOwn(doc, "sourceVersionId") && typeof doc.sourceVersionId !== "string") || !Array.isArray(doc.evidenceIds)
        || !Array.from(doc.evidenceIds).every(id => typeof id === "string") || new Set(doc.evidenceIds).size !== doc.evidenceIds.length || !Array.isArray(doc.units)
        || !Array.isArray(doc.contexts) || !Array.from(doc.contexts).every(context => Array.isArray(context) && (context.length === 1 || context.length === 2)
          && typeof context[0] === "string" && context[0].length > 0 && (context.length === 1 || typeof context[1] === "string" && context[1].length > 0))
        || new Set(doc.contexts.map(context => JSON.stringify(context))).size !== doc.contexts.length) return false;
      const evidenceIds = doc.evidenceIds;
      documentIds.add(doc.documentId);
      validateSegmentationAdjacencyFactors(doc.graph);
      const geometry = sourceGeometry(doc.text);
      if (doc.graph.nodeCount !== geometry.utf16.length || doc.units.length !== doc.graph.arcs.length) return false;
      for (let index = 0; index < doc.units.length; index++) {
        const unit = doc.units[index], arc = doc.graph.arcs[index]!;
        const start = Array.isArray(unit) && unit.length === 5 ? unit[3] : geometry.utf16[arc[0]]!;
        const end = Array.isArray(unit) && unit.length === 5 ? unit[4] : geometry.utf16[arc[1]]!;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < geometry.utf16[arc[0]]! || start >= geometry.utf16[arc[0] + 1]!
          || end <= geometry.utf16[arc[1] - 1]! || end > geometry.utf16[arc[1]]!
          || start >= end || splitsCodePoint(doc.text, start) || splitsCodePoint(doc.text, end)) return false;
        const bearing = isSurfaceBearingText(doc.text.slice(start, end));
        if (unit === null) { if (bearing) return false; continue; }
        if (!bearing || !Array.isArray(unit) || (unit.length !== 3 && unit.length !== 5) || !Number.isSafeInteger(unit[0]) || unit[0] < 0 || unit[0] >= doc.contexts.length
          || !Number.isSafeInteger(unit[1]) || unit[1] < 0 || unit[1] > boundaryBucket(1) || !Array.isArray(unit[2])
          || !Array.from(unit[2]).every(ref => typeof ref === "number" && Number.isSafeInteger(ref) && ref >= 0 && ref < evidenceIds.length)
          || new Set(unit[2]).size !== unit[2].length) return false;
      }
    }
    return true;
  } catch { return false; }
}

export interface JoinEvidenceCoordinate {
  evidenceId: string;
  sourceVersionId?: string;
  documentId: string;
  byteStart: number;
  byteEnd: number;
  utf16Start: number;
  utf16End: number;
  exactSurfaceHash: string;
}

export interface JoinProgramChoice {
  surface: string;
  count: number;
  probability: number;
  evidenceIds: string[];
  evidenceCoordinates: JoinEvidenceCoordinate[];
}

export interface JoinProgramEvaluation {
  heldoutDocumentIds: string[];
  selectionDocumentIds: string[];
  observations: number;
  exactAccuracy: number | null;
  negativeLogLikelihood: number | null;
  expectedCalibrationError: number | null;
  reconstructionAccuracy: number | null;
  whitespaceInsertionErrors: number;
  whitespaceDeletionErrors: number;
  punctuationErrors: number;
  crossScriptAccuracy: number | null;
}

export interface JoinProgramModel {
  schema: typeof JOIN_PROGRAM_SCHEMA;
  id: string;
  populationId: string;
  observations: number;
  minimumConfidence: number;
  conditionedIndex: Record<string, JoinProgramChoice[]>;
  exactIndex: Record<string, JoinProgramChoice[]>;
  structuralIndex: Record<string, JoinProgramChoice[]>;
  classIndex: Record<string, JoinProgramChoice[]>;
  localShapeIndex: Record<string, JoinProgramChoice[]>;
  constructionIndex: Record<string, JoinProgramChoice[]>;
  localFactors?: JoinProgramLocalFactors;
  globalFactors?: JoinProgramGlobalFactors;
  backoffReliability: Record<JoinBackoffSource, number>;
  sourceDocumentIds: string[];
  trainingDocumentIds: string[];
  evaluation: JoinProgramEvaluation;
  audit: JsonValue;
}

export type JoinBackoffSource =
  | "conditioned"
  | "exact"
  | "structural"
  | "class"
  | "local_shape"
  | "construction";

export interface JoinProgramMixture {
  schema: typeof JOIN_PROGRAM_MIXTURE_SCHEMA;
  id: string;
  populationModelId: string;
  minimumConfidence: number;
  components: Array<{
    populationId: string;
    weight: number;
    program: JoinProgramModel;
  }>;
}

export interface JoinUnitContext {
  surfaceFormClassId: string;
  scaleId: string;
  graphemeWidth: number;
}

export interface JoinBoundaryContext {
  boundaryProbability: number;
  constructionId?: string;
  discourseStateId?: string;
  derivationShapeId?: string;
}

export interface JoinRenderContext {
  units?: readonly JoinUnitContext[];
  boundaries?: readonly JoinBoundaryContext[];
  populationPosterior?: Readonly<Record<string, number>>;
  observedSourceSpan?: {
    text: string;
    evidenceIds: string[];
    coordinates?: JoinEvidenceCoordinate;
  };
}

export interface JoinProgramTraceStep {
  left: string;
  right: string;
  join: string;
  source: JoinBackoffSource | "preserved_source_span" | "unresolved";
  support: number;
  alternatives: JoinProgramChoice[];
  evidenceIds: string[];
  evidenceCoordinates: JoinEvidenceCoordinate[];
  unresolvedPopulationMass: number;
  contextKey?: string;
}

export interface JoinedSurface {
  text: string;
  trace: JoinProgramTraceStep[];
  unresolvedBoundaries: number;
  status: "resolved" | "preserved_source_span" | "unresolved";
  requiredAction?: "try_alternate_derivation" | "request_additional_evidence";
  selectedDerivationIndex?: number;
}

interface JoinCount {
  surface: string;
  count: number;
  evidenceIds: Set<string>;
  evidenceCoordinates: Map<string, JoinEvidenceCoordinate>;
}

interface JoinEvent {
  left: SurfaceLatticeUnit;
  right: SurfaceLatticeUnit;
  join: string;
  weight: number;
  evidenceIds: string[];
  evidenceCoordinates: JoinEvidenceCoordinate[];
  conditionedKey?: string;
  exactKey: string;
  structuralKey?: string;
  classKey: string;
  localShapeKey: string;
  constructionKey?: string;
  crossScript: boolean;
}

export function compileJoinProgram(input: {
  populationId: string;
  documents: readonly {
    documentId: string;
    sourceFamilyId?: string;
    text: string;
    lattice: SurfaceLattice;
    constructionId?: string;
    discourseStateId?: string;
  }[];
  minimumConfidence?: number;
  hasher?: Hasher;
}): JoinProgramModel {
  const hasher = input.hasher ?? createHasher();
  const documents = [...input.documents].sort((left, right) =>
    left.documentId.localeCompare(right.documentId));
  const split = sourceFamilyDisjointSplit(documents, hasher);
  const localShapes = new Map<string, Map<string, JoinCount>>();
  const constructions = new Map<string, Map<string, JoinCount>>();
  const localFactors = compileLocalFactors(split.training);
  const globalFactors = compileGlobalFactors(split.training, localFactors.normalizationContract);
  let observations = 0;
  for (const document of split.training) {
    for (const event of localJoinEvents(document)) {
      addCount(localShapes, event.localShapeKey, event.join, event.evidenceIds, event.evidenceCoordinates, event.weight, evidenceCoordinateKey);
      if (event.constructionKey) {
        addCount(constructions, event.constructionKey, event.join, event.evidenceIds, event.evidenceCoordinates, event.weight, evidenceCoordinateKey);
      }
      observations += event.weight;
    }
  }
  const conditionedIndex = {};
  const exactIndex = {};
  const structuralIndex = {};
  const classIndex = {};
  const localShapeIndex = compileIndex(localShapes);
  const constructionIndex = compileIndex(constructions);
  const indexes = {
    conditionedIndex,
    exactIndex,
    structuralIndex,
    classIndex,
    localShapeIndex,
    constructionIndex,
    localFactors,
    globalFactors
  };
  const backoffReliability = learnBackoffReliability(split.selection, indexes);
  const learnedMinimumConfidence = input.minimumConfidence === undefined
    ? selectConfidenceThreshold(split.selection, indexes, backoffReliability)
    : clamp01(input.minimumConfidence);
  const evaluation = evaluateHeldoutJoins({
    documents: split.evaluation,
    selectionDocumentIds: split.selection.map(document => document.documentId),
    ...indexes,
    backoffReliability,
    minimumConfidence: learnedMinimumConfidence
  });
  const sourceDocumentIds = documents.map(document => document.documentId);
  const canonical = {
    schema: JOIN_PROGRAM_SCHEMA,
    populationId: input.populationId,
    observations: positivePrecision(observations),
    minimumConfidence: learnedMinimumConfidence,
    ...indexes,
    backoffReliability,
    sourceDocumentIds,
    trainingDocumentIds: split.training.map(document => document.documentId),
    evaluation
  };
  return {
    ...canonical,
    id: `join_program.${hasher.digestHex(JSON.stringify(canonical)).slice(0, 40)}`,
    audit: toJsonValue({
      compiler: "kernel.join_program.v6",
      globalContextRepresentation: "retained_path_decisions",
      retainedGlobalPaths: globalFactors.documents.reduce((total, document) => total + document.paths.length, 0),
      conditionedContextCount: Object.keys(conditionedIndex).length,
      exactContextCount: Object.keys(exactIndex).length,
      structuralContextCount: Object.keys(structuralIndex).length,
      classContextCount: Object.keys(classIndex).length,
      localShapeContextCount: Object.keys(localShapeIndex).length,
      constructionContextCount: Object.keys(constructionIndex).length,
      backoffReliability,
      sourceExactJoins: true,
      derivationConditioned: true,
      populationConditionedByMixture: true,
      globalJoinFallback: false,
      languageGrammarLabels: false,
      confidenceSelection: input.minimumConfidence === undefined
        ? "heldout_selective_risk"
        : "explicit",
      heldoutEvaluation: split.evaluation.length > 0,
      sourceFamilyDisjoint: true,
      exactEvidenceCoordinates: true
    })
  };
}

export function compileJoinProgramMixture(input: {
  populationModelId: string;
  components: readonly {
    populationId: string;
    weight: number;
    program: JoinProgramModel;
  }[];
  minimumConfidence?: number;
  hasher?: Hasher;
}): JoinProgramMixture {
  const hasher = input.hasher ?? createHasher();
  const components = [...input.components]
    .filter(component => component.weight > 0)
    .sort((left, right) => left.populationId.localeCompare(right.populationId))
    .map(component => ({ ...component, weight: quantize(component.weight) }));
  const minimumConfidence = Math.min(1, Math.max(
    0,
    input.minimumConfidence
      ?? Math.max(0, ...components.map(component => component.program.minimumConfidence))
  ));
  const canonical = {
    schema: JOIN_PROGRAM_MIXTURE_SCHEMA,
    populationModelId: input.populationModelId,
    minimumConfidence,
    components: components.map(component => ({
      populationId: component.populationId,
      weight: component.weight,
      programId: component.program.id
    }))
  };
  return {
    ...canonical,
    id: `join_program_mixture.${hasher.digestHex(JSON.stringify(canonical)).slice(0, 40)}`,
    components
  };
}

export function composeJoinProgramMixtures(input: {
  mixtures: readonly JoinProgramMixture[];
  populationPosterior?: Readonly<Record<string, number>>;
  hasher?: Hasher;
}): JoinProgramMixture | undefined {
  const byProgram = new Map<string, {
    populationId: string;
    weight: number;
    program: JoinProgramModel;
  }>();
  const outerWeight = 1 / Math.max(1, input.mixtures.length);
  for (const mixture of input.mixtures) {
    const componentWeights = normalizedComponentWeights(
      mixture,
      input.populationPosterior
    );
    for (const component of mixture.components) {
      const weight = outerWeight * (componentWeights.get(component.populationId) ?? 0);
      const current = byProgram.get(component.program.id);
      if (current) current.weight += weight;
      else byProgram.set(component.program.id, { ...component, weight });
    }
  }
  if (!byProgram.size) return undefined;
  const modelIds = input.mixtures.map(mixture => mixture.populationModelId).sort();
  return compileJoinProgramMixture({
    populationModelId: `population_model.composed.${(input.hasher ?? createHasher())
      .digestHex(JSON.stringify(modelIds)).slice(0, 32)}`,
    components: [...byProgram.values()],
    hasher: input.hasher
  });
}

export function renderJoinedSurface(
  units: readonly string[],
  mixture: JoinProgramMixture | undefined,
  context: JoinRenderContext = {}
): JoinedSurface {
  if (!units.length) {
    return { text: "", trace: [], unresolvedBoundaries: 0, status: "resolved" };
  }
  let text = units[0] ?? "";
  const trace: JoinProgramTraceStep[] = [];
  for (let index = 1; index < units.length; index += 1) {
    const left = units[index - 1] ?? "";
    const right = units[index] ?? "";
    const derivationShapeId = units.map(unit =>
      `runtime:${Math.max(1, [...unit].length)}`).join("\u001f");
    const leftContext = context.units?.[index - 1]
      ?? inferredJoinUnitContext(left);
    const rightContext = context.units?.[index]
      ?? inferredJoinUnitContext(right);
    const boundaryContext = context.boundaries?.[index - 1]
      ?? {
        boundaryProbability: 0.5,
        derivationShapeId
      };
    const selected = mixture
      ? selectJoin(
        mixture,
        left,
        right,
        leftContext,
        rightContext,
        boundaryContext,
        context.populationPosterior
      )
      : undefined;
    if (!selected || selected.support < (mixture?.minimumConfidence ?? 1)) {
      const alternatives = selected?.alternatives ?? [];
      if (context.observedSourceSpan) {
        trace.push({
          left,
          right,
          join: "",
          source: "preserved_source_span",
          support: selected?.support ?? 0,
          alternatives,
          evidenceIds: [...context.observedSourceSpan.evidenceIds],
          evidenceCoordinates: context.observedSourceSpan.coordinates
            ? [context.observedSourceSpan.coordinates]
            : [],
          unresolvedPopulationMass: selected?.unresolvedPopulationMass ?? 1,
          ...(selected?.contextKey ? { contextKey: selected.contextKey } : {})
        });
        return {
          text: context.observedSourceSpan.text,
          trace,
          unresolvedBoundaries: 1,
          status: "preserved_source_span"
        };
      }
      trace.push({
        left,
        right,
        join: "",
        source: "unresolved",
        support: selected?.support ?? 0,
        alternatives,
        evidenceIds: selected?.evidenceIds ?? [],
        evidenceCoordinates: selected?.evidenceCoordinates ?? [],
        unresolvedPopulationMass: selected?.unresolvedPopulationMass ?? 1,
        ...(selected?.contextKey ? { contextKey: selected.contextKey } : {})
      });
      return {
        text: "",
        trace,
        unresolvedBoundaries: 1,
        status: "unresolved",
        requiredAction: "try_alternate_derivation"
      };
    }
    text += selected.surface + right;
    trace.push({
      left,
      right,
      join: selected.surface,
      source: selected.source,
      support: selected.support,
      alternatives: selected.alternatives,
      evidenceIds: selected.evidenceIds,
      evidenceCoordinates: selected.evidenceCoordinates,
      unresolvedPopulationMass: selected.unresolvedPopulationMass,
      ...(selected.contextKey ? { contextKey: selected.contextKey } : {})
    });
  }
  return { text, trace, unresolvedBoundaries: 0, status: "resolved" };
}

export function renderJoinedSurfaceAlternatives(input: {
  derivations: readonly (readonly string[])[];
  mixture: JoinProgramMixture | undefined;
  contexts?: readonly JoinRenderContext[];
}): JoinedSurface {
  let preserved: JoinedSurface | undefined;
  for (let index = 0; index < input.derivations.length; index += 1) {
    const rendered = renderJoinedSurface(
      input.derivations[index]!,
      input.mixture,
      input.contexts?.[index]
    );
    if (rendered.status === "resolved") {
      return { ...rendered, selectedDerivationIndex: index };
    }
    if (!preserved && rendered.status === "preserved_source_span") {
      preserved = { ...rendered, selectedDerivationIndex: index };
    }
  }
  if (preserved) return preserved;
  return {
    text: "",
    trace: [],
    unresolvedBoundaries: Math.max(1, input.derivations.length),
    status: "unresolved",
    requiredAction: "request_additional_evidence"
  };
}

export function isJoinProgramMixture(value: unknown): value is JoinProgramMixture {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.schema === JOIN_PROGRAM_MIXTURE_SCHEMA
    && typeof row.id === "string"
    && typeof row.populationModelId === "string"
    && typeof row.minimumConfidence === "number"
    && Array.isArray(row.components)
    && row.components.every(component => {
      if (!component || typeof component !== "object" || Array.isArray(component)) return false;
      const item = component as Record<string, unknown>;
      return typeof item.populationId === "string"
        && typeof item.weight === "number"
        && Boolean(item.program && typeof item.program === "object" && !Array.isArray(item.program)
          && (item.program as Record<string, unknown>).schema === JOIN_PROGRAM_SCHEMA);
    });
}

function selectJoin(
  mixture: JoinProgramMixture,
  left: string,
  right: string,
  leftContext?: JoinUnitContext,
  rightContext?: JoinUnitContext,
  boundaryContext?: JoinBoundaryContext,
  populationPosterior?: Readonly<Record<string, number>>
): (JoinProgramChoice & {
  source: JoinBackoffSource;
  support: number;
  unresolvedPopulationMass: number;
  alternatives: JoinProgramChoice[];
  contextKey?: string;
}) | undefined {
  const keys: Array<{
    key: string;
    source: JoinBackoffSource;
  }> = [];
  if (leftContext && rightContext && boundaryContext) {
    keys.push({
      key: conditionedJoinKey({
        left: normalize(left),
        right: normalize(right),
        leftContext,
        rightContext,
        boundaryContext
      }),
      source: "conditioned"
    });
    keys.push({
      key: structuralJoinKey(left, right, leftContext, rightContext, boundaryContext),
      source: "structural"
    });
    keys.push({
      key: classJoinKey(leftContext, rightContext, boundaryContext),
      source: "class"
    });
    keys.push({
      key: localShapeJoinKey(left, right),
      source: "local_shape"
    });
    if (boundaryContext.constructionId) {
      keys.push({
        key: constructionJoinKey(left, right, boundaryContext.constructionId),
        source: "construction"
      });
    }
  }
  keys.splice(keys.length > 0 ? 1 : 0, 0, {
    key: exactJoinKey(normalize(left), normalize(right)),
    source: "exact"
  });
  const factors = keys.map(({ key, source }) => {
    const aggregate = aggregateChoices(mixture, key, source, populationPosterior);
    return { source, alternatives: aggregate.choices, unresolvedPopulationMass: aggregate.unresolvedPopulationMass, contextKey: key };
  });
  const selected = strongestJoinFactor(factors, factor => factor.alternatives[0]!.probability);
  if (!selected) return undefined;
  const proven = aggregateChoices(mixture, selected.contextKey, selected.source, populationPosterior, true);
  return { ...proven.choices[0]!, ...selected, alternatives: proven.choices, support: selected.alternatives[0]!.probability };
}

function strongestJoinFactor<T extends { alternatives: JoinProgramChoice[] }>(factors: readonly T[], support: (factor: T) => number): T | undefined {
  let selected: T | undefined, best = Number.NEGATIVE_INFINITY;
  for (const factor of factors) {
    if (!factor.alternatives.length) continue;
    const score = support(factor);
    if (score > best) { selected = factor; best = score; }
  }
  return selected;
}

function compareJoinChoices(left: JoinProgramChoice, right: JoinProgramChoice, reliability = 1): number {
  return (right.probability - left.probability) * reliability || left.surface.localeCompare(right.surface);
}

function aggregateChoices(
  mixture: JoinProgramMixture,
  key: string,
  source: JoinBackoffSource,
  populationPosterior?: Readonly<Record<string, number>>,
  proofs = false
): { choices: JoinProgramChoice[]; unresolvedPopulationMass: number } {
  const componentWeights = normalizedComponentWeights(mixture, populationPosterior);
  const probabilities = new Map<string, JoinCount>();
  let unresolvedPopulationMass = 0;
  for (const component of mixture.components) {
    const weight = componentWeights.get(component.populationId) ?? 0;
    if (weight <= 0) continue;
    const rows = choicesForIndex(component.program, source, key, proofs);
    if (!rows.length) {
      unresolvedPopulationMass += weight;
      continue;
    }
    const reliability = clamp01(component.program.backoffReliability?.[source] ?? 1);
    unresolvedPopulationMass += weight * (1 - reliability);
    unresolvedPopulationMass += weight * reliability * clamp01(1 - rows.reduce((sum, row) => sum + row.probability, 0));
    for (const row of rows) {
      const weighted = row.probability * weight * reliability;
      const current = probabilities.get(row.surface) ?? {
        surface: row.surface,
        count: 0,
        evidenceIds: new Set<string>(),
        evidenceCoordinates: new Map<string, JoinEvidenceCoordinate>()
      };
      current.count += weighted;
      for (const id of row.evidenceIds) current.evidenceIds.add(id);
      for (const coordinate of proofs ? row.evidenceCoordinates ?? [] : []) {
        current.evidenceCoordinates.set(evidenceCoordinateKey(coordinate), coordinate);
      }
      probabilities.set(row.surface, current);
    }
  }
  const result = [...probabilities.values()]
    .map(row => ({
      surface: row.surface,
      count: row.count,
      probability: row.count,
      evidenceIds: [...row.evidenceIds].sort(),
      evidenceCoordinates: [...row.evidenceCoordinates.values()]
        .sort(compareEvidenceCoordinates)
    }))
    .sort((left, right) => compareJoinChoices(left, right));
  return {
    choices: result,
    unresolvedPopulationMass: clamp01(unresolvedPopulationMass)
  };
}

type JoinDocument = Parameters<typeof compileJoinProgram>[0]["documents"][number];

function canonicalSurfaceResolver(normalizationContract: NormalizationContract): (surface: string) => { normalized: string; classId: string } {
  const surfaces = new Map<string, { normalized: string; classId: string }>(), forms = new Map<string, string>(), classes = new Map<string, string>(), hasher = createHasher();
  return surface => {
    const cached = surfaces.get(surface); if (cached) return cached;
    const normalized = normalizeSurfaceLatticeSurface(surface, normalizationContract);
    let normalizedSurfaceFormId = forms.get(normalized);
    if (normalizedSurfaceFormId === undefined) {
      normalizedSurfaceFormId = createNormalizedSurfaceFormIdentity({ normalizedSurface: normalized, normalizationContract, hasher }).id;
      forms.set(normalized, normalizedSurfaceFormId);
    }
    const unicodeScriptId = dominantScriptId(surface), key = JSON.stringify([normalizedSurfaceFormId, unicodeScriptId]);
    let classId = classes.get(key);
    if (classId === undefined) {
      classId = createSurfaceFormClassIdentity({ normalizedSurfaceFormId, unicodeScriptId, normalizationContract, hasher }).id;
      classes.set(key, classId);
    }
    const result = { normalized, classId }; surfaces.set(surface, result); return result;
  };
}

function compileLocalFactors(documents: readonly JoinDocument[]): JoinProgramLocalFactors {
  const normalizationContract = structuredClone(documents[0]?.lattice.normalizationContract ?? canonicalNormalizationContract());
  assertNormalizationContract(normalizationContract);
  for (const document of documents) assertNormalizationContract(document.lattice.normalizationContract);
  const canonicalSurface = canonicalSurfaceResolver(normalizationContract);
  return { schema: JOIN_PROGRAM_LOCAL_FACTORS_SCHEMA, normalizationContract, documents: documents.map(document => {
    const exported = exportSegmentationAdjacencyFactors(document.lattice.segmentationForest);
    const byId = new Map(document.lattice.units.map(unit => [unit.id, unit])), geometry = sourceGeometry(document.text);
    const measuredUnits = exported.unitIds.map(id => requiredUnit(byId, id)).filter(isSurfaceBearingUnit);
    const evidenceIds = [...new Set(measuredUnits.flatMap(unit => unit.evidenceIds))].sort();
    const evidenceIndex = new Map(evidenceIds.map((id, index) => [id, index]));
    const contextKey = (unit: SurfaceLatticeUnit) => JSON.stringify(canonicalSurface(unit.surface).classId === unit.surfaceFormClassId
      ? [unit.kind] : [unit.kind, unit.surfaceFormClassId]);
    const contextKeys = [...new Set(measuredUnits.map(contextKey))].sort();
    const contexts = contextKeys.map(key => JSON.parse(key) as JoinLocalFactorDocument["contexts"][number]), contextIndex = new Map(contextKeys.map((key, index) => [key, index]));
    return { documentId: document.documentId, ...(document.constructionId ? { constructionId: document.constructionId } : {}), text: document.text, ...(document.lattice.sourceVersionId ? { sourceVersionId: document.lattice.sourceVersionId } : {}),
      evidenceIds, contexts, graph: exported.factors, units: exported.unitIds.map((id, index): JoinLocalFactorDocument["units"][number] => {
        const unit = requiredUnit(byId, id);
        if (!isSurfaceBearingUnit(unit)) return null;
        const row: [number, number, number[]] = [contextIndex.get(contextKey(unit))!, boundaryBucket(unit.boundaryAfter.boundaryProbability),
          [...new Set(unit.evidenceIds.map(evidenceId => evidenceIndex.get(evidenceId)!))].sort((a, b) => a - b)];
        const arc = exported.factors.arcs[index]!;
        return unit.utf16Start === geometry.utf16[arc[0]] && unit.utf16End === geometry.utf16[arc[1]] ? row : [...row, unit.utf16Start, unit.utf16End];
      }) };
  }) };
}

function compileGlobalFactors(documents: readonly JoinDocument[], contract: NormalizationContract): JoinProgramGlobalFactors {
  const normalized = new Map<string, string>();
  return { schema: JOIN_PROGRAM_GLOBAL_FACTORS_SCHEMA, documents: documents.map(document => {
    const { factors, unitIds } = exportSegmentationAdjacencyFactors(document.lattice.segmentationForest);
    const indices = new Map(unitIds.map((id, index) => [id, index])), degree = new Uint32Array(factors.nodeCount);
    const byId = new Map(document.lattice.units.map(unit => [unit.id, unit])), normalizedOverrides: Array<[number, string]> = [];
    unitIds.forEach((id, index) => {
      const unit = requiredUnit(byId, id); if (!isSurfaceBearingUnit(unit)) return;
      let expected = normalized.get(unit.surface);
      if (expected === undefined) { expected = normalizeSurfaceLatticeSurface(unit.surface, contract); normalized.set(unit.surface, expected); }
      if (unit.normalized !== expected) normalizedOverrides.push([index, unit.normalized]);
    });
    for (const [start] of factors.arcs) degree[start] = degree[start]! + 1;
    const paths = document.lattice.segmentationForest.paths.filter(path => path.posterior > 0).map(path => ({
      posterior: path.posterior, arcs: path.unitIds.map(id => { const index = indices.get(id); if (index === undefined) throw Error("global JOIN path refers to an unknown arc"); return index; })
    }));
    const base = new Map<number, number>();
    for (const index of paths[0]?.arcs ?? []) { const start = factors.arcs[index]![0]; if (degree[start]! > 1) base.set(start, index); }
    return { ...(document.constructionId !== undefined ? { constructionId: document.constructionId } : {}),
      ...(document.discourseStateId !== undefined ? { discourseStateId: document.discourseStateId } : {}),
      ...(normalizedOverrides.length ? { normalizedOverrides } : {}), baseChoices: [...base.values()],
      paths: paths.map(path => [path.posterior, path.arcs.filter(index => {
        const start = factors.arcs[index]![0]; return degree[start]! > 1 && base.get(start) !== index;
      })] as [number, number[]]) };
  }) };
}

function* globalFactorPaths(document: JoinGlobalFactorDocument, source: JoinLocalFactorDocument): Generator<{ weight: number; arcs: number[] }> {
  const graph = source.graph;
  const fail = (): never => { throw Error("invalid global JOIN path factors"); };
  if (!document || typeof document !== "object" || Array.isArray(document)
    || Object.keys(document).some(key => !["constructionId", "discourseStateId", "normalizedOverrides", "baseChoices", "paths"].includes(key))
    || (Object.hasOwn(document, "constructionId") && typeof document.constructionId !== "string")
    || (Object.hasOwn(document, "discourseStateId") && typeof document.discourseStateId !== "string")
    || !Array.isArray(document.baseChoices) || !Array.isArray(document.paths) || (!document.paths.length && document.baseChoices.length)) return fail();
  if (Object.hasOwn(document, "normalizedOverrides")) {
    if (!Array.isArray(document.normalizedOverrides) || !document.normalizedOverrides.length) return fail();
    let previous = -1;
    for (const entry of document.normalizedOverrides) {
      if (!Array.isArray(entry) || entry.length !== 2 || !Number.isSafeInteger(entry[0]) || entry[0] <= previous
        || !source.units[entry[0]] || typeof entry[1] !== "string") return fail();
      previous = entry[0];
    }
  }
  const outgoing = new Map<number, number[]>();
  graph.arcs.forEach(([start], index) => { const bucket = outgoing.get(start) ?? []; bucket.push(index); outgoing.set(start, bucket); });
  const decisions = (values: number[]): Map<number, number> => {
    if (!Array.isArray(values)) return fail();
    const result = new Map<number, number>(); let previous = -1;
    for (const index of values) {
      if (!Number.isSafeInteger(index) || index < 0 || !graph.arcs[index]) return fail();
      const start = graph.arcs[index]![0];
      if (start <= previous || outgoing.get(start)!.length < 2) return fail();
      previous = start; result.set(start, index);
    }
    return result;
  };
  const base = decisions(document.baseChoices), paths = new Set<string>();
  for (let ordinal = 0; ordinal < document.paths.length; ordinal++) {
    const path = document.paths[ordinal];
    if (!Array.isArray(path) || path.length !== 2 || !Number.isFinite(path[0]) || path[0] <= 0
      || !Array.isArray(path[1]) || (ordinal === 0 && path[1].length)) return fail();
    const overrides = decisions(path[1]), pathKey = JSON.stringify(path[1]);
    if (paths.has(pathKey)) return fail(); paths.add(pathKey);
    for (const [start, index] of overrides) if (base.get(start) === index) return fail();
    const arcs: number[] = [], usedBase = new Set<number>(); let position = 0;
    while (position < graph.nodeCount - 1) {
      const options = outgoing.get(position); if (!options?.length) return fail();
      let index: number | undefined;
      if (options.length === 1) index = options[0]!;
      else if (overrides.has(position)) { index = overrides.get(position)!; overrides.delete(position); }
      else { index = base.get(position); usedBase.add(position); }
      if (index === undefined) return fail();
      arcs.push(index); position = graph.arcs[index]![1];
    }
    if (overrides.size || (ordinal === 0 && usedBase.size !== base.size)) return fail();
    yield { weight: path[0], arcs };
  }
}

export function isJoinProgramGlobalFactors(value: unknown, localFactors: JoinProgramLocalFactors): value is JoinProgramGlobalFactors {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const factors = value as JoinProgramGlobalFactors;
    if (factors.schema !== JOIN_PROGRAM_GLOBAL_FACTORS_SCHEMA || Object.keys(factors).some(key => !["schema", "documents"].includes(key))
      || !Array.isArray(factors.documents) || factors.documents.length !== localFactors.documents.length) return false;
    for (let index = 0; index < factors.documents.length; index++) for (const _path of globalFactorPaths(factors.documents[index]!, localFactors.documents[index]!)) { /* Validate each original DAG walk. */ }
    return true;
  } catch { return false; }
}

interface LocalFactorIndex {
  documentId: string;
  constructionId?: string;
  sourceVersionId?: string;
  text: string;
  evidenceIds: readonly string[];
  evidenceRefs: ReadonlyArray<readonly number[] | null>;
  arcs: ReadonlyArray<readonly [number, number]>;
  geometry: ReturnType<typeof sourceGeometry>;
  sourceBounds: ReadonlyMap<number, readonly [number, number, number, number]>;
  normalized: ReadonlyMap<string, ReadonlySet<number>>;
  leftClasses: ReadonlyMap<string, ReadonlySet<number>>;
  rightClasses: ReadonlyMap<string, ReadonlySet<number>>;
  leftShapes: ReadonlyMap<string, ReadonlySet<number>>;
  rightShapes: ReadonlyMap<string, ReadonlySet<number>>;
  attributes: ReadonlyArray<null | { normalized: string; context: JoinUnitContext; bucket: number }>;
  query: ReturnType<typeof createSegmentationAdjacencyQuery>;
}
const localFactorIndexes = new WeakMap<JoinProgramLocalFactors, readonly LocalFactorIndex[]>();

/** Owned source/graph indexes contain no expanded pair or query-result tables. */
function indexLocalFactors(factors: JoinProgramLocalFactors): readonly LocalFactorIndex[] {
  const cached = localFactorIndexes.get(factors);
  if (cached) return cached;
  if (!isJoinProgramLocalFactors(factors)) throw new Error("invalid join-program local factors");
  const canonicalSurface = canonicalSurfaceResolver(factors.normalizationContract);
  const indexes = factors.documents.map(document => {
    const geometry = sourceGeometry(document.text), bearing = new Set<number>(), sourceBounds = new Map<number, readonly [number, number, number, number]>();
    const normalized = new Map<string, Set<number>>(), leftClasses = new Map<string, Set<number>>(), rightClasses = new Map<string, Set<number>>();
    const leftShapes = new Map<string, Set<number>>(), rightShapes = new Map<string, Set<number>>();
    const attributes: LocalFactorIndex["attributes"][number][] = document.units.map(() => null);
    const add = (index: Map<string, Set<number>>, key: string, value: number) => {
      const bucket = index.get(key) ?? new Set<number>(); bucket.add(value); index.set(key, bucket);
    };
    document.units.forEach((unit, index) => {
      if (!unit) return;
      bearing.add(index);
      const arc = document.graph.arcs[index]!, context = document.contexts[unit[0]]!;
      const start = unit.length === 5 ? unit[3] : geometry.utf16[arc[0]]!, end = unit.length === 5 ? unit[4] : geometry.utf16[arc[1]]!;
      if (unit.length === 5) sourceBounds.set(index, [start, end, geometry.utf16Bytes[start]!, geometry.utf16Bytes[end]!]);
      const surface = document.text.slice(start, end), source = canonicalSurface(surface), classId = context.length === 2 ? context[1] : source.classId;
      attributes[index] = { normalized: source.normalized, context: { surfaceFormClassId: classId, scaleId: context[0], graphemeWidth: Math.max(1, arc[1] - arc[0]) }, bucket: unit[1] };
      add(normalized, source.normalized, index);
      add(leftClasses, JSON.stringify([classId, context[0], unit[1]]), index);
      add(rightClasses, JSON.stringify([classId, context[0]]), index);
      add(leftShapes, boundaryShape([...surface].at(-1) ?? ""), index);
      add(rightShapes, boundaryShape([...surface][0] ?? ""), index);
    });
    return { documentId: document.documentId, ...(document.constructionId ? { constructionId: document.constructionId } : {}), ...(document.sourceVersionId ? { sourceVersionId: document.sourceVersionId } : {}), text: document.text,
      evidenceIds: [...document.evidenceIds], evidenceRefs: document.units.map(unit => unit ? [...unit[2]] : null),
      arcs: document.graph.arcs.map(arc => [arc[0], arc[1]] as const), geometry, sourceBounds, normalized, leftClasses, rightClasses, leftShapes, rightShapes, attributes,
      query: createSegmentationAdjacencyQuery(document.graph, bearing) };
  });
  localFactorIndexes.set(factors, indexes);
  return indexes;
}

function queryLocalFactorChoices(factors: JoinProgramLocalFactors, source: "exact" | "class" | "local_shape" | "construction", key: string, proofs: boolean): JoinProgramChoice[] {
  let context: unknown;
  try { context = JSON.parse(key); } catch { return []; }
  if (!Array.isArray(context) || context.length !== (source === "class" ? 5 : source === "construction" ? 3 : 2)
    || !context.slice(0, source === "class" ? 4 : source === "construction" ? 3 : 2).every(item => typeof item === "string")
    || (source === "class" && !Number.isSafeInteger(context[4]))) return [];
  const target = source === "construction" ? context.slice(1) : context, counts = new Map<string, Map<string, JoinCount>>(), hashes = new Map<string, string>();
  for (const document of indexLocalFactors(factors)) {
    if (source === "construction" && document.constructionId !== context[0]) continue;
    const left = source === "exact" ? document.normalized.get(target[0]) : (source === "local_shape" || source === "construction") ? document.leftShapes.get(target[0]) : document.leftClasses.get(JSON.stringify([target[0], target[2], target[4]]));
    const right = source === "exact" ? document.normalized.get(target[1]) : (source === "local_shape" || source === "construction") ? document.rightShapes.get(target[1]) : document.rightClasses.get(JSON.stringify([target[1], target[3]]));
    if (!left?.size || !right?.size) continue;
    for (const pair of document.query.pairs({ leftArcIndices: left, rightArcIndices: right })) {
      const boundary = factorBoundary(document, pair.leftArcIndex, pair.rightArcIndex, proofs, hashes);
      addCount(counts, key, boundary.surface, boundary.ids, boundary.coordinates, pair.posterior, evidenceCoordinateKey);
    }
  }
  return choices(counts.get(key) ?? new Map());
}

function factorBoundary(document: LocalFactorIndex, left: number, right: number, proofs: boolean, hashes: Map<string, string>) {
  const leftArc = document.arcs[left]!, rightArc = document.arcs[right]!, geometry = document.geometry;
  const leftBounds = document.sourceBounds.get(left), rightBounds = document.sourceBounds.get(right);
  const utf16Start = leftBounds?.[1] ?? geometry.utf16[leftArc[1]]!, utf16End = rightBounds?.[0] ?? geometry.utf16[rightArc[0]]!, surface = document.text.slice(utf16Start, utf16End);
  const ids = [...new Set([...document.evidenceRefs[left]!, ...document.evidenceRefs[right]!])].map(index => document.evidenceIds[index]!).sort();
  let exactSurfaceHash: string | undefined;
  if (proofs) { exactSurfaceHash = hashes.get(surface); if (exactSurfaceHash === undefined) { exactSurfaceHash = createHasher().digestHex(surface); hashes.set(surface, exactSurfaceHash); } }
  const coordinates = proofs ? ids.map(evidenceId => ({ evidenceId, ...(document.sourceVersionId ? { sourceVersionId: document.sourceVersionId } : {}),
    documentId: document.documentId, byteStart: leftBounds?.[3] ?? geometry.bytes[leftArc[1]]!, byteEnd: rightBounds?.[2] ?? geometry.bytes[rightArc[0]]!, utf16Start, utf16End, exactSurfaceHash: exactSurfaceHash! })) : [];
  return { surface, ids, coordinates };
}

interface GlobalFactorIndex {
  constructionId: string;
  discourseStateId: string;
  normalized: ReadonlyMap<string, ReadonlySet<number>>;
  paths: Array<{ weight: number; shape: string; bearing: number[] }>;
  positions: ReadonlyMap<number, ReadonlyArray<readonly [path: number, position: number]>>;
}
const globalFactorIndexes = new WeakMap<JoinProgramGlobalFactors, WeakMap<JoinProgramLocalFactors, readonly GlobalFactorIndex[]>>();

/** Numeric path positions reference source arcs; no boundary contexts, counts or proofs are expanded here. */
function indexGlobalFactors(global: JoinProgramGlobalFactors, local: JoinProgramLocalFactors): readonly GlobalFactorIndex[] {
  const owners = globalFactorIndexes.get(global) ?? new WeakMap<JoinProgramLocalFactors, readonly GlobalFactorIndex[]>();
  globalFactorIndexes.set(global, owners);
  const cached = owners.get(local); if (cached) return cached;
  const documents = indexLocalFactors(local);
  if (global.schema !== JOIN_PROGRAM_GLOBAL_FACTORS_SCHEMA || !Array.isArray(global.documents) || global.documents.length !== documents.length) throw Error("invalid global JOIN path factors");
  const indexes = global.documents.map((document, ordinal) => {
    const source = documents[ordinal]!, positions = new Map<number, Array<readonly [number, number]>>();
    const paths: GlobalFactorIndex["paths"] = [];
    for (const path of globalFactorPaths(document, local.documents[ordinal]!)) {
      const pathIndex = paths.length;
      const bearing = path.arcs.filter(index => source.attributes[index] !== null);
      const shape = derivationShapeParts(bearing.map(index => {
        const context = source.attributes[index]!.context; return [context.scaleId, context.graphemeWidth] as const;
      }));
      bearing.forEach((index, position) => { const bucket = positions.get(index) ?? []; bucket.push([pathIndex, position]); positions.set(index, bucket); });
      paths.push({ weight: path.weight, shape, bearing });
    }
    let normalized = source.normalized;
    if (document.normalizedOverrides) {
      const overrides = new Map(document.normalizedOverrides), labels = new Map<string, Set<number>>();
      source.attributes.forEach((attribute, index) => {
        if (!attribute) return;
        const label = overrides.get(index) ?? attribute.normalized, bucket = labels.get(label) ?? new Set<number>();
        bucket.add(index); labels.set(label, bucket);
      });
      normalized = labels;
    }
    return { constructionId: document.constructionId ?? "construction.unresolved", discourseStateId: document.discourseStateId ?? "discourse.unresolved", normalized, paths, positions };
  });
  owners.set(local, indexes); return indexes;
}

function queryGlobalFactorChoices(global: JoinProgramGlobalFactors, local: JoinProgramLocalFactors, source: "conditioned" | "structural", key: string, proofs: boolean): JoinProgramChoice[] {
  let context: unknown;
  try { context = JSON.parse(key); } catch { return []; }
  const conditioned = source === "conditioned", width = conditioned ? 12 : 10, numeric = conditioned ? [6, 7, 8] : [4, 5, 6];
  if (!Array.isArray(context) || context.length !== width || context.some((value, index) => numeric.includes(index)
    ? !Number.isSafeInteger(value) || value < (index === numeric[2] ? 0 : 1) || index === numeric[2] && value > boundaryBucket(1) : typeof value !== "string")) return [];
  const target = context as Array<string | number>, localIndexes = indexLocalFactors(local), globalIndexes = indexGlobalFactors(global, local);
  if (!globalIndexes.some(document => document.constructionId === target[width - 3] && document.discourseStateId === target[width - 2]
    && document.paths.some(path => path.shape === target[width - 1]))) return [];
  const counts = new Map<string, Map<string, JoinCount>>(), hashes = new Map<string, string>(); let denominator = 0;
  const selectedDocuments: Array<{ document: LocalFactorIndex; left: Set<number>; right: Set<number> }> = [];
  for (let ordinal = 0; ordinal < localIndexes.length; ordinal++) {
    const document = localIndexes[ordinal]!, retained = globalIndexes[ordinal]!;
    if (retained.constructionId !== target[width - 3] || retained.discourseStateId !== target[width - 2]) continue;
    const leftCandidates = conditioned ? retained.normalized.get(target[0] as string) : document.leftShapes.get(target[0] as string);
    const rightCandidates = conditioned ? retained.normalized.get(target[1] as string) : document.rightShapes.get(target[1] as string);
    const left = new Set<number>(), right = new Set<number>();
    const matches = (index: number, side: number): boolean => {
      const value = document.attributes[index]!;
      return value.context.scaleId === target[(conditioned ? 4 : 2) + side]
        && value.context.graphemeWidth === target[(conditioned ? 6 : 4) + side]
        && (!conditioned || value.context.surfaceFormClassId === target[2 + side])
        && (side !== 0 || value.bucket === target[conditioned ? 8 : 6]);
    };
    for (const index of leftCandidates ?? []) if (matches(index, 0)) left.add(index);
    for (const index of rightCandidates ?? []) if (matches(index, 1)) right.add(index);
    if (!left.size || !right.size) continue;
    selectedDocuments.push({ document, left, right });
    const positions: Array<readonly [number, number]> = [];
    for (const index of left) for (const [pathIndex, position] of retained.positions.get(index) ?? []) {
      const path = retained.paths[pathIndex]!;
      if (path.shape === target[width - 1] && right.has(path.bearing[position + 1]!)) positions.push([pathIndex, position]);
    }
    positions.sort(([leftPath, leftPosition], [rightPath, rightPosition]) => leftPath - rightPath || leftPosition - rightPosition);
    for (const [pathIndex, position] of positions) {
      const path = retained.paths[pathIndex]!, boundary = factorBoundary(document, path.bearing[position]!, path.bearing[position + 1]!, proofs, hashes);
      addCount(counts, key, boundary.surface, boundary.ids, boundary.coordinates, path.weight, evidenceCoordinateKey);
    }
  }
  if (!counts.has(key)) return [];
  for (const { document, left, right } of selectedDocuments) for (const pair of document.query.pairs({ leftArcIndices: left, rightArcIndices: right })) denominator += pair.posterior;
  return choices(counts.get(key) ?? new Map(), denominator);
}

function joinBoundaryContext(document: JoinDocument, left: SurfaceLatticeUnit, derivationShapeId?: string): JoinBoundaryContext {
  return { boundaryProbability: left.boundaryAfter.boundaryProbability, constructionId: document.constructionId,
    discourseStateId: document.discourseStateId, derivationShapeId };
}

function joinEvent(document: JoinDocument, left: SurfaceLatticeUnit, right: SurfaceLatticeUnit, weight: number,
  hashes: Map<string, string>, derivationShapeId?: string, proofs = true): JoinEvent {
  const join = document.text.slice(left.utf16End, right.utf16Start);
  let exactSurfaceHash: string | undefined;
  if (proofs) { exactSurfaceHash = hashes.get(join); if (exactSurfaceHash === undefined) { exactSurfaceHash = createHasher().digestHex(join); hashes.set(join, exactSurfaceHash); } }
  const evidenceIds = [...new Set([...left.evidenceIds, ...right.evidenceIds])].sort();
  const evidenceCoordinates = proofs ? evidenceIds.map(evidenceId => ({ evidenceId,
    ...(document.lattice.sourceVersionId ? { sourceVersionId: document.lattice.sourceVersionId } : {}),
    documentId: document.documentId, byteStart: left.byteEnd, byteEnd: right.byteStart,
    utf16Start: left.utf16End, utf16End: right.utf16Start, exactSurfaceHash: exactSurfaceHash! })) : [];
  const leftContext = unitContext(left), rightContext = unitContext(right), boundaryContext = joinBoundaryContext(document, left, derivationShapeId);
  return { left, right, join, weight, evidenceIds, evidenceCoordinates,
    ...(derivationShapeId === undefined ? {} : {
      conditionedKey: conditionedJoinKey({ left: left.normalized, right: right.normalized, leftContext, rightContext, boundaryContext }),
      structuralKey: structuralJoinKey(left.surface, right.surface, leftContext, rightContext, boundaryContext)
    }),
    exactKey: exactJoinKey(left.normalized, right.normalized), classKey: classJoinKey(leftContext, rightContext, boundaryContext),
    localShapeKey: localShapeJoinKey(left.surface, right.surface),
    ...(document.constructionId ? { constructionKey: constructionJoinKey(left.surface, right.surface, document.constructionId) } : {}),
    crossScript: left.scriptId !== right.scriptId };
}

function* joinEvents(document: JoinDocument, proofs = true): Generator<JoinEvent> {
  const hashes = new Map<string, string>(), unitsById = new Map(document.lattice.units.map(unit => [unit.id, unit]));
  for (const path of document.lattice.segmentationForest.paths) {
    const pathWeight = Math.max(0, path.posterior);
    if (pathWeight === 0) continue;
    const units = path.unitIds.map(unitId => requiredUnit(unitsById, unitId)).filter(isSurfaceBearingUnit);
    const derivationShapeId = derivationShape(units);
    for (let index = 1; index < units.length; index++) yield joinEvent(document, units[index - 1]!, units[index]!, pathWeight, hashes, derivationShapeId, proofs);
  }
}

function* localJoinEvents(document: JoinDocument): Generator<JoinEvent> {
  const hashes = new Map<string, string>(), unitsById = new Map(document.lattice.units.map(unit => [unit.id, unit]));
  const bearing = new Set(document.lattice.units.filter(isSurfaceBearingUnit).map(unit => unit.id));
  for (const pair of segmentationSurfaceAdjacencies(document.lattice.segmentationForest, bearing)) {
    if (pair.posterior > 0) yield joinEvent(document, requiredUnit(unitsById, pair.leftUnitId), requiredUnit(unitsById, pair.rightUnitId), pair.posterior, hashes, undefined, false);
  }
}

/** Retained global contexts and the remaining local mass partition the same adjacency law. */
function* evaluationJoinEvents(document: JoinDocument): Generator<JoinEvent> {
  const retained = new Map<string, { mass: number; scale: number }>();
  const key = (left: string, right: string) => JSON.stringify([left, right]);
  const unitsById = new Map(document.lattice.units.map(unit => [unit.id, unit]));
  for (const path of document.lattice.segmentationForest.paths) {
    if (path.posterior <= 0) continue;
    const units = path.unitIds.map(id => requiredUnit(unitsById, id)).filter(isSurfaceBearingUnit);
    for (let index = 1; index < units.length; index++) {
      const pair = key(units[index - 1]!.id, units[index]!.id), row = retained.get(pair) ?? { mass: 0, scale: 0 };
      row.mass += path.posterior; retained.set(pair, row);
    }
  }
  for (const event of localJoinEvents(document)) {
    const row = retained.get(key(event.left.id, event.right.id));
    if (row) row.scale = Math.min(1, event.weight / row.mass);
    const weight = Math.max(0, event.weight - (row ? row.mass * row.scale : 0));
    if (weight > 0) yield { ...event, weight };
  }
  for (const event of joinEvents(document, false)) {
    const scale = retained.get(key(event.left.id, event.right.id))!.scale;
    if (scale > 0) yield { ...event, weight: event.weight * scale };
  }
}

function evaluateHeldoutJoins(input: {
  documents: readonly {
    documentId: string;
    sourceFamilyId?: string;
    text: string;
    lattice: SurfaceLattice;
    constructionId?: string;
    discourseStateId?: string;
  }[];
  conditionedIndex: Record<string, JoinProgramChoice[]>;
  exactIndex: Record<string, JoinProgramChoice[]>;
  structuralIndex: Record<string, JoinProgramChoice[]>;
  classIndex: Record<string, JoinProgramChoice[]>;
  localShapeIndex: Record<string, JoinProgramChoice[]>;
  constructionIndex: Record<string, JoinProgramChoice[]>;
  backoffReliability: JoinReliability;
  localFactors?: JoinProgramLocalFactors;
  globalFactors?: JoinProgramGlobalFactors;
  minimumConfidence: number;
  selectionDocumentIds?: readonly string[];
}): JoinProgramEvaluation {
  let mass = 0;
  let correctMass = 0;
  let negativeLogLikelihood = 0;
  let whitespaceInsertionErrors = 0;
  let whitespaceDeletionErrors = 0;
  let punctuationErrors = 0;
  let crossScriptMass = 0;
  let crossScriptCorrect = 0;
  let reconstructedDocuments = 0;
  const calibrationBins = Array.from({ length: 10 }, () => ({ confidence: 0, correct: 0, mass: 0 }));
  for (const document of input.documents) {
    for (const event of evaluationJoinEvents(document)) {
      const prediction = predictionForEvent(event, input, input.backoffReliability);
      const alternatives = prediction.alternatives;
      const selected = alternatives[0];
      const reliability = input.backoffReliability[prediction.source];
      const assigned = (alternatives.find(choice =>
        choice.surface === event.join)?.probability ?? 0) * reliability;
      const confidence = (selected?.probability ?? 0) * reliability;
      const correct = Boolean(selected
        && confidence >= input.minimumConfidence
        && selected.surface === event.join);
      negativeLogLikelihood += -event.weight * Math.log(Math.max(1e-12, assigned));
      mass += event.weight;
      if (correct) correctMass += event.weight;
      if (event.crossScript) {
        crossScriptMass += event.weight;
        if (correct) crossScriptCorrect += event.weight;
      }
      if (!correct) {
        const predicted = selected?.surface ?? "";
        if (/\s/u.test(predicted) && !/\s/u.test(event.join)) whitespaceInsertionErrors += event.weight;
        if (!/\s/u.test(predicted) && /\s/u.test(event.join)) whitespaceDeletionErrors += event.weight;
        if (punctuationSignature(predicted) !== punctuationSignature(event.join)) punctuationErrors += event.weight;
      }
      const bin = calibrationBins[Math.min(9, Math.floor(confidence * 10))]!;
      bin.confidence += confidence * event.weight;
      bin.correct += Number(correct) * event.weight;
      bin.mass += event.weight;
    }
  }
  for (const document of input.documents) {
    if (reconstructDocument(document, input) === document.text) {
      reconstructedDocuments += 1;
    }
  }
  if (mass <= 0) {
    return {
      heldoutDocumentIds: input.documents.map(document => document.documentId),
      selectionDocumentIds: [...(input.selectionDocumentIds ?? [])],
      observations: 0,
      exactAccuracy: null,
      negativeLogLikelihood: null,
      expectedCalibrationError: null,
      reconstructionAccuracy: null,
      whitespaceInsertionErrors,
      whitespaceDeletionErrors,
      punctuationErrors,
      crossScriptAccuracy: null
    };
  }
  const ece = calibrationBins.reduce((sum, bin) => bin.mass <= 0
    ? sum
    : sum + bin.mass / mass * Math.abs(
      bin.confidence / bin.mass - bin.correct / bin.mass
    ), 0);
  const accuracy = correctMass / mass;
  return {
    heldoutDocumentIds: input.documents.map(document => document.documentId),
    selectionDocumentIds: [...(input.selectionDocumentIds ?? [])],
    observations: positivePrecision(mass),
    exactAccuracy: quantize(accuracy),
    negativeLogLikelihood: quantize(negativeLogLikelihood / mass),
    expectedCalibrationError: quantize(ece),
    reconstructionAccuracy: quantize(
      reconstructedDocuments / Math.max(1, input.documents.length)
    ),
    whitespaceInsertionErrors,
    whitespaceDeletionErrors,
    punctuationErrors,
    crossScriptAccuracy: crossScriptMass > 0
      ? quantize(crossScriptCorrect / crossScriptMass)
      : null
  };
}

type JoinIndexes = Pick<
  JoinProgramModel,
  | "conditionedIndex"
  | "exactIndex"
  | "structuralIndex"
  | "classIndex"
  | "localShapeIndex"
  | "constructionIndex"
  | "localFactors"
  | "globalFactors"
>;

type JoinReliability = Record<JoinBackoffSource, number>;

function alternativesForEvent(
  event: JoinEvent,
  indexes: JoinIndexes
): JoinProgramChoice[] {
  return predictionForEvent(event, indexes).alternatives;
}

function predictionForEvent(
  event: JoinEvent,
  indexes: JoinIndexes,
  reliability?: JoinReliability
): { source: JoinBackoffSource; alternatives: JoinProgramChoice[] } {
  const levels: Array<{ source: JoinBackoffSource; alternatives: JoinProgramChoice[] }> = [
    { source: "conditioned", alternatives: choicesForIndexes(indexes, "conditioned", event) },
    { source: "exact", alternatives: choicesForIndexes(indexes, "exact", event) },
    { source: "structural", alternatives: choicesForIndexes(indexes, "structural", event) },
    { source: "class", alternatives: choicesForIndexes(indexes, "class", event) },
    { source: "local_shape", alternatives: choicesForIndexes(indexes, "local_shape", event) },
    {
      source: "construction",
      alternatives: choicesForIndexes(indexes, "construction", event)
    }
  ];
  const ranked = levels.map(level => ({ ...level, alternatives: [...level.alternatives]
    .sort((left, right) => compareJoinChoices(left, right, reliability?.[level.source] ?? 1)) }));
  return strongestJoinFactor(ranked, level => level.alternatives[0]!.probability * (reliability?.[level.source] ?? 1))
    ?? { source: "local_shape", alternatives: [] };
}

function selectConfidenceThreshold(
  documents: readonly {
    documentId: string;
    sourceFamilyId?: string;
    text: string;
    lattice: SurfaceLattice;
    constructionId?: string;
    discourseStateId?: string;
  }[],
  indexes: JoinIndexes,
  reliability: JoinReliability
): number {
  if (!documents.length) return 1;
  const observations = documents.flatMap(document =>
    Array.from(evaluationJoinEvents(document), event => {
      const prediction = predictionForEvent(event, indexes, reliability);
      return {
      event,
        selected: prediction.alternatives[0],
        source: prediction.source
      };
    }));
  if (!observations.length) return 1;
  const thresholds = [...new Set([
    0,
    1,
    ...observations.map(row => (
      (row.selected?.probability ?? 0) * reliability[row.source]
    ))
  ])].sort((left, right) => left - right);
  let best = { threshold: 1, risk: Number.POSITIVE_INFINITY };
  for (const threshold of thresholds) {
    let risk = 0;
    for (const { event, selected, source } of observations) {
      const confidence = (selected?.probability ?? 0) * reliability[source];
      if (!selected || confidence < threshold) {
        risk += 0.2 * event.weight;
      } else if (selected.surface !== event.join) {
        risk += event.weight;
      }
    }
    if (risk < best.risk || (risk === best.risk && threshold > best.threshold)) {
      best = { threshold, risk };
    }
  }
  return clamp01(best.threshold);
}

function learnBackoffReliability(
  documents: readonly {
    documentId: string;
    sourceFamilyId?: string;
    text: string;
    lattice: SurfaceLattice;
    constructionId?: string;
    discourseStateId?: string;
  }[],
  indexes: JoinIndexes
): JoinReliability {
  const sources: JoinBackoffSource[] = [
    "conditioned",
    "exact",
    "structural",
    "class",
    "local_shape",
    "construction"
  ];
  if (!documents.length) {
    return Object.fromEntries(sources.map(source => [source, 1])) as JoinReliability;
  }
  const rows = new Map<JoinBackoffSource, { correct: number; mass: number }>(
    sources.map(source => [source, { correct: 0, mass: 0 }])
  );
  for (const document of documents) {
    for (const [events, measuredSources] of [[joinEvents(document, false), ["conditioned", "structural"]],
      [localJoinEvents(document), ["exact", "class", "local_shape", "construction"]]] as const) for (const event of events) {
      for (const source of measuredSources) {
        const alternatives = [...choicesForIndexes(indexes, source, event)].sort((left, right) => compareJoinChoices(left, right));
        const selected = alternatives[0];
        if (!selected) continue;
        const row = rows.get(source)!;
        row.mass += event.weight;
        if (selected.surface === event.join) row.correct += event.weight;
      }
    }
  }
  return Object.fromEntries(sources.map(source => {
    const row = rows.get(source)!;
    return [source, quantize(row.mass > 0
      ? (row.correct + 0.5) / (row.mass + 1)
      : 0)];
  })) as JoinReliability;
}

function choicesForIndexes(
  indexes: JoinIndexes,
  source: JoinBackoffSource,
  event: JoinEvent
): JoinProgramChoice[] {
  const key = source === "conditioned" ? event.conditionedKey : source === "exact" ? event.exactKey
    : source === "structural" ? event.structuralKey : source === "class" ? event.classKey : source === "local_shape" ? event.localShapeKey : event.constructionKey;
  return key === undefined ? [] : joinProgramChoices(indexes, source, key, { proofs: false });
}

function reconstructDocument(
  document: {
    documentId: string;
    sourceFamilyId?: string;
    text: string;
    lattice: SurfaceLattice;
    constructionId?: string;
    discourseStateId?: string;
  },
  indexes: JoinIndexes & {
    minimumConfidence: number;
    backoffReliability: JoinReliability;
  }
): string | undefined {
  const unitsById = new Map(document.lattice.units.map(unit => [unit.id, unit]));
  const path = document.lattice.segmentationForest.paths[0];
  if (!path) return document.text.length === 0 ? "" : undefined;
  const units = path.unitIds
    .map(unitId => requiredUnit(unitsById, unitId))
    .filter(isSurfaceBearingUnit);
  if (!units.length) return document.text.length === 0 ? "" : undefined;
  const derivationShapeId = derivationShape(units);
  let surface = units[0]!.surface;
  for (let index = 1; index < units.length; index += 1) {
    const left = units[index - 1]!;
    const right = units[index]!;
    const boundaryContext: JoinBoundaryContext = {
      boundaryProbability: left.boundaryAfter.boundaryProbability,
      constructionId: document.constructionId,
      discourseStateId: document.discourseStateId,
      derivationShapeId
    };
    const event: JoinEvent = {
      left,
      right,
      join: document.text.slice(left.utf16End, right.utf16Start),
      weight: path.posterior,
      evidenceIds: [],
      evidenceCoordinates: [],
      conditionedKey: conditionedJoinKey({
        left: left.normalized,
        right: right.normalized,
        leftContext: unitContext(left),
        rightContext: unitContext(right),
        boundaryContext
      }),
      exactKey: exactJoinKey(left.normalized, right.normalized),
      structuralKey: structuralJoinKey(
        left.surface,
        right.surface,
        unitContext(left),
        unitContext(right),
        boundaryContext
      ),
      classKey: classJoinKey(unitContext(left), unitContext(right), boundaryContext),
      localShapeKey: localShapeJoinKey(left.surface, right.surface),
      ...(document.constructionId
        ? { constructionKey: constructionJoinKey(
          left.surface,
          right.surface,
          document.constructionId
        ) }
        : {}),
      crossScript: left.scriptId !== right.scriptId
    };
    const prediction = predictionForEvent(event, indexes, indexes.backoffReliability);
    const selected = prediction.alternatives[0];
    const confidence = (selected?.probability ?? 0)
      * indexes.backoffReliability[prediction.source];
    if (!selected || confidence < indexes.minimumConfidence) return undefined;
    surface += selected.surface + right.surface;
  }
  return surface;
}

function sourceFamilyDisjointSplit<T extends { documentId: string; sourceFamilyId?: string }>(
  documents: readonly T[],
  hasher: Hasher
): { training: T[]; selection: T[]; evaluation: T[] } {
  const familyRows = [...new Set(documents.map(document =>
    document.sourceFamilyId?.trim() || document.documentId))]
    .map(familyId => ({
      familyId,
      rank: hasher.digestHex(`join-program-family-split\u001f${familyId}`)
    }))
    .sort((left, right) =>
      left.rank.localeCompare(right.rank)
      || left.familyId.localeCompare(right.familyId));
  if (familyRows.length < 5) {
    return { training: [...documents], selection: [], evaluation: [] };
  }
  const reserveCount = Math.max(1, Math.floor(familyRows.length / 5));
  const selectionFamilies = new Set(familyRows.slice(0, reserveCount)
    .map(row => row.familyId));
  const evaluationFamilies = new Set(familyRows.slice(reserveCount, reserveCount * 2)
    .map(row => row.familyId));
  return {
    training: documents.filter(document => {
      const family = document.sourceFamilyId?.trim() || document.documentId;
      return !selectionFamilies.has(family) && !evaluationFamilies.has(family);
    }),
    selection: documents.filter(document =>
      selectionFamilies.has(document.sourceFamilyId?.trim() || document.documentId)),
    evaluation: documents.filter(document =>
      evaluationFamilies.has(document.sourceFamilyId?.trim() || document.documentId))
  };
}

function addCount(
  index: Map<string, Map<string, JoinCount>>,
  key: string,
  surface: string,
  evidenceIds: readonly string[],
  evidenceCoordinates: readonly JoinEvidenceCoordinate[],
  weight: number,
  coordinateKey: typeof evidenceCoordinateKey
): void {
  const bucket = index.get(key) ?? new Map<string, JoinCount>();
  const row = bucket.get(surface) ?? {
    surface,
    count: 0,
    evidenceIds: new Set<string>(),
    evidenceCoordinates: new Map<string, JoinEvidenceCoordinate>()
  };
  row.count += weight;
  for (const id of evidenceIds) row.evidenceIds.add(id);
  for (const coordinate of evidenceCoordinates) {
    row.evidenceCoordinates.set(coordinateKey(coordinate), coordinate);
  }
  bucket.set(surface, row);
  index.set(key, bucket);
}

function requiredUnit(
  unitsById: ReadonlyMap<string, SurfaceLatticeUnit>,
  unitId: string
): SurfaceLatticeUnit {
  const unit = unitsById.get(unitId);
  if (!unit) throw new Error(`segmentation forest references missing unit ${unitId}`);
  return unit;
}

function isSurfaceBearingUnit(unit: SurfaceLatticeUnit): boolean {
  return isSurfaceBearingText(unit.surface);
}

function isSurfaceBearingText(surface: string): boolean {
  return surface.length > 0 && !/^\s+$/u.test(surface) && !/^\p{Control}+$/u.test(surface);
}

function compileIndex(
  index: ReadonlyMap<string, ReadonlyMap<string, JoinCount>>,
  denominator?: (key: string) => number
): Record<string, JoinProgramChoice[]> {
  return Object.fromEntries([...index.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, rows]) => [key, choices(rows, denominator?.(key))]));
}

function choices(rows: ReadonlyMap<string, JoinCount>, denominator?: number): JoinProgramChoice[] {
  const values = [...rows.values()], observed = values.reduce((sum, row) => sum + row.count, 0);
  const total = Math.max(observed, denominator ?? observed);
  const probabilities = values.map(row => total > 0 ? row.count / total : 0);
  let mass = probabilities.reduce((sum, probability) => sum + probability, 0);
  while (mass > 1) {
    for (let index = 0; index < probabilities.length; index++) probabilities[index] = probabilities[index]! / mass;
    mass = probabilities.reduce((sum, probability) => sum + probability, 0);
  }
  return values.map((row, index) => ({ surface: row.surface, count: positivePrecision(row.count), probability: probabilities[index]!,
    evidenceIds: [...row.evidenceIds].sort(), evidenceCoordinates: sortedEvidenceCoordinates(row.evidenceCoordinates) }))
    .sort((left, right) => right.count - left.count || left.surface.localeCompare(right.surface));
}

function sortedEvidenceCoordinates(coordinates: ReadonlyMap<string, JoinEvidenceCoordinate>): JoinEvidenceCoordinate[] {
  if (coordinates.size < 2) return [...coordinates.values()];
  return [...coordinates].sort(([left], [right]) => left.localeCompare(right)).map(([, coordinate]) => coordinate);
}

function evidenceCoordinateKey(value: JoinEvidenceCoordinate): string {
  return [
    value.evidenceId,
    value.sourceVersionId ?? "",
    value.documentId,
    value.byteStart,
    value.byteEnd,
    value.utf16Start,
    value.utf16End,
    value.exactSurfaceHash
  ].join("\u001f");
}

function compareEvidenceCoordinates(
  left: JoinEvidenceCoordinate,
  right: JoinEvidenceCoordinate
): number {
  return evidenceCoordinateKey(left).localeCompare(evidenceCoordinateKey(right));
}

function unitContext(unit: SurfaceLatticeUnit): JoinUnitContext {
  return {
    surfaceFormClassId: unit.surfaceFormClassId,
    scaleId: unit.kind,
    graphemeWidth: Math.max(1, unit.graphemeEnd - unit.graphemeStart)
  };
}

function inferredJoinUnitContext(surface: string): JoinUnitContext {
  const normalized = normalize(surface);
  return {
    surfaceFormClassId: `surface_form_class.runtime.${createHasher()
      .digestHex(normalized).slice(0, 32)}`,
    scaleId: "runtime.surface",
    graphemeWidth: Math.max(1, [...surface].length)
  };
}

// A stable, opaque grouping key for a derivation's unit-kind/width shape --
// used only as a JSON.stringify'd component of conditionedJoinKey and
// structuralJoinKey, never read for its literal content. It used to be the
// raw joined "kind:width" string, which is O(path length): for a single
// fragmented path of ~13.5K units that is a ~150KB string, and every one of
// the ~13.5K join events on that path re-serialized it whole into two
// separate keys -- ~400KB of new string allocation per event, which is what
// actually OOM'd a 4GB heap on 16KB of real corpus text (buildSurfaceLattice
// itself was already fixed and fast by that point). Hashing once here makes
// every event's key construction O(1) instead of O(path length) while
// keeping the same uniqueness/stability guarantee real callers depend on.
export function derivationShape(units: readonly SurfaceLatticeUnit[]): string {
  return derivationShapeParts(units.map(unit => [unit.kind, Math.max(1, unit.graphemeEnd - unit.graphemeStart)] as const));
}

function derivationShapeParts(parts: ReadonlyArray<readonly [string, number]>): string {
  const raw = parts.map(([kind, width]) => `${kind}:${width}`).join("\u001f");
  return `derivation_shape.${createHasher().digestHex(raw).slice(0, 32)}`;
}

function conditionedJoinKey(input: {
  left: string;
  right: string;
  leftContext: JoinUnitContext;
  rightContext: JoinUnitContext;
  boundaryContext: JoinBoundaryContext;
}): string {
  return JSON.stringify([
    input.left,
    input.right,
    input.leftContext.surfaceFormClassId,
    input.rightContext.surfaceFormClassId,
    input.leftContext.scaleId,
    input.rightContext.scaleId,
    input.leftContext.graphemeWidth,
    input.rightContext.graphemeWidth,
    boundaryBucket(input.boundaryContext.boundaryProbability),
    input.boundaryContext.constructionId ?? "construction.unresolved",
    input.boundaryContext.discourseStateId ?? "discourse.unresolved",
    input.boundaryContext.derivationShapeId ?? "derivation.unresolved"
  ]);
}

function structuralJoinKey(
  left: string,
  right: string,
  leftContext: JoinUnitContext,
  rightContext: JoinUnitContext,
  boundaryContext: JoinBoundaryContext
): string {
  return JSON.stringify([
    boundaryShape([...left].at(-1) ?? ""),
    boundaryShape([...right][0] ?? ""),
    leftContext.scaleId,
    rightContext.scaleId,
    leftContext.graphemeWidth,
    rightContext.graphemeWidth,
    boundaryBucket(boundaryContext.boundaryProbability),
    boundaryContext.constructionId ?? "construction.unresolved",
    boundaryContext.discourseStateId ?? "discourse.unresolved",
    boundaryContext.derivationShapeId ?? "derivation.unresolved"
  ]);
}

function classJoinKey(
  leftContext: JoinUnitContext,
  rightContext: JoinUnitContext,
  boundaryContext: JoinBoundaryContext
): string {
  return JSON.stringify([
    leftContext.surfaceFormClassId,
    rightContext.surfaceFormClassId,
    leftContext.scaleId,
    rightContext.scaleId,
    boundaryBucket(boundaryContext.boundaryProbability)
  ]);
}

function localShapeJoinKey(left: string, right: string): string {
  return JSON.stringify([
    boundaryShape([...left].at(-1) ?? ""),
    boundaryShape([...right][0] ?? "")
  ]);
}

function constructionJoinKey(
  left: string,
  right: string,
  constructionId: string
): string {
  return JSON.stringify([
    constructionId,
    boundaryShape([...left].at(-1) ?? ""),
    boundaryShape([...right][0] ?? "")
  ]);
}

export function joinProgramChoices(
  program: JoinIndexes,
  source: JoinBackoffSource,
  key: string,
  options: { proofs?: boolean } = {}
): JoinProgramChoice[] {
  const proofs = options.proofs !== false;
  if (program.globalFactors && (source === "conditioned" || source === "structural")) {
    if (!program.localFactors || Object.keys(program.conditionedIndex).length || Object.keys(program.structuralIndex).length) throw Error("mixed or incomplete global JOIN factors");
    return queryGlobalFactorChoices(program.globalFactors, program.localFactors, source, key, proofs);
  }
  if (program.localFactors && (source === "exact" || source === "class")) return queryLocalFactorChoices(program.localFactors, source, key, proofs);
  if (program.localFactors && proofs && (source === "local_shape" || source === "construction")) {
    const measured = (source === "local_shape" ? program.localShapeIndex : program.constructionIndex)[key] ?? [];
    if (!measured.length) return [];
    const witnesses = new Map(queryLocalFactorChoices(program.localFactors, source, key, true).map(choice => [choice.surface, choice.evidenceCoordinates]));
    return measured.map(choice => ({ ...choice, evidenceCoordinates: witnesses.get(choice.surface) ?? [] }));
  }
  if (source === "conditioned") return program.conditionedIndex[key] ?? [];
  if (source === "exact") return program.exactIndex[key] ?? [];
  if (source === "structural") return program.structuralIndex[key] ?? [];
  if (source === "class") return program.classIndex[key] ?? [];
  if (source === "local_shape") return program.localShapeIndex[key] ?? [];
  return program.constructionIndex[key] ?? [];
}

function choicesForIndex(program: JoinProgramModel, source: JoinBackoffSource, key: string, proofs: boolean): JoinProgramChoice[] {
  return joinProgramChoices(program, source, key, { proofs });
}

function normalizedComponentWeights(
  mixture: JoinProgramMixture,
  populationPosterior?: Readonly<Record<string, number>>
): Map<string, number> {
  const weights = new Map<string, number>();
  let total = 0;
  for (const component of mixture.components) {
    const posteriorWeight = populationPosterior?.[component.populationId];
    const weight = Math.max(0, posteriorWeight ?? component.weight);
    weights.set(component.populationId, weight);
    total += weight;
  }
  if (total <= 0) return weights;
  for (const [id, weight] of weights) weights.set(id, weight / total);
  return weights;
}

function exactJoinKey(left: string, right: string): string {
  return JSON.stringify([left, right]);
}

function boundaryBucket(probability: number): number {
  return Math.min(7, Math.max(0, Math.floor(clamp01(probability) * 8)));
}

function boundaryShape(char: string): string {
  if (!char) return "empty";
  if (/\p{Letter}/u.test(char)) return "letter";
  if (/\p{Number}/u.test(char)) return "number";
  if (/\p{Mark}/u.test(char)) return "mark";
  if (/\p{Punctuation}/u.test(char)) return "punctuation";
  if (/\p{Symbol}/u.test(char)) return "symbol";
  if (/\p{Separator}/u.test(char)) return "separator";
  return "other";
}

function punctuationSignature(value: string): string {
  return [...value].filter(char => /\p{Punctuation}/u.test(char)).join("");
}

function normalize(value: string, contract = canonicalNormalizationContract()): string {
  return normalizeCanonicalSurface(value, contract);
}

function quantize(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

function positivePrecision(value: number): number {
  const rounded = quantize(value);
  return rounded === 0 && value > 0 ? value : rounded;
}
