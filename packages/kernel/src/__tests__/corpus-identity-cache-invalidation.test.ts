// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it } from "vitest";
import { createClock, createScceKernel } from "../index.js";
import { clearCorpusIdentitySignals, concentrationThreshold, corpusIdentitySignals } from "../corpus-identity.js";
import { invalidateCorpusIdentityMeasurements, measureRequestCorpusSubject, primeCorpusIdentityForTurn, resetCorpusIdentityMeasurements } from "../corpus-identity-runtime.js";
import type { EvidenceStore } from "../storage.js";
import { storageFixtureForEvaluation } from "./evidence-promotion-evaluation-fixture.js";

afterEach(() => { resetCorpusIdentityMeasurements(); clearCorpusIdentitySignals(); });
const requestText = "港 q0 נמלית", closedClass = new Set(["q0"]);
type IdentityEvidence = Pick<EvidenceStore, "sourceIdentityArbitration" | "sourceSpreadDistribution">;
function mutableEvidence() {
  const state = { identities: [] as string[], spread: new Map<string, number>([["港", 0], ["נמלית", 0]]), distribution: [0], arbitrationCalls: 0, distributionCalls: 0 };
  const evidence: IdentityEvidence = {
    sourceIdentityArbitration: async () => { state.arbitrationCalls++; return { identities: [...state.identities], spread: new Map(state.spread) }; },
    sourceSpreadDistribution: async () => { state.distributionCalls++; return [...state.distribution]; }
  };
  return { state, evidence };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const prime = (evidence: IdentityEvidence) => primeCorpusIdentityForTurn({ requestText, closedClass, evidence });

it.each(["activation", "durable revision"])("remeasures zero-spread and changed current-source data through the real kernel %s boundary", async boundary => {
  const { state, evidence } = mutableEvidence(), other = mutableEvidence();
  const clock = createClock({ fixedTime: 1000, stepMs: 1 });
  const { storage } = storageFixtureForEvaluation({ evidence: [], clockNow: () => clock.now() });
  let revision = 1;
  storage.languageMemory.readRevision = async () => String(revision);
  Object.assign(storage.evidence, evidence);
  const kernel = createScceKernel({ storage, clock, deterministicReplay: true, files: { streamPath: async function* () {} },
    buildTest: { executeProgram: async () => { throw new Error("cache invalidation cannot run a program"); } } });
  await kernel.languageIdentityManifest();
  const published = async () => {
    if (boundary === "activation") await kernel.refreshAfterBrainActivation();
    else { revision++; await kernel.languageIdentityManifest(); }
  };
  await prime(storage.evidence);
  await prime(other.evidence);
  expect((await measureRequestCorpusSubject({ requestText, evidence: storage.evidence })).identities).toEqual([]);
  state.identities = ["港"]; state.spread = new Map([["港", 1], ["נמלית", 0]]); state.distribution = [1, 1, 100, 100];
  await published();
  await prime(storage.evidence);
  expect((await measureRequestCorpusSubject({ requestText, evidence: storage.evidence })).identities).toEqual(["港"]);
  expect(corpusIdentitySignals()?.spread).toEqual(state.spread);
  expect(corpusIdentitySignals()?.concentration).toBe(concentrationThreshold(state.distribution, 100));
  state.identities = ["נמלית"]; state.spread = new Map([["港", 0], ["נמלית", 2]]); state.distribution = [2, 2, 200, 200];
  await published();
  await prime(storage.evidence);
  expect((await measureRequestCorpusSubject({ requestText, evidence: storage.evidence })).identities).toEqual(["נמלית"]);
  expect(corpusIdentitySignals()?.spread).toEqual(state.spread);
  expect(corpusIdentitySignals()?.concentration).toBe(concentrationThreshold(state.distribution, 200));
  expect(state.arbitrationCalls).toBe(3); expect(state.distributionCalls).toBe(3);
  await kernel.languageIdentityManifest(); await prime(storage.evidence);
  expect(state.arbitrationCalls).toBe(3); expect(state.distributionCalls).toBe(3);
  await prime(other.evidence);
  expect(other.state.arbitrationCalls).toBe(1); expect(other.state.distributionCalls).toBe(1);
});

it("fences an old threshold while preserving another store's in-flight measurement", async () => {
  const a = mutableEvidence(), b = mutableEvidence(), oldThreshold = deferred<number[]>(), otherThreshold = deferred<number[]>();
  let firstA = true;
  a.evidence.sourceSpreadDistribution = async () => firstA ? (firstA = false, oldThreshold.promise) : [3, 3, 300, 300];
  b.evidence.sourceSpreadDistribution = async () => otherThreshold.promise;
  a.state.identities = ["港"]; b.state.identities = ["נמלית"];
  const stale = prime(a.evidence), unrelated = prime(b.evidence);
  invalidateCorpusIdentityMeasurements(a.evidence);
  await prime(a.evidence);
  const fresh = corpusIdentitySignals();
  oldThreshold.resolve([1, 1, 100, 100]); await stale;
  expect(corpusIdentitySignals()).toBe(fresh);
  expect(a.state.arbitrationCalls).toBe(1);
  otherThreshold.resolve([4, 4, 400, 400]); await unrelated;
  expect(b.state.arbitrationCalls).toBe(1);
  expect(corpusIdentitySignals()?.identities).toEqual(new Set(["נמלית"]));
  expect(corpusIdentitySignals()?.concentration).toBe(concentrationThreshold([4, 4, 400, 400], 400));
  await prime(a.evidence);
  expect(a.state.arbitrationCalls).toBe(1);
  expect(corpusIdentitySignals()?.concentration).toBe(concentrationThreshold([3, 3, 300, 300], 300));
});

it("does not let an old arbitration re-prime signals or repopulate a fresh store cache", async () => {
  const { state, evidence } = mutableEvidence(), pending = deferred<{ identities: string[]; spread: Map<string, number> }>(), entered = deferred<void>();
  let calls = 0;
  evidence.sourceIdentityArbitration = async () => {
    if (++calls === 1) { entered.resolve(); return pending.promise; }
    return { identities: ["נמלית"], spread: new Map([["נמלית", 1]]) };
  };
  const stale = prime(evidence); await entered.promise;
  invalidateCorpusIdentityMeasurements(evidence);
  await prime(evidence);
  const fresh = corpusIdentitySignals();
  pending.resolve({ identities: ["港"], spread: new Map([["港", 0]]) }); await stale;
  expect(corpusIdentitySignals()).toBe(fresh);
  await prime(evidence);
  expect(calls).toBe(2); expect(state.distributionCalls).toBe(2);
  expect(corpusIdentitySignals()?.identities).toEqual(new Set(["נמלית"]));
});

it("marks an invalidated pending direct subject read unmeasured and never remembers its stale identity", async () => {
  const { evidence } = mutableEvidence(), pending = deferred<{ identities: string[]; spread: Map<string, number> }>();
  let calls = 0;
  evidence.sourceIdentityArbitration = async () => ++calls === 1 ? pending.promise : { identities: ["נמלית"], spread: new Map() };
  const stale = measureRequestCorpusSubject({ requestText, evidence });
  invalidateCorpusIdentityMeasurements(evidence);
  expect((await measureRequestCorpusSubject({ requestText, evidence })).identities).toEqual(["נמלית"]);
  pending.resolve({ identities: ["港"], spread: new Map() });
  expect((await stale).measured).toBe(false);
  expect((await measureRequestCorpusSubject({ requestText, evidence })).identities).toEqual(["נמלית"]);
  expect(calls).toBe(2);
});
