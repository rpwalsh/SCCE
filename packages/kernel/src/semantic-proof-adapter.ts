import type {
  CodeObservation,
  LogEventObservation,
  MeasurementObservation,
  Observation,
  ObservationForceClass
} from "./ingestion-lanes.js";
import { evidenceProofBoundary } from "./proof-boundary.js";
import type { ProofAtom, ProofClaim, ProofEvidenceRecord, ProofForceClass, ProofScalar } from "./semantic-proof-engine.js";
import type { ConstructGraph, EvidenceSpan, GraphNode, JsonValue } from "./types.js";

export type SupportedProofObservation = MeasurementObservation | LogEventObservation | CodeObservation;

export interface ConstructProofAdapterInput {
  construct: ConstructGraph;
}

export interface EvidenceProofAdapterInput {
  evidence?: readonly EvidenceSpan[];
  spans?: readonly EvidenceSpan[];
  nodes?: readonly GraphNode[];
  observations?: readonly SupportedProofObservation[];
}

export interface TypedObservationProofAdapterInput {
  observation?: SupportedProofObservation;
  observations?: readonly SupportedProofObservation[];
  evidence?: readonly EvidenceSpan[];
  spans?: readonly EvidenceSpan[];
  evidenceById?: ReadonlyMap<string, EvidenceSpan> | Record<string, EvidenceSpan>;
}

interface ProofCarrierFields {
  id?: string;
  subjectId?: string;
  subjectKindId?: string;
  subjectSurface?: string;
  relationId?: string;
  objectId?: string;
  objectKindId?: string;
  objectSurface?: string;
  quantity?: ProofScalar;
  dateTime?: { value: string; precisionId?: string };
  polarityId?: string;
  modalityId?: string;
  sourceVersionId?: string;
  evidenceSpanId?: string;
  forceClass?: ProofForceClass;
  requiredSourceBinding?: boolean;
  text?: string;
}

const RELATION_MEASUREMENT_QUANTITY = "relation.measurement.quantity";
const RELATION_LOG_STATE = "relation.log.state";
const RELATION_CODE_FACT = "relation.code.fact";
const ATOM_MEASUREMENT_SUBJECT = "kind.measurement.subject";
const ATOM_MEASUREMENT_OBJECT = "kind.measurement.object";
const ATOM_LOG_SUBJECT = "kind.log.subject";
const ATOM_LOG_OBJECT = "kind.log.object";
const ATOM_CODE_SUBJECT = "kind.code.subject";
const ATOM_CODE_OBJECT = "kind.code.object";
const DIRECT_FORCE: ProofForceClass = "direct_evidence";
const UNKNOWN_FORCE: ProofForceClass = "unknown_prior";

export function constructToProofClaims(input: ConstructProofAdapterInput): ProofClaim[] {
  const claims: ProofClaim[] = [];
  const seen = new Set<string>();
  const add = (claim: ProofClaim | undefined) => {
    if (!claim || seen.has(claim.id)) return;
    seen.add(claim.id);
    claims.push(claim);
  };

  for (const candidate of proofClaimCarriers(input.construct.forceVector)) add(candidate);
  for (const node of input.construct.nodes) {
    for (const candidate of proofClaimCarriers(node.metadata)) add(candidate);
  }
  for (const edge of input.construct.edges) {
    const metadata = objectRecord(edge as unknown as JsonValue)?.metadata;
    for (const candidate of proofClaimCarriers(metadata)) add(candidate);
  }
  return claims;
}

export function evidenceToProofRecords(input: EvidenceProofAdapterInput): ProofEvidenceRecord[] {
  const records: ProofEvidenceRecord[] = [];
  const seen = new Set<string>();
  const add = (record: ProofEvidenceRecord | undefined) => {
    if (!record || seen.has(record.id)) return;
    seen.add(record.id);
    records.push(record);
  };

  for (const span of input.evidence ?? input.spans ?? []) {
    const boundary = evidenceProofBoundary(span);
    for (const carrier of proofEvidenceCarriers(span.provenance)) add(proofRecordFromCarrier(carrier, span, boundary.forceClass, boundary.certifiesFactualProof));
    for (const carrier of proofEvidenceCarriers(span.trustVector)) add(proofRecordFromCarrier(carrier, span, boundary.forceClass, boundary.certifiesFactualProof));
    for (const carrier of proofEvidenceCarriers(span.languageHints)) add(proofRecordFromCarrier(carrier, span, boundary.forceClass, boundary.certifiesFactualProof));
    for (const carrier of proofEvidenceCarriers(span.scriptHints)) add(proofRecordFromCarrier(carrier, span, boundary.forceClass, boundary.certifiesFactualProof));
  }

  for (const node of input.nodes ?? []) {
    for (const carrier of proofEvidenceCarriers(node.metadata)) add(proofRecordFromCarrier(carrier));
    for (const carrier of proofEvidenceCarriers(node.representation)) add(proofRecordFromCarrier(carrier));
  }

  for (const record of typedObservationToProofRecords({ observations: input.observations ?? [], evidence: input.evidence ?? input.spans ?? [] })) add(record);
  return records;
}

