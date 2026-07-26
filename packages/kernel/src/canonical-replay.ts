import type { BoundarySufficientStatistics } from "./boundary-estimator.js";
import { createCanonicalIdentity } from "./canonical-identity.js";
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

export const CANONICAL_REPLAY_MANIFEST_SCHEMA = "scce.canonical_replay_manifest.v1" as const;

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
  const configurationHash = hasher.digestHex(canonicalStringify(input.configuration));
  const admittedGraph = {
    nodes: sortRecords(input.admittedGraph.nodes),
    edges: sortRecords(input.admittedGraph.edges),
    hyperedges: sortRecords(input.admittedGraph.hyperedges)
  };
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

function sortRecords<T extends { id: unknown }>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => String(left.id).localeCompare(String(right.id)));
}
