import type { BoundarySufficientStatistics } from "./boundary-estimator.js";
import {
  assertCanonicalIdentityAudit,
  createCanonicalIdentity
} from "./canonical-identity.js";
import {
  canonicalNormalizationContract,
  type NormalizationContract
} from "./normalization-contract.js";
import { canonicalStringify, createHasher, toJsonValue } from "./primitives.js";
import type { StructuredSemanticCandidate } from "./structured-semantic-candidate.js";
import type { SurfaceLattice } from "./surface-lattice.js";
import type {
  GraphEdge,
  GraphNode,
  Hasher,
  Hyperedge,
  JsonValue
} from "./types.js";

export const CANONICAL_REPLAY_MANIFEST_SCHEMA = "scce.canonical_replay_manifest.v2" as const;

export interface CanonicalReplayManifest {
  schema: typeof CANONICAL_REPLAY_MANIFEST_SCHEMA;
  id: string;
  byteHash: string;
  canonicalBytes: string;
  corpusManifestId: string;
  codeCommit: string;
  normalizationContract: NormalizationContract;
  configurationHash: string;
  randomSeed: string;
  surfaceLatticeIds: string[];
  segmentationForestIds: string[];
  boundaryStatisticsIds: string[];
  candidateIds: string[];
  admittedGraphHash: string;
  snapshotIdentityId: string;
  audit: JsonValue;
}

export function compileCanonicalReplayManifest(input: {
  corpusManifestId: string;
  codeCommit: string;
  configuration: JsonValue;
  randomSeed: string;
  surfaceLattices: readonly SurfaceLattice[];
  boundaryStatistics: readonly BoundarySufficientStatistics[];
  candidates: readonly StructuredSemanticCandidate[];
  admittedGraph: {
    nodes: readonly GraphNode[];
    edges: readonly GraphEdge[];
    hyperedges: readonly Hyperedge[];
  };
  normalizationContract?: NormalizationContract;
  hasher?: Hasher;
}): CanonicalReplayManifest {
  const hasher = input.hasher ?? createHasher();
  const normalizationContract = input.normalizationContract
    ?? canonicalNormalizationContract(hasher);
  assertCanonicalIdentityAudit(input.surfaceLattices.flatMap(lattice =>
    lattice.units.flatMap(unit => [
      { identity: unit.canonicalIdentities.occurrence, recordId: unit.id },
      { identity: unit.canonicalIdentities.normalizedForm, recordId: unit.id },
      { identity: unit.canonicalIdentities.surfaceFormClass, recordId: unit.id }
    ])), hasher);
  const configurationHash = hasher.digestHex(canonicalStringify(input.configuration));
  const admittedGraph = canonicalAdmittedGraph(input.admittedGraph);
  const admittedGraphHash = hasher.digestHex(canonicalStringify(admittedGraph));
  const surfaceLatticeIds = input.surfaceLattices.map(row => row.id).sort();
  const segmentationForestIds = input.surfaceLattices
    .map(row => row.segmentationForest.id)
    .sort();
  const boundaryStatisticsIds = input.boundaryStatistics.map(row => row.id).sort();
  const candidateIds = input.candidates.map(row => row.id).sort();
  const componentIds = [
    ...surfaceLatticeIds,
    ...segmentationForestIds,
    ...boundaryStatisticsIds,
    ...candidateIds,
    admittedGraphHash
  ].sort();
  const snapshotIdentity = createCanonicalIdentity({
    kind: "model_snapshot",
    fields: {
      corpusManifestId: input.corpusManifestId,
      codeCommit: input.codeCommit,
      normalizationContractId: normalizationContract.id,
      configurationHash,
      randomSeed: input.randomSeed,
      componentIds
    },
    normalizationContract,
    hasher
  });
  const canonical = {
    schema: CANONICAL_REPLAY_MANIFEST_SCHEMA,
    corpusManifestId: input.corpusManifestId,
    codeCommit: input.codeCommit,
    normalizationContract,
    configurationHash,
    randomSeed: input.randomSeed,
    surfaceLatticeIds,
    segmentationForestIds,
    boundaryStatisticsIds,
    candidateIds,
    admittedGraphHash,
    snapshotIdentityId: snapshotIdentity.id
  };
  const canonicalBytes = canonicalStringify(canonical);
  return {
    ...canonical,
    id: `replay_manifest.${hasher.digestHex(canonicalBytes).slice(0, 48)}`,
    byteHash: hasher.digestHex(canonicalBytes),
    canonicalBytes,
    audit: toJsonValue({
      compiler: "kernel.canonical_replay_manifest.v1",
      canonicalSerialization: "scce.canonicalStringify.v1",
      byteIdenticalForEquivalentOrderedOrShuffledInputs: true,
      componentCount: componentIds.length
    })
  };
}

