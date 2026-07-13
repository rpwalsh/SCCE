import type { Hasher, LatentConcept, GraphNode, WeightedFeatureSketch } from "./types.js";
import { stableVector, variance } from "./primitives.js";

/**
 * Learn a bounded, alpha-weighted feature-frequency sketch. The projection is
 * a deterministic hash projection used for stable downstream coordinates; it
 * is not PCA, matrix factorisation, or a learned latent-variable basis.
 */
export function createWeightedFeatureSketchLearner(options: { hasher: Hasher }) {
  return {
    learn(nodes: readonly GraphNode[], maxSketches = 16): WeightedFeatureSketch[] {
      const counts = new Map<string, number>();
      for (const node of nodes) {
        const contribution = Number.isFinite(node.alpha) ? Math.max(0, node.alpha) : 0;
        for (const feature of new Set(node.features)) counts.set(feature, (counts.get(feature) ?? 0) + contribution);
      }
      const total = [...counts.values()].reduce((sum, value) => sum + value, 0) || 1;
      return [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, Math.max(0, Math.floor(maxSketches)))
        .map(([feature, weight], index) => {
          const related = nodes.filter(node => node.features.includes(feature)).flatMap(node => node.features).slice(0, 64);
          const projection = stableVector([feature, ...related], options.hasher, 32);
          const supportShare = weight / total;
          return {
            id: options.hasher.digestHex(`feature-sketch:${index}:${feature}`).slice(0, 32),
            features: [feature, ...related.slice(0, 8)],
            projection,
            supportShare,
            projectionVariance: variance(projection),
            method: "weighted_feature_frequency_hash_projection.v1" as const,
            // Preserve the historical JSON shape without claiming explained
            // variance. New code should use projection and supportShare.
            basis: projection,
            varianceShare: supportShare
          };
        });
    }
  };
}

/** @deprecated Use createWeightedFeatureSketchLearner. */
export function createLatentConceptLearner(options: { hasher: Hasher }): ReturnType<typeof createWeightedFeatureSketchLearner> {
  return createWeightedFeatureSketchLearner(options);
}

export function featureSketchSupportShare(sketch: LatentConcept): number {
  const current = (sketch as Partial<WeightedFeatureSketch>).supportShare;
  // Historical varianceShare mixed frequency share with hash-vector variance,
  // so it cannot be reconstructed as support. Treat it as unavailable.
  return typeof current === "number" && Number.isFinite(current) ? Math.max(0, current) : 0;
}

export function featureSketchProjection(sketch: LatentConcept): number[] {
  const current = (sketch as Partial<WeightedFeatureSketch>).projection;
  return Array.isArray(current) ? current : sketch.basis;
}
