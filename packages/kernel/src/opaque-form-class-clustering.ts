import type { Hasher } from "./types.js";
import type { LearnedFormClass } from "./language-construction.js";

export const OPAQUE_FORM_CLASS_CLUSTER_SCHEMA = "scce.opaque_form_class_cluster.v1" as const;

/**
 * Plan item 101. Complete-link (furthest-neighbor) agglomerative
 * clustering over `LearnedFormClass` instances -- possibly induced from
 * many different constructions (`language-construction.ts`'s
 * `induceLearnedConstructions` scopes each `LearnedFormClass` to one
 * construction's single slot) -- grouped by purely distributional
 * similarity of their observed variant-surface sets (Jaccard), never by
 * any lexicon or part-of-speech knowledge, keeping the induction
 * genuinely opaque.
 *
 * The anti-chain-collapse guarantee is complete-link's own merge rule,
 * not a bolted-on afterthought: a merge is only permitted when *every*
 * cross-pair between the two candidate clusters clears
 * `minClusterSimilarity`, not just the single closest pair. Single-link
 * (nearest-neighbor) clustering is well known to "chain" through one
 * bridging outlier -- two genuinely dissimilar groups both merge with a
 * cluster that only weakly resembles either -- until everything collapses
 * into one giant cluster. Complete-link structurally cannot do that: a
 * candidate merge is rejected the moment any single cross-pair falls
 * below the threshold, so a bridging outlier caps that cluster's own
 * growth instead of dragging unrelated clusters in behind it.
 */
export interface OpaqueFormClassCluster {
  id: string;
  formClassIds: readonly string[];
  /** Union of every member form class's observed variant surfaces -- for inspection, not consumed by the algorithm. */
  memberVariantSurfaces: readonly string[];
  /** The real minimum pairwise Jaccard similarity across every member pair -- this cluster's own complete-link diameter bound; 1 for a singleton. */
  minPairwiseSimilarity: number;
}

/** Bounded: the clustering below is worst-case superlinear in this count (real per-population induction batches, not a live firehose) -- fail loudly rather than silently degrade on an unexpectedly large input. */
const MAX_FORM_CLASSES = 500;

function variantSurfaceSet(formClass: LearnedFormClass): ReadonlySet<string> {
  return new Set(formClass.variants.map(variant => variant.surface));
}

function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function completeLinkSimilarity(
  clusterA: readonly number[],
  clusterB: readonly number[],
  sets: readonly ReadonlySet<string>[]
): number {
  let minSimilarity = 1;
  for (const a of clusterA) {
    for (const b of clusterB) {
      minSimilarity = Math.min(minSimilarity, jaccardSimilarity(sets[a]!, sets[b]!));
    }
  }
  return minSimilarity;
}

export function clusterOpaqueFormClasses(input: {
  formClasses: readonly LearnedFormClass[];
  minClusterSimilarity: number;
  hasher: Hasher;
}): OpaqueFormClassCluster[] {
  if (!Number.isFinite(input.minClusterSimilarity) || input.minClusterSimilarity < 0 || input.minClusterSimilarity > 1) {
    throw new Error("minClusterSimilarity must be a finite number within [0,1]");
  }
  if (input.formClasses.length > MAX_FORM_CLASSES) {
    throw new Error(`clusterOpaqueFormClasses received ${input.formClasses.length} form classes, exceeding the bounded maximum of ${MAX_FORM_CLASSES}`);
  }
  const ordered = [...input.formClasses].sort((left, right) => left.id.localeCompare(right.id));
  const sets = ordered.map(variantSurfaceSet);
  let clusters: number[][] = ordered.map((_, index) => [index]);

  while (clusters.length > 1) {
    let bestPair: [number, number] | undefined;
    let bestSimilarity = -1;
    for (let i = 0; i < clusters.length; i += 1) {
      for (let j = i + 1; j < clusters.length; j += 1) {
        const similarity = completeLinkSimilarity(clusters[i]!, clusters[j]!, sets);
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          bestPair = [i, j];
        }
      }
    }
    if (!bestPair || bestSimilarity < input.minClusterSimilarity) break;
    const [i, j] = bestPair;
    const merged = [...clusters[i]!, ...clusters[j]!];
    clusters = clusters.filter((_, index) => index !== i && index !== j);
    clusters.push(merged);
  }

  return clusters
    .map(memberIndices => {
      const members = memberIndices.map(index => ordered[index]!);
      const formClassIds = members.map(member => member.id).sort();
      const memberVariantSurfaces = [...new Set(members.flatMap(member => member.variants.map(variant => variant.surface)))].sort();
      let minPairwiseSimilarity = 1;
      for (let a = 0; a < memberIndices.length; a += 1) {
        for (let b = a + 1; b < memberIndices.length; b += 1) {
          minPairwiseSimilarity = Math.min(minPairwiseSimilarity, jaccardSimilarity(sets[memberIndices[a]!]!, sets[memberIndices[b]!]!));
        }
      }
      const id = `opaque_form_class_cluster.${input.hasher.digestHex(formClassIds.join("|")).slice(0, 32)}`;
      return { id, formClassIds, memberVariantSurfaces, minPairwiseSimilarity };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}