export function typedObservationToProofRecords(input: TypedObservationProofAdapterInput | SupportedProofObservation | readonly SupportedProofObservation[]): ProofEvidenceRecord[] {
  const normalized = normalizeTypedObservationInput(input);
  const evidenceById = normalized.evidenceById;
  return normalized.observations.flatMap(observation => proofRecordsFromObservation(observation, evidenceById));
}

function proofRecordsFromObservation(observation: SupportedProofObservation, evidenceById: ReadonlyMap<string, EvidenceSpan>): ProofEvidenceRecord[] {
  const fields = fieldsFromObservation(observation, evidenceById);
  const forceClass = fields.forceClass ?? proofForceClassFromObservation(observation.forceClass, fields.evidenceSpanId);
  const record = proofRecordFromFields({
    ...fields,
    forceClass,
    sourceVersionId: fields.sourceVersionId ?? String(observation.sourceVersionId),
    evidenceSpanId: fields.evidenceSpanId,
    id: fields.id ?? `proof.evidence.${observation.id}`
  });
  return record ? [record] : [];
}

function fieldsFromObservation(observation: SupportedProofObservation, evidenceById: ReadonlyMap<string, EvidenceSpan>): ProofCarrierFields {
  const metadataFields = fieldsFromJson(observation.metadata);
  const evidenceSpanId = metadataFields.evidenceSpanId ?? certifyingEvidenceSpanId(observation.evidenceIds.map(String), evidenceById);
  const sourceVersionId = metadataFields.sourceVersionId ?? String(observation.sourceVersionId);
  if (observation.kind === "measurement") {
    return {
      id: metadataFields.id ?? `proof.evidence.measurement.${observation.id}`,
      subjectId: metadataFields.subjectId ?? observation.sensor ?? observation.tableId ?? observation.datasetId,
      subjectKindId: metadataFields.subjectKindId ?? ATOM_MEASUREMENT_SUBJECT,
      relationId: metadataFields.relationId ?? RELATION_MEASUREMENT_QUANTITY,
      objectId: metadataFields.objectId ?? observation.measurementId,
      objectKindId: metadataFields.objectKindId ?? ATOM_MEASUREMENT_OBJECT,
      quantity: metadataFields.quantity ?? { value: observation.value, unitId: observation.unit, tolerance: observation.tolerance },
      dateTime: metadataFields.dateTime ?? (observation.timestamp ? { value: observation.timestamp } : undefined),
      polarityId: metadataFields.polarityId,
      modalityId: metadataFields.modalityId,
      forceClass: metadataFields.forceClass,
      sourceVersionId,
      evidenceSpanId
    };
  }
  if (observation.kind === "log_event") {
    return {
      id: metadataFields.id ?? `proof.evidence.log.${observation.id}`,
      subjectId: metadataFields.subjectId ?? observation.component ?? observation.streamId,
      subjectKindId: metadataFields.subjectKindId ?? ATOM_LOG_SUBJECT,
      relationId: metadataFields.relationId ?? RELATION_LOG_STATE,
      objectId: metadataFields.objectId ?? observation.severity ?? observation.message,
      objectKindId: metadataFields.objectKindId ?? ATOM_LOG_OBJECT,
      dateTime: metadataFields.dateTime ?? (observation.timestamp ? { value: observation.timestamp } : undefined),
      polarityId: metadataFields.polarityId,
      modalityId: metadataFields.modalityId,
      forceClass: metadataFields.forceClass,
      sourceVersionId,
      evidenceSpanId
    };
  }
  return {
    id: metadataFields.id ?? `proof.evidence.code.${observation.id}`,
    subjectId: metadataFields.subjectId ?? observation.filePath,
    subjectKindId: metadataFields.subjectKindId ?? ATOM_CODE_SUBJECT,
    relationId: metadataFields.relationId ?? RELATION_CODE_FACT,
    objectId: metadataFields.objectId ?? firstCodeObjectId(observation),
    objectKindId: metadataFields.objectKindId ?? ATOM_CODE_OBJECT,
    polarityId: metadataFields.polarityId,
    modalityId: metadataFields.modalityId,
    forceClass: metadataFields.forceClass,
    sourceVersionId,
    evidenceSpanId
  };
}