export function verifyCanonicalReplayManifest(
  manifest: CanonicalReplayManifest,
  hasher: Hasher = createHasher()
): void {
  if (manifest.schema !== CANONICAL_REPLAY_MANIFEST_SCHEMA) {
    throw new Error("unsupported canonical replay manifest schema");
  }
  const byteHash = hasher.digestHex(manifest.canonicalBytes);
  if (byteHash !== manifest.byteHash) throw new Error("canonical replay manifest byte hash mismatch");
  const id = `replay_manifest.${byteHash.slice(0, 48)}`;
  if (id !== manifest.id) throw new Error("canonical replay manifest identity mismatch");
  const decoded = JSON.parse(manifest.canonicalBytes) as Record<string, unknown>;
  if (decoded.snapshotIdentityId !== manifest.snapshotIdentityId
    || decoded.admittedGraphHash !== manifest.admittedGraphHash) {
    throw new Error("canonical replay manifest material mismatch");
  }
}

function canonicalAdmittedGraph(input: {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  hyperedges: readonly Hyperedge[];
}) {
  const nodes = canonicalRecords(input.nodes, "node");
  const edges = canonicalRecords(input.edges, "edge");
  const hyperedges = canonicalRecords(input.hyperedges, "hyperedge");
  const nodeIds = new Set(nodes.map(node => String(node.id)));
  for (const edge of edges) {
    if (!nodeIds.has(String(edge.source)) || !nodeIds.has(String(edge.target))) {
      throw new Error(`edge ${String(edge.id)} references a missing graph node`);
    }
  }
  for (const hyperedge of hyperedges) {
    for (const nodeId of hyperedge.memberNodeIds) {
      if (!nodeIds.has(String(nodeId))) {
        throw new Error(`hyperedge ${String(hyperedge.id)} references missing member ${String(nodeId)}`);
      }
    }
    for (const port of hyperedge.participantPorts) {
      if (port.nodeId !== null && !nodeIds.has(String(port.nodeId))) {
        throw new Error(`hyperedge ${String(hyperedge.id)} references missing port node ${String(port.nodeId)}`);
      }
    }
  }
  return { nodes, edges, hyperedges };
}

function canonicalRecords<T extends { id: unknown }>(
  values: readonly T[],
  kind: string
): T[] {
  const byId = new Map<string, { bytes: string; value: T }>();
  for (const raw of values) {
    const value = canonicalizeGraphRecord(raw) as T;
    const id = String(value.id);
    const bytes = canonicalStringify(value);
    const prior = byId.get(id);
    if (prior && prior.bytes !== bytes) {
      throw new Error(`conflicting duplicate ${kind} identity ${id}`);
    }
    byId.set(id, { bytes, value });
  }
  return [...byId.values()]
    .map(row => row.value)
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function canonicalizeGraphRecord(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) {
    const children = value.map(child => canonicalizeGraphRecord(child));
    return UNORDERED_GRAPH_FIELDS.has(key)
      ? children.sort((left, right) =>
          canonicalStringify(left as JsonValue).localeCompare(canonicalStringify(right as JsonValue)))
      : children;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([childKey, child]) => [childKey, canonicalizeGraphRecord(child, childKey)]));
  }
  return value;
}

const UNORDERED_GRAPH_FIELDS = new Set([
  "evidenceIds",
  "provenanceRefs",
  "features",
  "sourceExampleIds",
  "mentionIds"
]);
