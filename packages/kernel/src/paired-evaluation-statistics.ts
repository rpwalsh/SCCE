/**
 * Plan items 232-234. The signed paired-result recording contract
 * (`X_ic in {-1,0,1}`) with task-family clustering, a real percentile
 * cluster-bootstrap lower-confidence-bound estimator for each class
 * effect `mu_c` (not a normal-approximation shortcut, which would be
 * unjustified for a bounded three-valued outcome), and Holm-Bonferroni
 * step-down multiple-comparison correction across the resulting classes.
 */

export type PairedResult = -1 | 0 | 1;

export interface PairedResultRecord {
  id: string;
  taskFamilyId: string;
  value: PairedResult;
}

export function isValidPairedResult(value: number): value is PairedResult {
  return value === -1 || value === 0 || value === 1;
}

export interface ClassEffectEstimate {
  taskFamilyId: string;
  sampleCount: number;
  meanEffect: number;
  /** One-sided lower confidence bound on the true class effect, at `confidenceLevel`, via percentile cluster bootstrap. */
  lowerConfidenceBound: number;
  /** One-sided bootstrap p-value against the null mu_c <= 0 (fraction of resampled means at or below zero). */
  pValue: number;
}

export interface EstimateClassEffectOptions {
  confidenceLevel: number;
  bootstrapSamples: number;
  /** Injectable for deterministic tests; defaults to Math.random. */
  randomSource?: () => number;
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

/**
 * Real, non-parametric percentile bootstrap: resamples (with
 * replacement) `bootstrapSamples` times *within* each task-family cluster
 * -- the cluster is the unit of resampling, matching the plan's "cluster
 * bootstrap" requirement, rather than pretending correlated records
 * inside one family are independent draws pooled across families.
 */
export function estimateClassEffectLCB(
  records: readonly PairedResultRecord[],
  options: EstimateClassEffectOptions
): ClassEffectEstimate[] {
  if (!(options.confidenceLevel > 0 && options.confidenceLevel < 1)) {
    throw new Error("confidenceLevel must be in (0, 1)");
  }
  if (!(options.bootstrapSamples > 0)) throw new Error("bootstrapSamples must be positive");
  for (const record of records) {
    if (!isValidPairedResult(record.value)) {
      throw new Error(`invalid paired result for ${record.id}: X_ic must be one of -1, 0, 1`);
    }
  }
  const random = options.randomSource ?? Math.random;
  const byFamily = new Map<string, PairedResultRecord[]>();
  for (const record of records) {
    const bucket = byFamily.get(record.taskFamilyId) ?? [];
    bucket.push(record);
    byFamily.set(record.taskFamilyId, bucket);
  }

  const estimates: ClassEffectEstimate[] = [];
  for (const [taskFamilyId, familyRecords] of [...byFamily.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    const values = familyRecords.map(record => record.value);
    const observedMean = mean(values);
    const bootstrapMeans: number[] = [];
    for (let sample = 0; sample < options.bootstrapSamples; sample++) {
      const resample: number[] = [];
      for (let draw = 0; draw < values.length; draw++) {
        resample.push(values[Math.floor(random() * values.length)]!);
      }
      bootstrapMeans.push(mean(resample));
    }
    bootstrapMeans.sort((left, right) => left - right);
    const lowerIndex = Math.floor((1 - options.confidenceLevel) * bootstrapMeans.length);
    const lowerConfidenceBound = bootstrapMeans[Math.min(lowerIndex, bootstrapMeans.length - 1)]!;
    const pValue = bootstrapMeans.filter(value => value <= 0).length / bootstrapMeans.length;
    estimates.push({
      taskFamilyId,
      sampleCount: values.length,
      meanEffect: observedMean,
      lowerConfidenceBound,
      pValue
    });
  }
  return estimates;
}

export interface HolmCorrectionInput {
  id: string;
  pValue: number;
}

export interface HolmCorrectionResult {
  id: string;
  pValue: number;
  rank: number;
  requiredThreshold: number;
  reject: boolean;
}

/**
 * Holm-Bonferroni step-down: sort ascending, walk from the smallest
 * p-value, rejecting each hypothesis while `p_(k) <= alpha/(m-k+1)`; the
 * first hypothesis that fails this test, and every hypothesis after it in
 * rank order, is not rejected -- the real step-down rule (strictly more
 * powerful than a flat Bonferroni correction, and still family-wise
 * error-rate valid without independence assumptions).
 */
export function holmBonferroniCorrection(
  inputs: readonly HolmCorrectionInput[],
  alpha: number
): HolmCorrectionResult[] {
  if (!(alpha > 0 && alpha < 1)) throw new Error("alpha must be in (0, 1)");
  const sorted = [...inputs].sort((left, right) => left.pValue - right.pValue || left.id.localeCompare(right.id));
  const total = sorted.length;
  const results: HolmCorrectionResult[] = [];
  let stopped = false;
  sorted.forEach((input, index) => {
    const rank = index + 1;
    const requiredThreshold = alpha / (total - rank + 1);
    const passes = !stopped && input.pValue <= requiredThreshold;
    if (!passes) stopped = true;
    results.push({ id: input.id, pValue: input.pValue, rank, requiredThreshold, reject: passes });
  });
  return results;
}
