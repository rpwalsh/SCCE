import type { SurfaceLattice, SurfaceLatticeUnit } from "./surface-lattice.js";
import { clamp01, createHasher, toJsonValue } from "./primitives.js";
import type { Hasher, JsonValue } from "./types.js";
import {
  canonicalNormalizationContract,
  normalizeCanonicalSurface
} from "./normalization-contract.js";

export const JOIN_PROGRAM_SCHEMA = "scce.join_program.v2" as const;
export const JOIN_PROGRAM_MIXTURE_SCHEMA = "scce.join_program_mixture.v2" as const;

export interface JoinProgramChoice {
  surface: string;
  count: number;
  probability: number;
  evidenceIds: string[];
}

export interface JoinProgramEvaluation {
  heldoutDocumentIds: string[];
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
  sourceDocumentIds: string[];
  trainingDocumentIds: string[];
  evaluation: JoinProgramEvaluation;
  audit: JsonValue;
}

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
  observedSourceSpan?: {
    text: string;
    evidenceIds: string[];
  };
}

export interface JoinProgramTraceStep {
  left: string;
  right: string;
  join: string;
  source: "conditioned" | "exact" | "structural" | "preserved_source_span" | "unresolved";
  support: number;
  alternatives: JoinProgramChoice[];
  evidenceIds: string[];
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
}

interface JoinEvent {
  left: SurfaceLatticeUnit;
  right: SurfaceLatticeUnit;
  join: string;
  weight: number;
  evidenceIds: string[];
  conditionedKey: string;
  exactKey: string;
  structuralKey: string;
  crossScript: boolean;
}

export function compileJoinProgram(input: {
  populationId: string;
  documents: readonly {
    documentId: string;
    text: string;
    lattice: SurfaceLattice;
    constructionId?: string;
    discourseStateId?: string;
  }[];
  minimumConfidence?: number;
  hasher?: Hasher;
}): JoinProgramModel {
  const hasher = input.hasher ?? createHasher();
  const minimumConfidence = Math.min(1, Math.max(0.5, input.minimumConfidence ?? 0.67));
  const documents = [...input.documents].sort((left, right) =>
    left.documentId.localeCompare(right.documentId));
  const split = sourceDisjointSplit(documents, hasher);
  const conditioned = new Map<string, Map<string, JoinCount>>();
  const exact = new Map<string, Map<string, JoinCount>>();
  const structural = new Map<string, Map<string, JoinCount>>();
  let observations = 0;
  for (const document of split.training) {
    for (const event of joinEvents(document)) {
      addCount(conditioned, event.conditionedKey, event.join, event.evidenceIds, event.weight);
      addCount(exact, event.exactKey, event.join, event.evidenceIds, event.weight);
      addCount(structural, event.structuralKey, event.join, event.evidenceIds, event.weight);
      observations += event.weight;
    }
  }
  const conditionedIndex = compileIndex(conditioned);
  const exactIndex = compileIndex(exact);
  const structuralIndex = compileIndex(structural);
  const evaluation = evaluateHeldoutJoins({
    documents: split.heldout,
    conditionedIndex,
    exactIndex,
    structuralIndex,
    minimumConfidence
  });
  const sourceDocumentIds = documents.map(document => document.documentId);
  const canonical = {
    schema: JOIN_PROGRAM_SCHEMA,
    populationId: input.populationId,
    observations: quantize(observations),
    minimumConfidence,
    conditionedIndex,
    exactIndex,
    structuralIndex,
    sourceDocumentIds,
    trainingDocumentIds: split.training.map(document => document.documentId),
    evaluation
  };
  return {
    ...canonical,
    id: `join_program.${hasher.digestHex(JSON.stringify(canonical)).slice(0, 40)}`,
    audit: toJsonValue({
      compiler: "kernel.join_program.v2",
      conditionedContextCount: Object.keys(conditionedIndex).length,
      exactContextCount: Object.keys(exactIndex).length,
      structuralContextCount: Object.keys(structuralIndex).length,
      sourceExactJoins: true,
      derivationConditioned: true,
      populationConditionedByMixture: true,
      globalJoinFallback: false,
      languageGrammarLabels: false,
      heldoutEvaluation: split.heldout.length > 0
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
    0.5,
    input.minimumConfidence
      ?? Math.max(0.5, ...components.map(component => component.program.minimumConfidence))
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
    const selected = mixture
      ? selectJoin(mixture, left, right, context.units?.[index - 1], context.units?.[index], context.boundaries?.[index - 1])
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
    && Array.isArray(row.components);
}

function selectJoin(
  mixture: JoinProgramMixture,
  left: string,
  right: string,
  leftContext?: JoinUnitContext,
  rightContext?: JoinUnitContext,
  boundaryContext?: JoinBoundaryContext
): (JoinProgramChoice & {
  source: "conditioned" | "exact" | "structural";
  support: number;
  alternatives: JoinProgramChoice[];
  contextKey?: string;
}) | undefined {
  const keys: Array<{
    key: string;
    source: "conditioned" | "exact" | "structural";
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
  }
  keys.splice(keys.length > 0 ? 1 : 0, 0, {
    key: exactJoinKey(normalize(left), normalize(right)),
    source: "exact"
  });
  for (const { key, source } of keys) {
    const candidates = aggregateChoices(mixture, key, source);
    if (candidates.length) {
      return {
        ...candidates[0]!,
        source,
        support: candidates[0]!.probability,
        alternatives: candidates,
        contextKey: key
      };
    }
  }
  return undefined;
}

function aggregateChoices(
  mixture: JoinProgramMixture,
  key: string,
  source: "conditioned" | "exact" | "structural"
): JoinProgramChoice[] {
  const counts = new Map<string, JoinCount>();
  for (const component of mixture.components) {
    const rows = source === "conditioned"
      ? component.program.conditionedIndex[key] ?? []
      : source === "exact"
        ? component.program.exactIndex[key] ?? []
        : component.program.structuralIndex[key] ?? [];
    for (const row of rows) {
      const weighted = row.count * component.weight;
      const current = counts.get(row.surface) ?? {
        surface: row.surface,
        count: 0,
        evidenceIds: new Set<string>()
      };
      current.count += weighted;
      for (const id of row.evidenceIds) current.evidenceIds.add(id);
      counts.set(row.surface, current);
    }
  }
  return choices(counts);
}

function joinEvents(document: {
  documentId: string;
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
        crossScript: left.scriptId !== right.scriptId
      });
    }
  }
  return events;
}

