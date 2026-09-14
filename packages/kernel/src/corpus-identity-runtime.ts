// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { concentrationThreshold, contentRuns, primeCorpusIdentitySignals } from "./corpus-identity.js";
import type { EvidenceStore } from "./storage.js";

/**
 * Measures what the corpus knows about one request's candidate runs and primes the pure arbiter with it.
 *
 * Everything measured here is a property of the corpus, so it is cached for the life of the process and a repeated
 * run costs nothing. A request whose runs have all been seen before issues no query at all, which is what makes
 * this affordable inside a turn.
 */

interface CorpusIdentityMeasurements {
  readonly identitiesByText: Map<string, Set<string>>;
  readonly answeredSpreadRuns: Set<string>;
  readonly spreadAnswers: Map<string, number>;
  threshold: number | undefined;
  thresholdInFlight: Promise<void> | undefined;
}

let measurementsByEvidence = new WeakMap<object, CorpusIdentityMeasurements>();
let measurementGeneration = 0;

/** Sampling breadth for the spread distribution: wide enough for a stable Otsu split, paid once per store after success. */
const DISTRIBUTION_SAMPLE = 400;

export async function primeCorpusIdentityForTurn(input: {
  requestText: string;
  closedClass: ReadonlySet<string>;
  evidence: Pick<EvidenceStore, "sourceIdentityArbitration" | "sourceSpreadDistribution">;
  onTrace?: (record: { runs: number; measured: number; identities: readonly string[]; concentration: number }) => void;
}): Promise<void> {
  const generation = measurementGeneration;
  const measurements = measurementsFor(input.evidence);
  const runs = contentRuns(input.requestText, input.closedClass);
  await ensureThreshold(measurements, input.evidence, generation);
  if (generation !== measurementGeneration) return;
  // The identity question is asked of the whole request, so it is cached per request rather than per run.
  const cachedIdentities = measurements.identitiesByText.get(input.requestText);
  const unmeasured = runs.filter(run => !measurements.answeredSpreadRuns.has(run));
  let identities = cachedIdentities;
  if ((identities === undefined || unmeasured.length) && input.evidence.sourceIdentityArbitration) {
    const arbitration = await input.evidence.sourceIdentityArbitration({ text: input.requestText, runs: unmeasured });
    if (generation !== measurementGeneration) return;
    identities = new Set(arbitration.identities);
    if (measurements.identitiesByText.size >= 512) measurements.identitiesByText.clear();
    measurements.identitiesByText.set(input.requestText, identities);
    for (const run of unmeasured) {
      measurements.answeredSpreadRuns.add(run);
      const measured = arbitration.spread.get(run);
      if (measured !== undefined) measurements.spreadAnswers.set(run, measured);
    }
  }
  const spread = new Map<string, number>();
  for (const run of runs) {
    const measured = measurements.spreadAnswers.get(run);
    if (measured !== undefined) spread.set(run, measured);
  }
  primeCorpusIdentitySignals({
    closedClass: input.closedClass,
    identities: identities ?? new Set<string>(),
    spread,
    concentration: measurements.threshold ?? 0
  });
  input.onTrace?.({ runs: runs.length, measured: unmeasured.length, identities: [...(identities ?? [])], concentration: measurements.threshold ?? 0 });
}

function measurementsFor(evidence: object): CorpusIdentityMeasurements {
  const cached = measurementsByEvidence.get(evidence);
  if (cached) return cached;
  const created: CorpusIdentityMeasurements = {
    identitiesByText: new Map(),
    answeredSpreadRuns: new Set(),
    spreadAnswers: new Map(),
    threshold: undefined,
    thresholdInFlight: undefined
  };
  measurementsByEvidence.set(evidence, created);
  return created;
}

async function ensureThreshold(
  measurements: CorpusIdentityMeasurements,
  evidence: Pick<EvidenceStore, "sourceSpreadDistribution">,
  generation: number
): Promise<void> {
  if (measurements.threshold !== undefined) return;
  if (!evidence.sourceSpreadDistribution) {
    measurements.threshold = 0;
    return;
  }
  measurements.thresholdInFlight ??= (async () => {
    try {
      const distribution = await evidence.sourceSpreadDistribution!(DISTRIBUTION_SAMPLE);
      if (generation !== measurementGeneration) return;
      measurements.threshold = concentrationThreshold(distribution, Math.max(1, ...distribution));
    } catch {
      // A transient read failure leaves the threshold unmeasured so the next turn can retry it.
    }
  })();
  const pending = measurements.thresholdInFlight;
  await pending;
  if (measurements.thresholdInFlight === pending) measurements.thresholdInFlight = undefined;
}

/** Test seam: forget every measurement, so a test starts from an unmeasured corpus. */
export function resetCorpusIdentityMeasurements(): void {
  measurementsByEvidence = new WeakMap();
  measurementGeneration += 1;
}