function normalizeTypedObservationInput(input: TypedObservationProofAdapterInput | SupportedProofObservation | readonly SupportedProofObservation[]): { observations: readonly SupportedProofObservation[]; evidenceById: ReadonlyMap<string, EvidenceSpan> } {
  if (Array.isArray(input)) return { observations: input, evidenceById: new Map() };
  if (isObservation(input)) return { observations: [input], evidenceById: new Map() };
  const options = input as TypedObservationProofAdapterInput;
  const observations = options.observations ?? (options.observation ? [options.observation] : []);
  return {
    observations,
    evidenceById: mergeEvidenceIndexes(options.evidenceById, options.evidence ?? options.spans ?? [])
  };
}

function proofClaimCarriers(value: JsonValue | undefined): ProofClaim[] {
  const claims: ProofClaim[] = [];
  for (const carrier of carriers(value, ["proofClaim", "proofClaims", "claims"])) {
    const claim = proofClaimFromCarrier(carrier);
    if (claim) claims.push(claim);
  }
  return claims;
}

function proofEvidenceCarriers(value: JsonValue | undefined): ProofCarrierFields[] {
  return carriers(value, ["proofEvidence", "proofRecord", "proofRecords", "records"]).map(fieldsFromJson);
}

function carriers(value: JsonValue | undefined, keys: readonly string[]): JsonValue[] {
  const out: JsonValue[] = [];
  const record = objectRecord(value);
  if (!record) return out;
  for (const key of keys) {
    const direct = record[key];
    if (Array.isArray(direct)) out.push(...direct);
    else if (direct !== undefined) out.push(direct);
  }
  const semantic = objectRecord(record.semanticProof);
  if (semantic) {
    for (const key of keys) {
      const nested = semantic[key];
      if (Array.isArray(nested)) out.push(...nested);
      else if (nested !== undefined) out.push(nested);
    }
  }
  return out;
}

function proofClaimFromCarrier(value: JsonValue): ProofClaim | undefined {
  const fields = fieldsFromJson(value);
  if (!fields.id || !fields.relationId || !fields.subjectId || !fields.objectId) return undefined;
  return {
    id: fields.id,
    subject: atom(fields.subjectId, fields.subjectKindId, fields.subjectSurface),
    relationId: fields.relationId,
    object: atom(fields.objectId, fields.objectKindId, fields.objectSurface),
    quantity: fields.quantity,
    dateTime: fields.dateTime,
    polarityId: fields.polarityId,
    modalityId: fields.modalityId,
    requiredSourceBinding: fields.requiredSourceBinding
  };
}

function proofRecordFromCarrier(value: ProofCarrierFields, span?: EvidenceSpan, boundaryForceClass?: string, certifyingSpan?: boolean): ProofEvidenceRecord | undefined {
  const forceClass = value.forceClass ?? proofForceClassFromBoundary(boundaryForceClass);
  const sourceVersionId = value.sourceVersionId ?? (span ? String(span.sourceVersionId) : undefined);
  const evidenceSpanId = value.evidenceSpanId ?? (span && certifyingSpan ? String(span.id) : undefined);
  return proofRecordFromFields({ ...value, forceClass, sourceVersionId, evidenceSpanId, id: value.id ?? (span ? String(span.id) : undefined) });
}

function proofRecordFromFields(fields: ProofCarrierFields): ProofEvidenceRecord | undefined {
  if (!fields.id || !fields.relationId || !fields.subjectId || !fields.objectId || !fields.forceClass) return undefined;
  return {
    id: fields.id,
    forceClass: fields.forceClass,
    sourceVersionId: fields.sourceVersionId,
    evidenceSpanId: fields.evidenceSpanId,
    subject: atom(fields.subjectId, fields.subjectKindId, fields.subjectSurface),
    relationId: fields.relationId,
    object: atom(fields.objectId, fields.objectKindId, fields.objectSurface),
    quantity: fields.quantity,
    dateTime: fields.dateTime,
    polarityId: fields.polarityId,
    modalityId: fields.modalityId,
    text: fields.text
  };
}

