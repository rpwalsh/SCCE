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

export const STRUCTURED_SEMANTIC_CANDIDATE_SCHEMA = "scce.structured_semantic_candidate.v1" as const;

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
  | "interaction_outcome";

export interface StructuredSemanticCandidate {
  schema: typeof STRUCTURED_SEMANTIC_CANDIDATE_SCHEMA;
  id: string;
  kind: StructuredSemanticCandidateKind;
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
  provenance: JsonValue;
}

export function structuredSemanticCandidates(input: {
  sourceId: SourceId;
  sourceVersionId: SourceVersionId;
  metadata: JsonValue;
  observations: readonly Observation[];
  evidenceIds: readonly EvidenceId[];
  observedAt: number;
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
    qualifiers: JsonValue = {}
  ) => {
    if (!participants.length) return;
    const canonical = {
      kind,
      sourceId: input.sourceId,
      sourceVersionId: input.sourceVersionId,
      participants: participants.map((participant, index) => ({
        portId: `port.${hasher.digestHex(`${kind}:${index}`).slice(0, 16)}`,
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
        relationSeedId: `relation_seed.${hasher.digestHex(kind).slice(0, 24)}`,
        participantIncidences: canonical.participants.map((participant, index) => ({
          portId: participant.portId,
          identityId: participantIdentityIds[index]!,
          valueKind: participant.valueKind,
          realization: participant.realization
        })),
        qualifierHash: hasher.digestHex(JSON.stringify(qualifiers)),
        temporalHash: hasher.digestHex(JSON.stringify(canonical.temporalCoordinates)),
        evidenceIds: [...new Set(evidenceIds)].map(String)
      },
      normalizationContract,
      hasher
    }).id;
    out.set(id, {
      schema: STRUCTURED_SEMANTIC_CANDIDATE_SCHEMA,
      id,
      relationSeedId: `relation_seed.${hasher.digestHex(kind).slice(0, 24)}`,
      ...canonical,
      provenance: toJsonValue({
        source: "typed_source_structure",
        observationFirst: true,
        normalizationContractId: normalizationContract.id,
        participantIdentityIds
      })
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
