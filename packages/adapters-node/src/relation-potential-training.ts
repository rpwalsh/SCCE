// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  createHasher,
  fitRelationPotential,
  projectGraphEdgeRelationPotential,
  type GraphEdge,
  type RelationPotentialExample,
  type RelationPotentialModel,
  type ScceStorage
} from "@scce/kernel";

export interface RelationPotentialHoldoutExample extends RelationPotentialExample {
  /** What the field engine uses without a model: weight * alpha, identity's own ordering. */
  readonly baseTransitionWeight: number;
}

export interface RelationPotentialTrainingReport {
  model: RelationPotentialModel | null;
  /** The evaluation split, returned so validation happens on data the fit never saw. */
  holdout: readonly RelationPotentialHoldoutExample[];
  edgeCount: number;
  labelledCount: number;
  positiveCount: number;
  datasetCounts: { coefficientTraining: number; calibrationFit: number; evaluationHoldout: number };
  skipped: string[];
}

/**
 * Labels come from the graph's own corroboration, never from a hand-written key: an edge whose evidence spans two or
 * more source versions is a positive example, an edge whose only source is outvoted by a corroborated competitor over
 * the same node pair is a negative one. Everything else is unlabelled and never enters a dataset. The three datasets
 * are split by source version, so no version's edges appear in two of them.
 */
export async function fitRelationPotentialFromGraph(input: {
  storage: ScceStorage;
  maxEdges?: number;
  minimumExamplesPerDataset?: number;
}): Promise<RelationPotentialTrainingReport> {
  const hasher = createHasher();
  const limit = Math.max(1, Math.min(200_000, Math.floor(input.maxEdges ?? 20_000)));
  const minimum = Math.max(2, Math.floor(input.minimumExamplesPerDataset ?? 8));
  // Fitting reads edges only; unbounded node representations are what exhausted the heap on a real brain.
  // getSlice seeds from nodes and returns one neighbourhood; a population fit needs the edge table itself.
  const population: GraphEdge[] = [];
  if (input.storage.graph.listEdgePage) {
    while (population.length < limit) {
      const page = await input.storage.graph.listEdgePage({ limit: Math.min(20_000, limit - population.length), offset: population.length });
      if (!page.length) break;
      population.push(...page);
    }
  } else {
    const slice = await input.storage.graph.getSlice({ limitEdges: limit, limitNodes: 1, maxRepresentationBytes: 512, allowLatestFallback: true });
    population.push(...slice.edges);
  }
  const edges = population.filter(edge => Number.isFinite(edge.alpha) && Number.isFinite(edge.weight));
  const skipped: string[] = [];
  if (!edges.length) return { model: null, holdout: [], edgeCount: 0, labelledCount: 0, positiveCount: 0, datasetCounts: { coefficientTraining: 0, calibrationFit: 0, evaluationHoldout: 0 }, skipped: ["no graph edges"] };

  const evidenceIds = [...new Set(edges.flatMap(edge => edge.evidenceIds.map(String)))].slice(0, 100_000);
  // Provenance only: full spans carry text and exhausted the heap at 12,000 edges.
  const versionByEvidence = new Map<string, string>();
  const provenanceReader = input.storage.evidence.getEvidenceSourceVersions;
  // Cost bound: one round trip per 5,000 ids.
  for (let offset = 0; offset < evidenceIds.length; offset += 5_000) {
    const page = evidenceIds.slice(offset, offset + 5_000) as GraphEdge["evidenceIds"];
    if (provenanceReader) {
      for (const row of await provenanceReader.call(input.storage.evidence, page)) versionByEvidence.set(row.id, row.sourceVersionId);
    } else {
      for (const span of await input.storage.evidence.getEvidenceBatch(page)) versionByEvidence.set(String(span.id), String(span.sourceVersionId));
    }
  }
  const versionsOf = (edge: GraphEdge) => new Set(edge.evidenceIds.map(id => versionByEvidence.get(String(id))).filter((value): value is string => Boolean(value)));

  const corroborated = new Map<string, number>();
  for (const edge of edges) corroborated.set(String(edge.id), versionsOf(edge).size);
  const byPair = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    const key = `${String(edge.source)}${String(edge.target)}`;
    byPair.set(key, [...(byPair.get(key) ?? []), edge]);
  }

  const snapshotTime = Math.max(0, ...edges.map(edge => Number(edge.updatedAt ?? edge.createdAt ?? 0)).filter(Number.isFinite));
  const examples: Array<RelationPotentialExample & { versionKey: string; baseTransitionWeight: number }> = [];
  for (const edge of edges) {
    const versions = versionsOf(edge);
    const competitors = (byPair.get(`${String(edge.source)}${String(edge.target)}`) ?? [])
      .filter(other => String(other.id) !== String(edge.id) && String(other.relationId) !== String(edge.relationId));
    const outvoted = competitors.some(other => (corroborated.get(String(other.id)) ?? 0) > versions.size);
    const label: 0 | 1 | undefined = versions.size >= 2 ? 1 : (versions.size <= 1 && outvoted ? 0 : undefined);
    if (label === undefined) continue;
    let features;
    try {
      features = projectGraphEdgeRelationPotential(edge, { edges, snapshotTime: snapshotTime || undefined }).features;
    } catch (error) {
      skipped.push(`${String(edge.id)}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    examples.push({ id: String(edge.id), features, label, versionKey: [...versions].sort().join("") || String(edge.id), baseTransitionWeight: edge.weight * edge.alpha });
  }

  // Split by source version so a version's edges never span two datasets.
  const buckets: Record<"coefficientTraining" | "calibrationFit" | "evaluationHoldout", RelationPotentialExample[]> = { coefficientTraining: [], calibrationFit: [], evaluationHoldout: [] };
  const holdout: RelationPotentialHoldoutExample[] = [];
  for (const example of examples) {
    const bucket = Number.parseInt(hasher.digestHex(example.versionKey).slice(0, 2), 16) % 5;
    const target = bucket < 3 ? "coefficientTraining" : bucket === 3 ? "calibrationFit" : "evaluationHoldout";
    buckets[target].push({ id: example.id, features: example.features, label: example.label });
    if (target === "evaluationHoldout") holdout.push({ id: example.id, features: example.features, label: example.label, baseTransitionWeight: example.baseTransitionWeight });
  }
  const datasetCounts = { coefficientTraining: buckets.coefficientTraining.length, calibrationFit: buckets.calibrationFit.length, evaluationHoldout: buckets.evaluationHoldout.length };
  const report: RelationPotentialTrainingReport = {
    model: null,
    holdout,
    edgeCount: edges.length,
    labelledCount: examples.length,
    positiveCount: examples.filter(example => example.label === 1).length,
    datasetCounts,
    skipped: skipped.slice(0, 32)
  };
  const thin = Object.entries(datasetCounts).filter(([, count]) => count < minimum).map(([name]) => name);
  const singleClass = Object.entries(buckets).filter(([, rows]) => new Set(rows.map(row => row.label)).size < 2).map(([name]) => name);
  if (thin.length || singleClass.length) {
    report.skipped.push(...thin.map(name => `${name} below ${minimum} examples`), ...singleClass.map(name => `${name} has one label class`));
    return report;
  }
  report.model = fitRelationPotential(buckets);
  return report;
}
