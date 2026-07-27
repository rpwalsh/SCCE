import type { Observation } from "./ingestion-lanes.js";
import { createHasher, toJsonValue } from "./primitives.js";
import type { EvidenceId, Hasher, JsonValue, SourceId, SourceVersionId } from "./types.js";
import {
  canonicalNormalizationContract,
  normalizeCanonicalSurface,
  type NormalizationContract
} from "./normalization-contract.js";
import { createCanonicalIdentity } from "./canonical-identity.js";
import {
  admitStructuredTemporalCoordinates,
  canonicalTemporalCoordinates,
  type CanonicalTemporalCoordinates,
  type StructuredTemporalAuthority
} from "./canonical-temporal.js";

export const STRUCTURED_SEMANTIC_CANDIDATE_SCHEMA = "scce.semantic_candidate.v2" as const;

export type SemanticCandidateChannel =
  | "source_declared_structured"
  | "anchor_derived"
  | "cross_document_induced"
  | "weak_free_surface";

export type SemanticCandidateAdmissionState =
  | "proposed"
  | "quarantined"
  | "promoted"
  | "rejected";

export type StructuredSemanticCandidateKind =
  | "link"
  | "redirect"
  | "heading"
  | "table_cell"
  | "number"
  | "date"
  | "citation"
  | "repeated_reference"
  | "code_structure"
  | "repository_structure"
  | "interaction_outcome"
  | "state_marker"
  | "source_event"
  | "opaque_induced_relation";

export interface SemanticCandidateProvenance {
  exactEvidenceIds: EvidenceId[];
  extractionChannel: SemanticCandidateChannel;
  anchors: JsonValue[];
  assumptions: JsonValue[];
  transformations: JsonValue[];
  alternativeInterpretations: JsonValue[];
  sourceIndependence: {
    independentSourceCount: number;
    dependencyGroupIds: string[];
    estimate: number;
  };
  producer: {
    modelId: string;
    snapshotId: string;
  };
  admissionState: SemanticCandidateAdmissionState;
  normalizationContractId: string;
  participantIdentityIds: string[];
}

export interface StructuredSemanticCandidate {
  schema: typeof STRUCTURED_SEMANTIC_CANDIDATE_SCHEMA;
  id: string;
  kind: StructuredSemanticCandidateKind;
  channel: SemanticCandidateChannel;
  relationSeedId: string;
  sourceId: SourceId;
  sourceVersionId: SourceVersionId;
  participants: Array<{
    portId: string;
    value: JsonValue;
    valueKind: string;
    realization: "observed" | "omitted";
  }>;
  qualifiers: JsonValue;
  evidenceIds: EvidenceId[];
  temporalCoordinates: CanonicalTemporalCoordinates;
  support: number;
  provenance: SemanticCandidateProvenance;
}