function fieldsFromJson(value: JsonValue | undefined): ProofCarrierFields {
  const record = objectRecord(value);
  if (!record) return {};
  const subject = objectRecord(record.subject);
  const object = objectRecord(record.object);
  const quantity = quantityFrom(record.quantity) ?? quantityFrom(record);
  const dateTime = dateTimeFrom(record.dateTime) ?? dateTimeFrom(record);
  return {
    id: firstString(record.id, record.claimId, record.recordId),
    subjectId: firstString(record.subjectId, subject?.id),
    subjectKindId: firstString(record.subjectKindId, subject?.kindId),
    subjectSurface: firstString(record.subjectSurface, subject?.surface),
    relationId: firstString(record.relationId),
    objectId: firstString(record.objectId, object?.id),
    objectKindId: firstString(record.objectKindId, object?.kindId),
    objectSurface: firstString(record.objectSurface, object?.surface),
    quantity,
    dateTime,
    polarityId: firstString(record.polarityId),
    modalityId: firstString(record.modalityId),
    sourceVersionId: firstString(record.sourceVersionId),
    evidenceSpanId: firstString(record.evidenceSpanId),
    forceClass: proofForceClassFromBoundary(firstString(record.forceClass, record.provenanceClass)),
    requiredSourceBinding: typeof record.requiredSourceBinding === "boolean" ? record.requiredSourceBinding : undefined,
    text: firstString(record.text)
  };
}

function quantityFrom(value: JsonValue | undefined): ProofScalar | undefined {
  const record = objectRecord(value);
  if (!record) return undefined;
  const raw = firstNumber(record.value, record.quantity);
  if (raw === undefined) return undefined;
  const tolerance = firstNumber(record.tolerance);
  return {
    value: raw,
    unitId: firstString(record.unitId, record.unit),
    tolerance
  };
}

function dateTimeFrom(value: JsonValue | undefined): { value: string; precisionId?: string } | undefined {
  const record = objectRecord(value);
  if (!record) return undefined;
  const text = firstString(record.value, record.dateTime, record.timestamp, record.observedAt);
  return text ? { value: text, precisionId: firstString(record.precisionId) } : undefined;
}

function atom(id: string, kindId?: string, surface?: string): ProofAtom {
  return { id, kindId, surface };
}

function certifyingEvidenceSpanId(ids: readonly string[], evidenceById: ReadonlyMap<string, EvidenceSpan>): string | undefined {
  for (const id of ids) {
    const span = evidenceById.get(id);
    if (span && evidenceProofBoundary(span).certifiesFactualProof) return String(span.id);
  }
  return undefined;
}

function mergeEvidenceIndexes(index: ReadonlyMap<string, EvidenceSpan> | Record<string, EvidenceSpan> | undefined, spans: readonly EvidenceSpan[]): ReadonlyMap<string, EvidenceSpan> {
  const out = new Map<string, EvidenceSpan>();
  if (index instanceof Map) {
    for (const [key, span] of index) out.set(key, span);
  } else if (index) {
    for (const [key, span] of Object.entries(index)) out.set(key, span);
  }
  for (const span of spans) out.set(String(span.id), span);
  return out;
}

function proofForceClassFromObservation(value: ObservationForceClass | undefined, evidenceSpanId: string | undefined): ProofForceClass {
  if (value === "direct_evidence" || value === "profile_excerpt_evidence" || value === "learned_language_prior" || value === "learned_concept_prior" || value === "learned_program_prior" || value === "unknown_prior") return value;
  if (value === "typed_source_observation") return DIRECT_FORCE;
  return evidenceSpanId ? DIRECT_FORCE : UNKNOWN_FORCE;
}

function proofForceClassFromBoundary(value: string | undefined): ProofForceClass | undefined {
  if (value === "direct_evidence" || value === "profile_excerpt_evidence" || value === "learned_language_prior" || value === "learned_concept_prior" || value === "learned_program_prior" || value === "unknown_prior") return value;
  if (value === "unclassified_exact_evidence") return DIRECT_FORCE;
  return undefined;
}

function firstCodeObjectId(observation: CodeObservation): string {
  const symbolGraph = objectRecord(observation.symbolGraph);
  const symbols = symbolGraph?.symbols;
  if (Array.isArray(symbols)) {
    const first = symbols.find(item => typeof item === "string");
    if (typeof first === "string" && first) return first;
  }
  return observation.repoId ?? observation.filePath;
}

function isObservation(value: unknown): value is SupportedProofObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const kind = (value as Observation).kind;
  return kind === "measurement" || kind === "log_event" || kind === "code";
}

function objectRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : undefined;
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length) return value;
  }
  return undefined;
}

function firstNumber(...values: readonly unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}
