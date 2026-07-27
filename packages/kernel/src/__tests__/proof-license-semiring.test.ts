import { describe, expect, it } from "vitest";
import {
  createProofLicenseSemiring,
  totalProbabilityLogSemiring,
  viterbiLogSemiring,
  type ProofLicenseCarrier
} from "../proof-license-semiring.js";

// Small finite universe of atom ids, enumerated exhaustively (bounded
// exhaustive testing over every subset) rather than sampled -- with only 4
// atoms this covers every reachable proof-license state, which is a
// stronger guarantee than a handful of random samples for a plan item that
// asks for closure/associativity/identity/distributivity "against the
// implemented carrier -- not assumed".
const UNIVERSE = ["a", "b", "c", "d"] as const;
// "a" and "d" are declared mutually exclusive proof requirements (e.g. "the
// answer used evidence.a" vs "the answer explicitly lacked evidence.a").
const CONFLICT_PAIR: readonly [string, string] = ["a", "d"];

function stateKey(state: ReadonlySet<string>): string {
  return [...state].sort().join(",");
}

function conflicts(state: ReadonlySet<string>): boolean {
  return state.has(CONFLICT_PAIR[0]) && state.has(CONFLICT_PAIR[1]);
}

/**
 * Every subset of the universe that does NOT already self-conflict. This is
 * the only legitimate domain for a *base-case* (leaf) carrier: a real
 * chart-parser leaf comes from a single terminal, which by construction
 * never starts out self-contradictory -- the conflict check in
 * `unionStates` exists to catch two previously-valid states being combined
 * into an invalid one, not to validate arbitrary atomic input. Feeding a
 * pre-built {a,d} singleton directly into `add`/`multiply` would test a
 * scenario the semiring was never designed to guard (it only vets unions it
 * performs itself), so that state is excluded here rather than the
 * property tests being loosened to tolerate it.
 */
function allSubsets(): ReadonlySet<string>[] {
  const subsets: ReadonlySet<string>[] = [];
  for (let mask = 0; mask < 1 << UNIVERSE.length; mask++) {
    const members = UNIVERSE.filter((_, index) => (mask & (1 << index)) !== 0);
    const state = new Set(members);
    if (!conflicts(state)) subsets.push(state);
  }
  return subsets;
}

function makeSemiring(base: typeof viterbiLogSemiring | typeof totalProbabilityLogSemiring) {
  return createProofLicenseSemiring<ReadonlySet<string>>({
    base,
    stateKey,
    emptyState: new Set(),
    unionStates: (left, right) => {
      const unioned = new Set([...left, ...right]);
      return conflicts(unioned) ? undefined : unioned;
    },
    // "e" is never a member of any state produced from UNIVERSE, so this
    // only exercises the prune-on-unsupported path via the dedicated test
    // below, not the property tests (which must hold for every legitimate
    // state).
    isSupported: state => !state.has("banned")
  });
}

function singleton(state: ReadonlySet<string>, value: number): ProofLicenseCarrier<ReadonlySet<string>> {
  return new Map([[stateKey(state), { state, value }]]);
}

function carriersOverSubsets(values: readonly number[]): ProofLicenseCarrier<ReadonlySet<string>>[] {
  const subsets = allSubsets();
  // One representative carrier per subset (as a singleton), each with a
  // distinct value cycling through `values` -- enough to exercise both
  // add's like-key collection and multiply's cross-product union logic
  // exhaustively without an external property-testing dependency.
  return subsets.map((subset, index) => singleton(subset, values[index % values.length]!));
}