export function structuredSemanticCandidates(input: {
  sourceId: SourceId;
  sourceVersionId: SourceVersionId;
  metadata: JsonValue;
  observations: readonly Observation[];
  evidenceIds: readonly EvidenceId[];
  observedAt: number;
  producerModelId?: string;
  producerSnapshotId?: string;
  sourceDependencyGroupIds?: readonly string[];
  normalizationContract?: NormalizationContract;
  hasher?: Hasher;
}): StructuredSemanticCandidate[] {
  const hasher = input.hasher ?? createHasher();
  const normalizationContract = input.normalizationContract
    ?? canonicalNormalizationContract(hasher);
  const out = new Map<string, StructuredSemanticCandidate>();
  const add = (
    kind: StructuredSemanticCandidateKind,
    participants: Array<{ value: JsonValue; valueKind: string }>,
    evidenceIds: readonly EvidenceId[],
    support: number,
    qualifiers: JsonValue = {},
    channel: SemanticCandidateChannel = channelForKind(kind),
    provenanceInput: {
      anchors?: JsonValue[];
      assumptions?: JsonValue[];
      transformations?: JsonValue[];
      alternativeInterpretations?: JsonValue[];
    } = {}
  ) => {
    if (participants.length === 0 && kind !== "state_marker" && kind !== "source_event") {
      return;
    }
    const occurrenceMaterialHash = hasher.digestHex(JSON.stringify([
      input.sourceVersionId,
      [...new Set(evidenceIds)].map(String).sort(),
      channel,
      channel === "source_declared_structured" || channel === "anchor_derived"
        ? kind
        : "opaque",
      participants.map(participant => [jsonType(participant.value), participant.value]),
      qualifiers
    ]));
    const relationSeedId = relationSeedFor({
      kind,
      channel,
      participants,
      qualifiers,
      hasher
    });
    const canonical = {
      kind,
      channel,
      sourceId: input.sourceId,
      sourceVersionId: input.sourceVersionId,
      participants: participants.map((participant, index) => ({
        portId: portOccurrenceId({
          sourceVersionId: input.sourceVersionId,
          evidenceIds,
          channel,
          kind,
          participant,
          index,
          occurrenceMaterialHash,
          hasher
        }),
        ...participant,
        realization: participant.value === null ? "omitted" as const : "observed" as const
      })),
      qualifiers,
      evidenceIds: [...new Set(evidenceIds)].sort(),
      temporalCoordinates: temporalCoordinatesForCandidate({
        metadata: input.metadata,
        observedAt: input.observedAt,
        kind,
        participants
      }),
      support
    };
    const participantIdentityIds = participants.map((participant, index) =>
      participantIdentity({
        participant,
        index,
        evidenceIds,
        normalizationContract,
        hasher
      }));
    const id = createCanonicalIdentity({
        kind: "relation_hypothesis",
        fields: {
        relationSeedId,
        participantIncidences: canonical.participants.map((participant, index) => ({
          portId: participant.portId,
          identityId: participantIdentityIds[index]!,
          valueKind: participant.valueKind,
          realization: participant.realization
        })),
        qualifierHash: hasher.digestHex(JSON.stringify(qualifiers)),
        temporalHash: hasher.digestHex(JSON.stringify(canonical.temporalCoordinates)),
        evidenceIds: [...new Set(evidenceIds)].map(String).sort()
      },
      normalizationContract,
      hasher
    }).id;
    out.set(id, {
      schema: STRUCTURED_SEMANTIC_CANDIDATE_SCHEMA,
      id,
      relationSeedId,
      ...canonical,
      provenance: {
        exactEvidenceIds: [...new Set(evidenceIds)].sort(),
        extractionChannel: channel,
        anchors: [...(provenanceInput.anchors ?? [])],
        assumptions: [...(provenanceInput.assumptions ?? [])],
        transformations: [...(provenanceInput.transformations ?? [])],
        alternativeInterpretations: [...(provenanceInput.alternativeInterpretations ?? [])],
        sourceIndependence: {
          independentSourceCount: 1,
          dependencyGroupIds: [...new Set(
            input.sourceDependencyGroupIds?.map(String) ?? [String(input.sourceId)]
          )].sort(),
          estimate: 1
        },
        producer: {
          modelId: input.producerModelId ?? "kernel.semantic_candidate.channel_compiler.v2",
          snapshotId: input.producerSnapshotId
            ?? `candidate_snapshot.${hasher.digestHex(JSON.stringify([
              input.sourceVersionId,
              normalizationContract.id
            ])).slice(0, 32)}`
        },
        admissionState: "proposed",
        normalizationContractId: normalizationContract.id,
        participantIdentityIds
      }
    });
  };

  for (const observation of input.observations) {
    const evidenceIds = observation.evidenceIds.length
      ? observation.evidenceIds
      : [...input.evidenceIds];
    if (observation.kind === "document_structure" && observation.structureKind === "heading") {
      add("heading", [
        { value: observation.id, valueKind: "document_structure" },
        { value: observation.title ?? observation.textPreview ?? "", valueKind: "surface" }
      ], evidenceIds, observation.confidence, { ordinal: observation.ordinal ?? null });
    } else if (observation.kind === "cell") {
      add("table_cell", [
        { value: observation.tableId, valueKind: "table" },
        { value: observation.header ?? observation.column, valueKind: "column" },
        { value: observation.rawValue, valueKind: "value" }
      ], evidenceIds, observation.confidence, {
        row: observation.row,
        column: observation.column,
        address: observation.address ?? null
      });
      if (typeof observation.rawValue === "number") {
        add("number", [
          { value: observation.rawValue, valueKind: "number" },
          { value: observation.header ?? observation.column, valueKind: "measure_context" }
        ], evidenceIds, observation.confidence);
      }
      if (looksDate(observation.displayValue)) {
        add("date", [
          { value: observation.displayValue, valueKind: "date_surface" },
          { value: observation.header ?? observation.column, valueKind: "time_context" }
        ], evidenceIds, observation.confidence);
      }
    } else if (observation.kind === "measurement") {
      add("number", [
        { value: observation.value, valueKind: "number" },
        ...(observation.unit ? [{ value: observation.unit as JsonValue, valueKind: "unit" }] : [])
      ], evidenceIds, observation.confidence, {
        timestamp: observation.timestamp ?? null,
        sensor: observation.sensor ?? null
      });
    } else if (observation.kind === "formula") {
      add("code_structure", [
        { value: observation.cellAddress, valueKind: "formula" },
        ...observation.dependencies.map(value => ({ value, valueKind: "dependency" }))
      ], evidenceIds, observation.confidence);
    } else if (observation.kind === "code") {
      add(observation.repoId ? "repository_structure" : "code_structure", [
        ...(observation.repoId ? [{ value: observation.repoId as JsonValue, valueKind: "repository" }] : []),
        { value: observation.filePath, valueKind: "file" },
        { value: observation.id, valueKind: "program_graph_ref" }
      ], evidenceIds, observation.confidence);
    } else if (observation.kind === "log_event" && observation.timestamp) {
      add("interaction_outcome", [
        { value: observation.streamId, valueKind: "interaction_stream" },
        { value: observation.message, valueKind: "outcome" },
        { value: observation.timestamp, valueKind: "date_surface" }
      ], evidenceIds, observation.confidence, {
        sequence: observation.sequence,
        severity: observation.severity ?? null
      });
    }
  }

  const metadata = record(input.metadata);
  const structure = record(metadata.structure);
  const typed = record(metadata.typedExtraction);
  for (const marker of records(metadata.stateMarkers)) {
    const declaredMarker = marker.marker ?? marker.state ?? marker.id;
    if (declaredMarker === undefined || declaredMarker === null || declaredMarker === "") continue;
    add(
      "state_marker",
      [],
      input.evidenceIds,
      numericSupport(marker.support, 0.8),
      toJsonValue({
        marker: declaredMarker,
        sourceScope: marker.scope ?? "document"
      }),
      "source_declared_structured",
      { anchors: [toJsonValue(marker)] }
    );
  }
  for (const event of records(metadata.sourceEvents)) {
    const declaredEvent = event.event ?? event.kind ?? event.id;
    if (declaredEvent === undefined || declaredEvent === null || declaredEvent === "") continue;
    add(
      "source_event",
      [],
      input.evidenceIds,
      numericSupport(event.support, 0.8),
      toJsonValue({
        event: declaredEvent,
        sourceScope: event.scope ?? "source"
      }),
      "source_declared_structured",
      { anchors: [toJsonValue(event)] }
    );
  }
  for (const relation of records(metadata.crossDocumentRelations)) {
    add(
      "opaque_induced_relation",
      opaqueParticipants(relation.participants),
      input.evidenceIds,
      numericSupport(relation.support, 0.5),
      toJsonValue({ observableStructure: relation.structure ?? null }),
      "cross_document_induced",
      {
        anchors: records(relation.anchors).map(toJsonValue),
        assumptions: records(relation.assumptions).map(toJsonValue),
        transformations: records(relation.transformations).map(toJsonValue),
        alternativeInterpretations: records(relation.alternatives).map(toJsonValue)
      }
    );
  }
  for (const relation of records(metadata.weakFreeSurfaceRelations)) {
    add(
      "opaque_induced_relation",
      opaqueParticipants(relation.participants),
      input.evidenceIds,
      numericSupport(relation.support, 0.25),
      toJsonValue({ observableStructure: relation.structure ?? null }),
      "weak_free_surface",
      {
        anchors: records(relation.anchors).map(toJsonValue),
        assumptions: records(relation.assumptions).map(toJsonValue),
        transformations: records(relation.transformations).map(toJsonValue),
        alternativeInterpretations: records(relation.alternatives).map(toJsonValue)
      }
    );
  }
  const links = [
    ...records(metadata.links),
    ...records(structure.links),
    ...records(typed.links)
  ];
  for (const link of links) {
    const target = text(link.target ?? link.href ?? link.uri);
    const label = text(link.label ?? link.text ?? link.title);
    if (!target) continue;
    add("link", [
      { value: label, valueKind: "anchor_surface" },
      { value: target, valueKind: "target_ref" }
    ], input.evidenceIds, 0.82);
  }
  const redirects = records(metadata.redirects);
  const redirectTarget = text(metadata.redirectTarget ?? metadata.redirect);
  if (redirectTarget) redirects.push({ target: redirectTarget });
  for (const redirect of redirects) {
    const target = text(redirect.target ?? redirect.uri ?? redirect.title);
    if (target) add("redirect", [
      { value: text(redirect.source ?? metadata.title), valueKind: "source_ref" },
      { value: target, valueKind: "target_ref" }
    ], input.evidenceIds, 0.9);
  }
  for (const citation of [
    ...records(metadata.citations),
    ...records(structure.references),
    ...records(structure.footnotes)
  ]) {
    add("citation", [
      { value: text(citation.id ?? citation.label ?? citation.text), valueKind: "citation" },
      { value: text(citation.uri ?? citation.target ?? citation.doi), valueKind: "target_ref" }
    ].filter(participant => participant.value !== ""), input.evidenceIds, 0.86);
  }
  for (const outcome of [
    ...records(metadata.interactionOutcomes),
    ...records(metadata.toolResults),
    ...records(metadata.actionReceipts)
  ]) {
    add("interaction_outcome", [
      { value: text(outcome.action ?? outcome.tool ?? outcome.id), valueKind: "action" },
      { value: outcome.result ?? outcome.outcome ?? outcome.status ?? null, valueKind: "outcome" }
    ], input.evidenceIds, 0.88);
  }
  const targetCounts = new Map<string, number>();
  for (const link of links) {
    const target = text(link.target ?? link.href ?? link.uri);
    if (target) targetCounts.set(target, (targetCounts.get(target) ?? 0) + 1);
  }
  for (const [target, count] of targetCounts) {
    if (count < 2) continue;
    add("repeated_reference", [
      { value: target, valueKind: "target_ref" },
      { value: count, valueKind: "count" }
    ], input.evidenceIds, Math.min(1, 0.5 + Math.log2(count + 1) / 10));
  }
  return [...out.values()].sort((left, right) =>
    right.support - left.support || left.id.localeCompare(right.id));
}

