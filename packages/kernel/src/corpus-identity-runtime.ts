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

const identitiesByText = new Map<string, Set<string>>();
const spreadAnswers = new Map<string, number>();
let threshold: number | undefined;
let thresholdInFlight: Promise<void> | undefined;

/** Sampling breadth for the spread distribution: wide enough for a stable Otsu split, paid once per process. */
const DISTRIBUTION_SAMPLE = 400;

export async function primeCorpusIdentityForTurn(input: {
  requestText: string;
  closedClass: ReadonlySet<string>;
  evidence: Pick<EvidenceStore, "sourceIdentityArbitration" | "sourceSpreadDistribution">;
  onTrace?: (record: { runs: number; measured: number; identities: readonly string[]; concentration: number }) => void;
}): Promise<void> {
  const runs = contentRuns(input.requestText, input.closedClass);
  await ensureThreshold(input.evidence);
  // The identity question is asked of the whole request, so it is cached per request rather than per run.
  const cachedIdentities = identitiesByText.get(input.requestText);
  const unmeasured = runs.filter(run => !spreadAnswers.has(run));
  let identities = cachedIdentities;
  if ((identities === undefined || unmeasured.length) && input.evidence.sourceIdentityArbitration) {
    const arbitration = await input.evidence.sourceIdentityArbitration({ text: input.requestText, runs: unmeasured });
    identities = new Set(arbitration.identities);
    if (identitiesByText.size >= 512) identitiesByText.clear();
    identitiesByText.set(input.requestText, identities);
    for (const run of unmeasured) spreadAnswers.set(run, arbitration.spread.get(run) ?? 0);
  }
  const spread = new Map<string, number>();
  for (const run of runs) {
    const measured = spreadAnswers.get(run);
    if (measured !== undefined) spread.set(run, measured);
  }
  primeCorpusIdentitySignals({
    closedClass: input.closedClass,
    identities: identities ?? new Set<string>(),
    spread,
    concentration: threshold ?? 0
  });
  input.onTrace?.({ runs: runs.length, measured: unmeasured.length, identities: [...(identities ?? [])], concentration: threshold ?? 0 });
}

async function ensureThreshold(evidence: Pick<EvidenceStore, "sourceSpreadDistribution">): Promise<void> {
  if (threshold !== undefined) return;
  if (!evidence.sourceSpreadDistribution) {
    threshold = 0;
    return;
  }
  thresholdInFlight ??= (async () => {
    const distribution = await evidence.sourceSpreadDistribution!(DISTRIBUTION_SAMPLE);
    threshold = concentrationThreshold(distribution, Math.max(1, ...distribution));
  })().catch(() => {
    threshold = 0;
  });
  await thresholdInFlight;
}

/** Test seam: forget every measurement, so a test starts from an unmeasured corpus. */
export function resetCorpusIdentityMeasurements(): void {
  identitiesByText.clear();
  spreadAnswers.clear();
  threshold = undefined;
  thresholdInFlight = undefined;
}
