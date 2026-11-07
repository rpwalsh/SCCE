// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { concentrationThreshold, contentRuns, corpusIdentitySignals, corpusNamedIdentities, primeCorpusIdentitySignals } from "./corpus-identity.js";
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
  onTrace?: (record: {
    runs: number;
    measured: number;
    identities: readonly string[];
    concentration: number;
    contentRunsDurationMs: number;
    thresholdDurationMs: number;
    arbitrationDurationMs: number;
    preparationDurationMs: number;
    totalDurationMs: number;
  }) => void;
}): Promise<void> {
  const totalStarted = performance.now();
  const generation = measurementGeneration;
  const measurements = measurementsFor(input.evidence);
  const runsStarted = performance.now();
  const runs = contentRuns(input.requestText, input.closedClass);
  const runsDurationMs = performance.now() - runsStarted;
  const thresholdStarted = performance.now();
  await ensureThreshold(measurements, input.evidence, generation);
  const thresholdDurationMs = performance.now() - thresholdStarted;
  if (generation !== measurementGeneration) return;
  let preparationStarted = performance.now();
  let preparationDurationMs = 0;
  // The identity question is asked of the whole request, so it is cached per request rather than per run.
  const cachedIdentities = measurements.identitiesByText.get(input.requestText);
  const unmeasured = runs.filter(run => !measurements.answeredSpreadRuns.has(run));
  let identities = cachedIdentities;
  let arbitrationDurationMs = 0;
  if ((identities === undefined || unmeasured.length) && input.evidence.sourceIdentityArbitration) {
    preparationDurationMs += performance.now() - preparationStarted;
    const arbitrationStarted = performance.now();
    const arbitration = await input.evidence.sourceIdentityArbitration({ text: input.requestText, runs: unmeasured });
    arbitrationDurationMs = performance.now() - arbitrationStarted;
    if (generation !== measurementGeneration) return;
    preparationStarted = performance.now();
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
  preparationDurationMs += performance.now() - preparationStarted;
  input.onTrace?.({
    runs: runs.length,
    measured: unmeasured.length,
    identities: [...(identities ?? [])],
    concentration: measurements.threshold ?? 0,
    thresholdDurationMs,
    arbitrationDurationMs,
    contentRunsDurationMs: runsDurationMs,
    preparationDurationMs,
    totalDurationMs: performance.now() - totalStarted
  });
}

export interface RequestCorpusSubject {
  /** Runs the corpus carries as a whole source identity, measured against this request. */
  readonly identities: readonly string[];
  /** False when the corpus cannot be asked, which leaves the closed class as the only measure. */
  readonly measured: boolean;
  /** Maximal runs of units the language does not use as scaffolding. */
  readonly contentRuns: readonly string[];
}

/**
 * What one request names, measured now instead of read from the primed signal.
 *
 * A caller that runs before the turn -- the server deciding whether this request inherits the conversation's
 * evidence -- would otherwise read the PREVIOUS request's identity set, which is how a request naming its own
 * subject inherited the last one's. The answer is cached where the turn's own priming looks for it, and the
 * identity question is answered from the corpus's in-memory title list, so asking it here adds no query.
 */
export async function measureRequestCorpusSubject(input: {
  requestText: string;
  evidence?: Pick<EvidenceStore, "sourceIdentityArbitration">;
}): Promise<RequestCorpusSubject> {
  const primed = corpusIdentitySignals();
  const closedClass = primed?.closedClass ?? new Set<string>();
  const runs = contentRuns(input.requestText, closedClass);
  const arbitrate = input.evidence?.sourceIdentityArbitration;
  if (!input.evidence || !arbitrate) return { identities: [], measured: false, contentRuns: runs };
  const generation = measurementGeneration;
  const measurements = measurementsFor(input.evidence);
  let identities = measurements.identitiesByText.get(input.requestText);
  if (identities === undefined) {
    const arbitration = await arbitrate({ text: input.requestText, runs: [] });
    if (generation !== measurementGeneration) return { identities: [], measured: false, contentRuns: runs };
    identities = new Set(arbitration.identities);
    if (measurements.identitiesByText.size >= 512) measurements.identitiesByText.clear();
    measurements.identitiesByText.set(input.requestText, identities);
  }
  const named = corpusNamedIdentities(input.requestText, {
    closedClass,
    identities,
    spread: primed?.spread ?? new Map<string, number>(),
    concentration: primed?.concentration ?? 0
  });
  return { identities: named, measured: true, contentRuns: runs };
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