export function semanticCandidatesByChannel(
  input: Parameters<typeof structuredSemanticCandidates>[0]
): Record<SemanticCandidateChannel, StructuredSemanticCandidate[]> {
  const grouped: Record<SemanticCandidateChannel, StructuredSemanticCandidate[]> = {
    source_declared_structured: [],
    anchor_derived: [],
    cross_document_induced: [],
    weak_free_surface: []
  };
  for (const candidate of structuredSemanticCandidates(input)) {
    grouped[candidate.channel].push(candidate);
  }
  return grouped;
}

function participantIdentity(input: {
  participant: { value: JsonValue; valueKind: string };
  index: number;
  evidenceIds: readonly EvidenceId[];
  normalizationContract: NormalizationContract;
  hasher: Hasher;
}): string {
  if (typeof input.participant.value === "string") {
    return createCanonicalIdentity({
      kind: "normalized_surface_form",
      fields: {
        normalizationContractId: input.normalizationContract.id,
        normalizedSurface: normalizeCanonicalSurface(
          input.participant.value,
          input.normalizationContract
        )
      },
      normalizationContract: input.normalizationContract,
      hasher: input.hasher
    }).id;
  }
  return createCanonicalIdentity({
    kind: "unresolved_entity",
    fields: {
      mentionIds: [
        `mention_material.${input.hasher.digestHex(JSON.stringify([
          input.participant.valueKind,
          input.index,
          input.participant.value
        ])).slice(0, 40)}`
      ],
      evidenceIds: input.evidenceIds.map(String)
    },
    normalizationContract: input.normalizationContract,
    hasher: input.hasher
  }).id;
}