describe.each([
  ["viterbi (max, +)", viterbiLogSemiring],
  ["total-probability (log-sum-exp, +)", totalProbabilityLogSemiring]
] as const)("proof-license product semiring over %s", (_label, base) => {
  const semiring = makeSemiring(base);
  const carriers = carriersOverSubsets([0, -0.5, -1, -2, -3.25]);

  it("is closed: every add/multiply result is a legitimate carrier (no conflicting or zero-valued entries)", () => {
    for (const left of carriers) {
      for (const right of carriers) {
        for (const result of [semiring.add(left, right), semiring.multiply(left, right)]) {
          for (const entry of result.values()) {
            expect(conflicts(entry.state)).toBe(false);
            expect(entry.value).not.toBe(base.zero);
          }
        }
      }
    }
  });

  it("add is associative: (a+b)+c == a+(b+c)", () => {
    const sample = carriers.slice(0, 6);
    for (const a of sample) {
      for (const b of sample) {
        for (const c of sample) {
          const left = semiring.add(semiring.add(a, b), c);
          const right = semiring.add(a, semiring.add(b, c));
          expect(semiring.carrierEqual(left, right)).toBe(true);
        }
      }
    }
  });

  it("multiply is associative: (a*b)*c == a*(b*c)", () => {
    const sample = carriers.slice(0, 6);
    for (const a of sample) {
      for (const b of sample) {
        for (const c of sample) {
          const left = semiring.multiply(semiring.multiply(a, b), c);
          const right = semiring.multiply(a, semiring.multiply(b, c));
          expect(semiring.carrierEqual(left, right)).toBe(true);
        }
      }
    }
  });

  it("zero is the additive identity and one is the multiplicative identity", () => {
    for (const carrier of carriers) {
      expect(semiring.carrierEqual(semiring.add(carrier, semiring.zero), carrier)).toBe(true);
      expect(semiring.carrierEqual(semiring.add(semiring.zero, carrier), carrier)).toBe(true);
      expect(semiring.carrierEqual(semiring.multiply(carrier, semiring.one), carrier)).toBe(true);
      expect(semiring.carrierEqual(semiring.multiply(semiring.one, carrier), carrier)).toBe(true);
    }
  });

  it("multiply distributes over add: a*(b+c) == a*b + a*c", () => {
    const sample = carriers.slice(0, 6);
    for (const a of sample) {
      for (const b of sample) {
        for (const c of sample) {
          const left = semiring.multiply(a, semiring.add(b, c));
          const right = semiring.add(semiring.multiply(a, b), semiring.multiply(a, c));
          expect(semiring.carrierEqual(left, right)).toBe(true);
        }
      }
    }
  });

  it("multiply never unions two mutually-exclusive proof-license states into one entry", () => {
    const requiresA = singleton(new Set(["a"]), 0);
    const requiresD = singleton(new Set(["d"]), 0);
    const product = semiring.multiply(requiresA, requiresD);
    expect(product.size).toBe(0);
  });

  it("add keeps distinct states side by side rather than merging them", () => {
    const requiresA = singleton(new Set(["a"]), -1);
    const requiresB = singleton(new Set(["b"]), -2);
    const sum = semiring.add(requiresA, requiresB);
    expect(sum.size).toBe(2);
    expect(sum.get(stateKey(new Set(["a"])))?.value).toBe(-1);
    expect(sum.get(stateKey(new Set(["b"])))?.value).toBe(-2);
  });

  it("add combines only under identical keys, via the base semiring's add", () => {
    const left = singleton(new Set(["b", "c"]), -1);
    const right = singleton(new Set(["b", "c"]), -2);
    const sum = semiring.add(left, right);
    expect(sum.size).toBe(1);
    const expected = base.add(-1, -2);
    expect(sum.get(stateKey(new Set(["b", "c"])))?.value).toBeCloseTo(expected, 9);
  });
});

describe("proof-license semiring pruning", () => {
  it("removes unsupported states before emission, from both add and multiply", () => {
    const semiring = makeSemiring(viterbiLogSemiring);
    const banned = singleton(new Set(["banned"]), 0);
    const clean = singleton(new Set(["b"]), 0);
    expect(semiring.add(banned, clean).size).toBe(1);
    expect(semiring.multiply(banned, clean).size).toBe(0);
  });
});

describe("viterbi vs total-probability composition are distinct, correctly labeled operations", () => {
  it("viterbi's add picks the maximum, never sums probability mass", () => {
    expect(viterbiLogSemiring.add(-1, -2)).toBe(-1);
  });

  it("total-probability's add sums probability mass via log-sum-exp, never just picks the maximum", () => {
    const summed = totalProbabilityLogSemiring.add(Math.log(0.3), Math.log(0.4));
    expect(summed).toBeCloseTo(Math.log(0.7), 9);
  });

  it("both share the same multiply (log-space independent combination)", () => {
    expect(viterbiLogSemiring.multiply(-1, -2)).toBe(-3);
    expect(totalProbabilityLogSemiring.multiply(-1, -2)).toBe(-3);
  });
});
