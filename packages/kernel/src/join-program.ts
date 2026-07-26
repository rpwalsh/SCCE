import type { SurfaceLattice, SurfaceLatticeUnit } from "./surface-lattice.js";
import { clamp01, createHasher, toJsonValue } from "./primitives.js";
import type { Hasher, JsonValue } from "./types.js";
import {
  canonicalNormalizationContract,
  normalizeCanonicalSurface
} from "./normalization-contract.js";

export const JOIN_PROGRAM_SCHEMA = "scce.join_program.v3" as const;
export const JOIN_PROGRAM_MIXTURE_SCHEMA = "scce.join_program_mixture.v3" as const;

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
  conditionedKey: string;
  exactKey: string;
  structuralKey: string;
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
  const conditioned = new Map<string, Map<string, JoinCount>>();
  const exact = new Map<string, Map<string, JoinCount>>();
  const structural = new Map<string, Map<string, JoinCount>>();
  const classes = new Map<string, Map<string, JoinCount>>();
  const localShapes = new Map<string, Map<string, JoinCount>>();
  const constructions = new Map<string, Map<string, JoinCount>>();
  let observations = 0;
  for (const document of split.training) {
    for (const event of joinEvents(document)) {
      addCount(conditioned, event.conditionedKey, event.join, event.evidenceIds, event.evidenceCoordinates, event.weight);
      addCount(exact, event.exactKey, event.join, event.evidenceIds, event.evidenceCoordinates, event.weight);
      addCount(structural, event.structuralKey, event.join, event.evidenceIds, event.evidenceCoordinates, event.weight);
      addCount(classes, event.classKey, event.join, event.evidenceIds, event.evidenceCoordinates, event.weight);
      addCount(localShapes, event.localShapeKey, event.join, event.evidenceIds, event.evidenceCoordinates, event.weight);
      if (event.constructionKey) {
        addCount(constructions, event.constructionKey, event.join, event.evidenceIds, event.evidenceCoordinates, event.weight);
      }
      observations += event.weight;
    }
  }
  const conditionedIndex = compileIndex(conditioned);
  const exactIndex = compileIndex(exact);
  const structuralIndex = compileIndex(structural);
  const classIndex = compileIndex(classes);
  const localShapeIndex = compileIndex(localShapes);
  const constructionIndex = compileIndex(constructions);
  const indexes = {
    conditionedIndex,
    exactIndex,
    structuralIndex,
    classIndex,
    localShapeIndex,
    constructionIndex
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
    observations: quantize(observations),
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
      compiler: "kernel.join_program.v3",
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
        && Boolean(item.program && typeof item.program === "object");
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
  for (const { key, source } of keys) {
    const aggregate = aggregateChoices(mixture, key, source, populationPosterior);
    if (aggregate.choices.length) {
      return {
        ...aggregate.choices[0]!,
        source,
        support: aggregate.choices[0]!.probability,
        unresolvedPopulationMass: aggregate.unresolvedPopulationMass,
        alternatives: aggregate.choices,
        contextKey: key
      };
    }
  }
  return undefined;
}

function aggregateChoices(
  mixture: JoinProgramMixture,
  key: string,
  source: JoinBackoffSource,
  populationPosterior?: Readonly<Record<string, number>>
): { choices: JoinProgramChoice[]; unresolvedPopulationMass: number } {
  const componentWeights = normalizedComponentWeights(mixture, populationPosterior);
  const probabilities = new Map<string, JoinCount>();
  let unresolvedPopulationMass = 0;
  for (const component of mixture.components) {
    const weight = componentWeights.get(component.populationId) ?? 0;
    if (weight <= 0) continue;
    const rows = choicesForIndex(component.program, source, key);
    if (!rows.length) {
      unresolvedPopulationMass += weight;
      continue;
    }
    const reliability = clamp01(component.program.backoffReliability?.[source] ?? 1);
    unresolvedPopulationMass += weight * (1 - reliability);
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
      for (const coordinate of row.evidenceCoordinates ?? []) {
        current.evidenceCoordinates.set(evidenceCoordinateKey(coordinate), coordinate);
      }
      probabilities.set(row.surface, current);
    }
  }
  const result = [...probabilities.values()]
    .map(row => ({
      surface: row.surface,
      count: quantize(row.count),
      probability: quantize(row.count),
      evidenceIds: [...row.evidenceIds].sort(),
      evidenceCoordinates: [...row.evidenceCoordinates.values()]
        .sort(compareEvidenceCoordinates)
    }))
    .sort((left, right) =>
      right.probability - left.probability
      || left.surface.localeCompare(right.surface));
  return {
    choices: result,
    unresolvedPopulationMass: quantize(unresolvedPopulationMass)
  };
}