function finiteMetadataTime(metadata: JsonValue, key: string): number | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function temporalCoordinatesForCandidate(input: {
  metadata: JsonValue;
  observedAt: number;
  kind: StructuredSemanticCandidateKind;
  participants: Array<{ value: JsonValue; valueKind: string }>;
}): CanonicalTemporalCoordinates {
  const authority = structuredTemporalAuthority(input.metadata);
  if (authority) {
    return admitStructuredTemporalCoordinates({
      observedTime: input.observedAt,
      structured: authority,
      provenance: { extraction: "typed_source_metadata" }
    });
  }
  return canonicalTemporalCoordinates({
    observedTime: input.observedAt,
    sourceTime: finiteMetadataTime(input.metadata, "sourceTime"),
    eventSurfaceMention: input.kind === "date"
      ? toJsonValue(input.participants.map(participant => participant.value))
      : null,
    provenance: {
      temporalStatus: "unknown",
      eventTimeParsed: false,
      validityInferredFromObservedTime: false
    }
  });
}

function structuredTemporalAuthority(metadata: JsonValue): StructuredTemporalAuthority | undefined {
  const root = record(metadata);
  const temporal = record(root.structuredTemporal ?? root.temporal);
  if (temporal.authority !== "source_declared") return undefined;
  const sourceType = temporal.sourceType;
  if (sourceType !== "database"
    && sourceType !== "structured_document"
    && sourceType !== "schema_validated") return undefined;
  const schemaId = text(temporal.schemaId);
  const validFrom = temporal.validFrom;
  const validTo = temporal.validTo;
  if (!schemaId || typeof validFrom !== "number" || !Number.isFinite(validFrom)) return undefined;
  if (validTo !== undefined && (typeof validTo !== "number" || !Number.isFinite(validTo))) {
    return undefined;
  }
  return {
    authority: "source_declared",
    sourceType,
    schemaId,
    validFrom,
    ...(typeof validTo === "number" ? { validTo } : {}),
    ...(typeof temporal.eventTime === "number" && Number.isFinite(temporal.eventTime)
      ? { eventTime: temporal.eventTime }
      : {}),
    ...(typeof temporal.sourceTime === "number" && Number.isFinite(temporal.sourceTime)
      ? { sourceTime: temporal.sourceTime }
      : {})
  };
}

