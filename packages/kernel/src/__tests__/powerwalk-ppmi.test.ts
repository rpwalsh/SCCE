import { describe, expect, it } from "vitest";
import { createIdFactory } from "../ids.js";
import {
  POWERWALK_COOCCURRENCE_VERSION,
  POWERWALK_REPRESENTATION_VERSION,
  fitSparsePpmiRepresentation,
  splitCooccurrenceForValidation,
  type PowerWalkCooccurrenceRow
} from "../powerwalk.js";
import { cosineSimilarity, createClock, createHasher, stableVector } from "../primitives.js";
import type { NodeId } from "../types.js";

describe("PowerWalk learned sparse PPMI representation", () => {
  const hasher = createHasher();
  const ids = createIdFactory({
    clock: createClock({ fixedTime: 4_000, stepMs: 1 }),
    hasher,
    deterministicReplay: true,
    namespace: "powerwalk-ppmi"
  });

  it("separates held-out structural twins from lexical feature hashing", () => {
    const roles = ["opaque-7", "opaque-19", "opaque-31", "opaque-43"].map(label => ids.nodeId(label));
    const contexts = ["context-5", "context-11", "context-23", "context-47"].map(label => ids.nodeId(label));
    const training = [
      observation(roles[0]!, contexts[0]!), observation(roles[0]!, contexts[1]!),
      observation(roles[1]!, contexts[0]!), observation(roles[1]!, contexts[1]!),
      observation(roles[2]!, contexts[2]!), observation(roles[2]!, contexts[3]!),
      observation(roles[3]!, contexts[2]!), observation(roles[3]!, contexts[3]!)
    ];
    const learned = fitSparsePpmiRepresentation([...roles, ...contexts], training, {
      hasher,
      dimensions: 32,
      projectionSeed: "held-out-structure",
      validation: [observation(roles[0]!, roles[1]!), observation(roles[2]!, roles[3]!)]
    });
    const learnedVectors = new Map(learned.embeddings.map(row => [row.nodeId, row.vector]));
    const lexicalVectors = new Map(roles.map((nodeId, index) => [nodeId, stableVector([`opaque-${[7, 19, 31, 43][index]}`], hasher, 32)]));
    const expectedTwin = new Map<NodeId, NodeId>([
      [roles[0]!, roles[1]!], [roles[1]!, roles[0]!],
      [roles[2]!, roles[3]!], [roles[3]!, roles[2]!]
    ]);

    // Twin-to-twin links are never present in training. Retrieval therefore
    // tests held-out structural equivalence, not reconstruction of a seen pair.
    const learnedAccuracy = nearestTwinAccuracy(roles, learnedVectors, expectedTwin);
    const lexicalHashAccuracy = nearestTwinAccuracy(roles, lexicalVectors, expectedTwin);

    expect(learnedAccuracy).toBe(1);
    expect(learnedAccuracy).toBeGreaterThan(lexicalHashAccuracy);
    expect(learned.diagnostics.method).toBe("positive_pointwise_mutual_information_with_seeded_sparse_projection");
    expect(learned.diagnostics.version).toBe(POWERWALK_REPRESENTATION_VERSION);
    expect(learned.diagnostics.validationInterpretation).toBe("held_out_pair_similarity_vs_hash_baseline");
    expect(learned.diagnostics.validationLearnedVsHashMargin).toBeGreaterThan(0);
    expect(learned.diagnostics.dataHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(learned.diagnostics.modelHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rebuilds the same representation from versioned incremental sufficient statistics", () => {
    const nodes = ["incremental-a", "incremental-b", "incremental-c"].map(label => ids.nodeId(label));
    const first = [observation(nodes[0]!, nodes[1]!, 7), observation(nodes[1]!, nodes[0]!, 7)];
    const second = [observation(nodes[0]!, nodes[2]!, 5), observation(nodes[2]!, nodes[0]!, 5)];
    const initial = fitSparsePpmiRepresentation(nodes, first, { hasher, projectionSeed: "incremental", dimensions: 24 });
    const incremental = fitSparsePpmiRepresentation(nodes, second, {
      hasher,
      projectionSeed: "incremental",
      dimensions: 24,
      priorState: initial.state
    });
    const batch = fitSparsePpmiRepresentation(nodes, [...first, ...second], {
      hasher,
      projectionSeed: "incremental",
      dimensions: 24
    });

    expect(initial.state.version).toBe(POWERWALK_COOCCURRENCE_VERSION);
    expect(incremental.state.entries).toEqual(batch.state.entries);
    expect(incremental.state.totalCount).toEqual(batch.state.totalCount);
    expect(incremental.embeddings).toEqual(batch.embeddings);
    expect(incremental.diagnostics.dataHash).toBe(batch.diagnostics.dataHash);
    expect(incremental.diagnostics.modelHash).toBe(batch.diagnostics.modelHash);
    expect(incremental.diagnostics.priorEvents).toBe(14);
    expect(incremental.diagnostics.trainEvents).toBe(10);

    const replay = fitSparsePpmiRepresentation(nodes, first, {
      hasher,
      projectionSeed: "incremental",
      dimensions: 24,
      priorState: initial.state
    });
    expect(replay.state).toEqual(initial.state);
    expect(replay.embeddings).toEqual(initial.embeddings);
    expect(replay.diagnostics.trainEvents).toBe(0);
  });

  it("uses a seeded deterministic pair-disjoint partition for train/validation", () => {
    const source = ids.nodeId("split-source");
    const targets = Array.from({ length: 32 }, (_, index) => ids.nodeId(`split-${index}`));
    const rows = targets.map(target => observation(source, target, 11));
    const first = splitCooccurrenceForValidation(rows, { hasher, seed: "split-seed", validationFraction: 0.25 });
    const replay = splitCooccurrenceForValidation(rows, { hasher, seed: "split-seed", validationFraction: 0.25 });

    expect(replay).toEqual(first);
    expect(first.training.length).toBeGreaterThan(0);
    expect(first.validation.length).toBeGreaterThan(0);
    const trainingPairs = new Set(first.training.map(row => `${row.nodeId}:${row.contextNodeId}`));
    expect(first.validation.every(row => !trainingPairs.has(`${row.nodeId}:${row.contextNodeId}`))).toBe(true);
    expect([...first.training, ...first.validation].reduce((sum, row) => sum + row.count, 0)).toBe(352);
    expect(first.partition).toEqual(replay.partition);
    expect(first.partition.policyHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.partition.splitHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("resets incompatible incremental state when the validation partition changes", () => {
    const source = ids.nodeId("partition-reset-source");
    const targets = Array.from({ length: 48 }, (_, index) => ids.nodeId(`partition-reset-${index}`));
    const nodes = [source, ...targets];
    const rows = targets.map(target => observation(source, target, 3));
    const firstSplit = splitCooccurrenceForValidation(rows, { hasher, seed: "partition-reset", validationFraction: 0.1 });
    const changedSplit = splitCooccurrenceForValidation(rows, { hasher, seed: "partition-reset", validationFraction: 0.4 });
    const initial = fitSparsePpmiRepresentation(nodes, firstSplit.training, {
      hasher,
      partition: firstSplit.partition,
      validation: firstSplit.validation,
      snapshotId: firstSplit.partition.splitHash
    });
    const reset = fitSparsePpmiRepresentation(nodes, changedSplit.training, {
      hasher,
      partition: changedSplit.partition,
      validation: changedSplit.validation,
      priorState: initial.state,
      partitionMismatch: "reset",
      snapshotId: changedSplit.partition.splitHash
    });
    const fresh = fitSparsePpmiRepresentation(nodes, changedSplit.training, {
      hasher,
      partition: changedSplit.partition,
      validation: changedSplit.validation,
      snapshotId: changedSplit.partition.splitHash
    });

    expect(changedSplit.partition.policyHash).not.toBe(firstSplit.partition.policyHash);
    expect(reset.diagnostics.priorStateDisposition).toBe("reset_partition_mismatch");
    expect(reset.diagnostics.priorEvents).toBe(0);
    expect(reset.state).toEqual(fresh.state);
    expect(reset.embeddings).toEqual(fresh.embeddings);
    expect(reset.diagnostics.modelHash).toBe(fresh.diagnostics.modelHash);
    expect(reset.diagnostics.modelHash).not.toBe(initial.diagnostics.modelHash);
    expect(() => fitSparsePpmiRepresentation(nodes, changedSplit.training, {
      hasher,
      partition: changedSplit.partition,
      validation: changedSplit.validation,
      priorState: initial.state
    })).toThrow(/partition policy mismatch/u);
  });

  it("rejects non-finite co-occurrence measures instead of silently dropping them", () => {
    const source = ids.nodeId("invalid-source");
    const target = ids.nodeId("invalid-target");
    expect(() => fitSparsePpmiRepresentation([source, target], [{ ...observation(source, target), count: Number.NaN }], { hasher })).toThrow("count must be a non-negative safe integer");
  });

  function observation(nodeId: NodeId, contextNodeId: NodeId, count = 10): PowerWalkCooccurrenceRow {
    return { nodeId, contextNodeId, count, distanceMean: 1, weight: 1 };
  }
});

function nearestTwinAccuracy(
  queries: readonly NodeId[],
  vectors: ReadonlyMap<NodeId, readonly number[]>,
  expectedTwin: ReadonlyMap<NodeId, NodeId>
): number {
  let correct = 0;
  for (const query of queries) {
    const queryVector = vectors.get(query) ?? [];
    const nearest = queries
      .filter(candidate => candidate !== query)
      .map(candidate => ({ candidate, score: cosineSimilarity(queryVector, vectors.get(candidate) ?? []) }))
      .sort((left, right) => right.score - left.score || String(left.candidate).localeCompare(String(right.candidate)))[0]?.candidate;
    if (nearest === expectedTwin.get(query)) correct++;
  }
  return correct / Math.max(1, queries.length);
}
