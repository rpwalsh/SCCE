import type {
  ArtifactId,
  CapabilityCallId,
  ChunkId,
  ClaimId,
  Clock,
  ConstructId,
  ContentHash,
  DimensionId,
  EdgeId,
  EmissionId,
  EpisodeId,
  EventId,
  EvidenceId,
  ForecastEnvelopeId,
  ForecastStateId,
  FileContentId,
  Hasher,
  HyperedgeId,
  NodeId,
  PatternId,
  ProofId,
  RawSpanId,
  RelationId,
  RunId,
  ShapeId,
  SourceId,
  SourceVersionId,
  ArtifactContentId,
  ToolOutputContentId,
  TranscriptVersionId,
  ValidationId
} from "./types.js";
import { canonicalStringify, randomHex } from "./primitives.js";

export interface IdFactory {
  episodeId(): EpisodeId;
  eventId(): EventId;
  runId(): RunId;
  artifactId(payload: unknown): ArtifactId;
  capabilityCallId(payload: unknown): CapabilityCallId;
  forecastStateId(payload: unknown): ForecastStateId;
  forecastEnvelopeId(payload: unknown): ForecastEnvelopeId;
  contentHash(bytes: string | Uint8Array): ContentHash;
  fileContentId(bytes: string | Uint8Array): FileContentId;
  rawSpanId(input: { sourceVersionId: SourceVersionId; byteStart: number; byteEnd: number; spanHash: ContentHash }): RawSpanId;
  artifactContentId(bytes: string | Uint8Array): ArtifactContentId;
  toolOutputContentId(bytes: string | Uint8Array): ToolOutputContentId;
  transcriptVersionId(bytes: string | Uint8Array): TranscriptVersionId;
  sourceId(namespace: string, canonicalUri: string): SourceId;
  sourceVersionId(bytes: string | Uint8Array): SourceVersionId;
  chunkId(input: { sourceVersionId: SourceVersionId; byteStart: number; byteEnd: number; chunkHash: ContentHash }): ChunkId;
  evidenceId(input: { sourceVersionId: SourceVersionId; byteStart: number; byteEnd: number; spanHash: ContentHash }): EvidenceId;
  nodeId(representation: unknown): NodeId;
  edgeId(input: { source: NodeId; relationId: RelationId; target: NodeId; provenanceHash: string }): EdgeId;
  hyperedgeId(input: { relationId: RelationId; members: NodeId[]; provenanceHash: string }): HyperedgeId;
  relationId(representation: unknown): RelationId;
  dimensionId(representation: unknown): DimensionId;
  patternId(representation: unknown): PatternId;
  shapeId(representation: unknown): ShapeId;
  claimId(canonicalProposition: unknown): ClaimId;
  proofId(input: { claimId: ClaimId; evidenceIds: EvidenceId[]; transforms: string[]; validatorVersion: string }): ProofId;
  constructId(input: unknown): ConstructId;
  validationId(input: unknown): ValidationId;
  emissionId(input: unknown): EmissionId;
  semanticId(prefix: string, representation: unknown): string;
}

export function createIdFactory(options: {
  clock: Clock;
  hasher: Hasher;
  namespace?: string;
  runSeed?: string;
  deterministicReplay?: boolean;
}): IdFactory {
  const namespace = options.namespace ?? "scce-v3";
  const runSeed = options.runSeed ?? (options.deterministicReplay ? "replay" : randomHex(6));
  let replaySequence = 0;

  const digest = (prefix: string, payload: unknown) =>
    `${prefix}_${options.hasher.digestHex(`${namespace}\u001f${prefix}\u001f${canonicalStringify(payload)}`).slice(0, 48)}`;

  const eventLike = (prefix: string) => {
    const t = Math.max(0, Math.floor(options.clock.now()));
    const sortable = t.toString(36).padStart(10, "0");
    const suffix = options.deterministicReplay
      ? `${runSeed}_${(replaySequence++).toString(36).padStart(6, "0")}`
      : `${runSeed}_${randomHex(5)}`;
    return `${prefix}_${sortable}_${suffix}`;
  };

  return {
    episodeId: () => eventLike("episode") as EpisodeId,
    eventId: () => eventLike("event") as EventId,
    runId: () => eventLike("run") as RunId,
    artifactId: payload => digest("artifact", payload) as ArtifactId,
    capabilityCallId: payload => digest("capability_call", payload) as CapabilityCallId,
    forecastStateId: payload => digest("forecast_state", payload) as ForecastStateId,
    forecastEnvelopeId: payload => digest("forecast_envelope", payload) as ForecastEnvelopeId,
    contentHash: bytes => `sha256_${options.hasher.digestHex(bytes)}` as ContentHash,
    fileContentId: bytes => `file_content_${options.hasher.digestHex(bytes).slice(0, 56)}` as FileContentId,
    rawSpanId: input => digest("raw_span", input) as RawSpanId,
    artifactContentId: bytes => `artifact_content_${options.hasher.digestHex(bytes).slice(0, 56)}` as ArtifactContentId,
    toolOutputContentId: bytes => `tool_output_${options.hasher.digestHex(bytes).slice(0, 56)}` as ToolOutputContentId,
    transcriptVersionId: bytes => `transcript_version_${options.hasher.digestHex(bytes).slice(0, 56)}` as TranscriptVersionId,
    sourceId: (sourceNamespace, canonicalUri) =>
      digest("source", { namespace: sourceNamespace, canonicalUri: canonicalUri.trim().replace(/\\/g, "/") }) as SourceId,
    sourceVersionId: bytes => `source_version_${options.hasher.digestHex(bytes).slice(0, 56)}` as SourceVersionId,
    chunkId: input => digest("chunk", input) as ChunkId,
    evidenceId: input => digest("evidence", input) as EvidenceId,
    nodeId: representation => digest("node", representation) as NodeId,
    edgeId: input => digest("edge", input) as EdgeId,
    hyperedgeId: input => digest("hyperedge", input) as HyperedgeId,
    relationId: representation => digest("relation", representation) as RelationId,
    dimensionId: representation => digest("dimension", representation) as DimensionId,
    patternId: representation => digest("pattern", representation) as PatternId,
    shapeId: representation => digest("shape", representation) as ShapeId,
    claimId: canonicalProposition => digest("claim", canonicalProposition) as ClaimId,
    proofId: input => digest("proof", input) as ProofId,
    constructId: input => digest("construct", input) as ConstructId,
    validationId: input => digest("validation", input) as ValidationId,
    emissionId: input => digest("emission", input) as EmissionId,
    semanticId: (prefix, representation) => digest(prefix, representation)
  };
}