function evaluateHeldoutJoins(input: {
  documents: readonly {
    documentId: string;
    text: string;
    lattice: SurfaceLattice;
    constructionId?: string;
    discourseStateId?: string;
  }[];
  conditionedIndex: Record<string, JoinProgramChoice[]>;
  exactIndex: Record<string, JoinProgramChoice[]>;
  structuralIndex: Record<string, JoinProgramChoice[]>;
  minimumConfidence: number;
}): JoinProgramEvaluation {
  let mass = 0;
  let correctMass = 0;
  let negativeLogLikelihood = 0;
  let whitespaceInsertionErrors = 0;
  let whitespaceDeletionErrors = 0;
  let punctuationErrors = 0;
  let crossScriptMass = 0;
  let crossScriptCorrect = 0;
  const calibrationBins = Array.from({ length: 10 }, () => ({ confidence: 0, correct: 0, mass: 0 }));
  for (const document of input.documents) {
    for (const event of joinEvents(document)) {
      const alternatives = input.conditionedIndex[event.conditionedKey]
        ?? input.exactIndex[event.exactKey]
        ?? input.structuralIndex[event.structuralKey]
        ?? [];
      const selected = alternatives[0];
      const assigned = alternatives.find(choice => choice.surface === event.join)?.probability ?? 0;
      const confidence = selected?.probability ?? 0;
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
  if (mass <= 0) {
    return {
      heldoutDocumentIds: input.documents.map(document => document.documentId),
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
    observations: quantize(mass),
    exactAccuracy: quantize(accuracy),
    negativeLogLikelihood: quantize(negativeLogLikelihood / mass),
    expectedCalibrationError: quantize(ece),
    reconstructionAccuracy: quantize(accuracy),
    whitespaceInsertionErrors,
    whitespaceDeletionErrors,
    punctuationErrors,
    crossScriptAccuracy: crossScriptMass > 0
      ? quantize(crossScriptCorrect / crossScriptMass)
      : null
  };
}

function sourceDisjointSplit<T extends { documentId: string }>(
  documents: readonly T[],
  hasher: Hasher
): { training: T[]; heldout: T[] } {
  if (documents.length < 4) return { training: [...documents], heldout: [] };
  const ranked = documents.map(document => ({
    document,
    rank: hasher.digestHex(`join-program-holdout\u001f${document.documentId}`)
  })).sort((left, right) =>
    left.rank.localeCompare(right.rank)
    || left.document.documentId.localeCompare(right.document.documentId));
  const heldoutCount = Math.max(1, Math.floor(documents.length / 5));
  const heldoutIds = new Set(ranked.slice(0, heldoutCount)
    .map(row => row.document.documentId));
  return {
    training: documents.filter(document => !heldoutIds.has(document.documentId)),
    heldout: documents.filter(document => heldoutIds.has(document.documentId))
  };
}

function addCount(
  index: Map<string, Map<string, JoinCount>>,
  key: string,
  surface: string,
  evidenceIds: readonly string[],
  weight: number
): void {
  const bucket = index.get(key) ?? new Map<string, JoinCount>();
  const row = bucket.get(surface) ?? {
    surface,
    count: 0,
    evidenceIds: new Set<string>()
  };
  row.count += weight;
  for (const id of evidenceIds) row.evidenceIds.add(id);
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
      evidenceIds: [...row.evidenceIds].sort()
    }))
    .sort((left, right) =>
      right.count - left.count
      || left.surface.localeCompare(right.surface));
}

function unitContext(unit: SurfaceLatticeUnit): JoinUnitContext {
  return {
    surfaceFormClassId: unit.surfaceFormClassId,
    scaleId: unit.kind,
    graphemeWidth: Math.max(1, unit.graphemeEnd - unit.graphemeStart)
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