function record(value: unknown): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}

function records(value: unknown): Array<Record<string, JsonValue>> {
  return Array.isArray(value) ? value.map(record).filter(row => Object.keys(row).length) : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function looksDate(value: string): boolean {
  return /^\p{Number}{4}[-/.]\p{Number}{1,2}[-/.]\p{Number}{1,2}(?:[T\s].*)?$/u.test(value.trim());
}

function channelForKind(kind: StructuredSemanticCandidateKind): SemanticCandidateChannel {
  if (kind === "repeated_reference") return "cross_document_induced";
  if (kind === "link"
    || kind === "redirect"
    || kind === "heading"
    || kind === "citation") {
    return "anchor_derived";
  }
  if (kind === "opaque_induced_relation") return "weak_free_surface";
  return "source_declared_structured";
}

function portOccurrenceId(input: {
  sourceVersionId: SourceVersionId;
  evidenceIds: readonly EvidenceId[];
  channel: SemanticCandidateChannel;
  kind: StructuredSemanticCandidateKind;
  participant: { value: JsonValue; valueKind: string };
  index: number;
  occurrenceMaterialHash: string;
  hasher: Hasher;
}): string {
  return `port.${input.hasher.digestHex(JSON.stringify([
    input.sourceVersionId,
    [...new Set(input.evidenceIds)].map(String).sort(),
    input.channel,
    input.channel === "source_declared_structured" || input.channel === "anchor_derived"
      ? input.kind
      : "opaque",
    input.index,
    jsonType(input.participant.value),
    input.occurrenceMaterialHash
  ])).slice(0, 32)}`;
}

function relationSeedFor(input: {
  kind: StructuredSemanticCandidateKind;
  channel: SemanticCandidateChannel;
  participants: readonly { value: JsonValue; valueKind: string }[];
  qualifiers: JsonValue;
  hasher: Hasher;
}): string {
  if (input.channel === "source_declared_structured"
    || input.channel === "anchor_derived") {
    return `relation_seed.declared.${input.hasher.digestHex(JSON.stringify([
      input.channel,
      input.kind
    ])).slice(0, 24)}`;
  }
  const observableSignature = {
    channel: input.channel,
    arity: input.participants.length,
    participantTypes: input.participants.map(participant => jsonType(participant.value)),
    qualifierShape: jsonType(input.qualifiers)
  };
  return `relation_seed.opaque.${input.hasher.digestHex(JSON.stringify(observableSignature)).slice(0, 24)}`;
}

function opaqueParticipants(value: JsonValue | undefined): Array<{
  value: JsonValue;
  valueKind: string;
}> {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    const row = record(item);
    const participantValue = Object.hasOwn(row, "value") ? row.value! : item;
    return {
      value: participantValue,
      valueKind: `observable.${jsonType(participantValue)}`
    };
  });
}

function jsonType(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function numericSupport(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback;
}