function joinEvents(document: {
  documentId: string;
  sourceFamilyId?: string;
  text: string;
  lattice: SurfaceLattice;
  constructionId?: string;
  discourseStateId?: string;
}): JoinEvent[] {
  const events: JoinEvent[] = [];
  const unitsById = new Map(document.lattice.units.map(unit => [unit.id, unit]));
  for (const path of document.lattice.segmentationForest.paths) {
    const units = path.unitIds
      .map(unitId => requiredUnit(unitsById, unitId))
      .filter(isSurfaceBearingUnit);
    const pathWeight = Math.max(0, path.posterior);
    const derivationShapeId = derivationShape(units);
    for (let index = 1; index < units.length; index += 1) {
      const left = units[index - 1]!;
      const right = units[index]!;
      const join = document.text.slice(left.utf16End, right.utf16Start);
      const evidenceIds = [...new Set([...left.evidenceIds, ...right.evidenceIds])].sort();
      const byteStart = left.byteEnd;
      const byteEnd = right.byteStart;
      const coordinates = evidenceIds.map(evidenceId => ({
        evidenceId,
        ...(document.lattice.sourceVersionId
          ? { sourceVersionId: document.lattice.sourceVersionId }
          : {}),
        documentId: document.documentId,
        byteStart,
        byteEnd,
        utf16Start: left.utf16End,
        utf16End: right.utf16Start,
        exactSurfaceHash: createHasher().digestHex(join)
      }));
      const leftContext = unitContext(left);
      const rightContext = unitContext(right);
      const boundaryContext: JoinBoundaryContext = {
        boundaryProbability: left.boundaryAfter.boundaryProbability,
        constructionId: document.constructionId,
        discourseStateId: document.discourseStateId,
        derivationShapeId
      };
      events.push({
        left,
        right,
        join,
        weight: pathWeight,
        evidenceIds,
        evidenceCoordinates: coordinates,
        conditionedKey: conditionedJoinKey({
          left: left.normalized,
          right: right.normalized,
          leftContext,
          rightContext,
          boundaryContext
        }),
        exactKey: exactJoinKey(left.normalized, right.normalized),
        structuralKey: structuralJoinKey(
          left.surface,
          right.surface,
          leftContext,
          rightContext,
          boundaryContext
        ),
        classKey: classJoinKey(leftContext, rightContext, boundaryContext),
        localShapeKey: localShapeJoinKey(left.surface, right.surface),
        ...(document.constructionId
          ? { constructionKey: constructionJoinKey(
            left.surface,
            right.surface,
            document.constructionId
          ) }
          : {}),
        crossScript: left.scriptId !== right.scriptId
      });
    }
  }
  return events;
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
    for (const event of joinEvents(document)) {
      const prediction = predictionForEvent(event, input);
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
        if (/\s/u.test(predicted) && !/\s/u.test(event.join)) whitespaceInsertionErrors += 1;
        if (!/\s/u.test(predicted) && /\s/u.test(event.join)) whitespaceDeletionErrors += 1;
        if (punctuationSignature(predicted) !== punctuationSignature(event.join)) punctuationErrors += 1;
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
    observations: quantize(mass),
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
  indexes: JoinIndexes
): { source: JoinBackoffSource; alternatives: JoinProgramChoice[] } {
  const levels: Array<{ source: JoinBackoffSource; alternatives: JoinProgramChoice[] }> = [
    { source: "conditioned", alternatives: indexes.conditionedIndex[event.conditionedKey] ?? [] },
    { source: "exact", alternatives: indexes.exactIndex[event.exactKey] ?? [] },
    { source: "structural", alternatives: indexes.structuralIndex[event.structuralKey] ?? [] },
    { source: "class", alternatives: indexes.classIndex[event.classKey] ?? [] },
    { source: "local_shape", alternatives: indexes.localShapeIndex[event.localShapeKey] ?? [] },
    {
      source: "construction",
      alternatives: event.constructionKey
        ? indexes.constructionIndex[event.constructionKey] ?? []
        : []
    }
  ];
  return levels.find(level => level.alternatives.length > 0)
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
    joinEvents(document).map(event => {
      const prediction = predictionForEvent(event, indexes);
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
    ...observations.map(row => quantize(
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
    for (const event of joinEvents(document)) {
      for (const source of sources) {
        const alternatives = choicesForIndexes(indexes, source, event);
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
  if (source === "conditioned") return indexes.conditionedIndex[event.conditionedKey] ?? [];
  if (source === "exact") return indexes.exactIndex[event.exactKey] ?? [];
  if (source === "structural") return indexes.structuralIndex[event.structuralKey] ?? [];
  if (source === "class") return indexes.classIndex[event.classKey] ?? [];
  if (source === "local_shape") return indexes.localShapeIndex[event.localShapeKey] ?? [];
  return event.constructionKey
    ? indexes.constructionIndex[event.constructionKey] ?? []
    : [];
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
    const prediction = predictionForEvent(event, indexes);
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
  weight: number
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
    row.evidenceCoordinates.set(evidenceCoordinateKey(coordinate), coordinate);
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
  return unit.surface.length > 0
    && !/^\s+$/u.test(unit.surface)
    && !/^\p{Control}+$/u.test(unit.surface);
}

function compileIndex(
  index: ReadonlyMap<string, ReadonlyMap<string, JoinCount>>
): Record<string, JoinProgramChoice[]> {
  return Object.fromEntries([...index.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, rows]) => [key, choices(rows)]));
}

function choices(rows: ReadonlyMap<string, JoinCount>): JoinProgramChoice[] {
  const total = [...rows.values()].reduce((sum, row) => sum + row.count, 0);
  return [...rows.values()]
    .map(row => ({
      surface: row.surface,
      count: quantize(row.count),
      probability: quantize(total > 0 ? row.count / total : 0),
      evidenceIds: [...row.evidenceIds].sort(),
      evidenceCoordinates: [...row.evidenceCoordinates.values()]
        .sort(compareEvidenceCoordinates)
    }))
    .sort((left, right) =>
      right.count - left.count
      || left.surface.localeCompare(right.surface));
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

function derivationShape(units: readonly SurfaceLatticeUnit[]): string {
  return units.map(unit =>
    `${unit.kind}:${Math.max(1, unit.graphemeEnd - unit.graphemeStart)}`).join("\u001f");
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

function choicesForIndex(
  program: JoinProgramModel,
  source: JoinBackoffSource,
  key: string
): JoinProgramChoice[] {
  if (source === "conditioned") return program.conditionedIndex[key] ?? [];
  if (source === "exact") return program.exactIndex[key] ?? [];
  if (source === "structural") return program.structuralIndex[key] ?? [];
  if (source === "class") return program.classIndex[key] ?? [];
  if (source === "local_shape") return program.localShapeIndex[key] ?? [];
  return program.constructionIndex[key] ?? [];
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

function normalize(value: string): string {
  return normalizeCanonicalSurface(value, canonicalNormalizationContract());
}

function quantize(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}
