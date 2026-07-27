/**
 * Plan items 133-135. A proof-license product semiring: the carrier is a
 * finite map from proof-license state to a base-semiring value. This is the
 * algebraic core a packed derivation-forest chart needs so that combining
 * two subderivations never silently merges mutually-exclusive proof
 * licenses into one (illegitimate) derivation, and never double-counts two
 * derivations that happen to license the same final state.
 *
 * - `multiply` (combine two subderivations into a larger one): for every
 *   pair of entries from the left and right operand, unions their states.
 *   Incompatible pairs (`unionStates` returns `undefined`) contribute
 *   nothing -- they are not multiplied together at all, not multiplied to
 *   zero. Entries whose union lands on the same resulting state are then
 *   combined via the base semiring's `add` (this is ordinary like-term
 *   collection under polynomial-style multiplication, not a separate rule).
 * - `add` (alternative derivations of the same node): combines values only
 *   under identical state keys; entries under different keys are kept side
 *   by side, never merged.
 * - Unsupported states (`isSupported` false, or a `zero`-valued entry) are
 *   pruned before the carrier is returned from either operation.
 */

export interface BaseSemiring<V> {
  zero: V;
  one: V;
  add(left: V, right: V): V;
  multiply(left: V, right: V): V;
  /** Approximate equality, used only by property tests (floating point is not exactly associative). */
  approxEqual(left: V, right: V): boolean;
}

const LOG_APPROX_EPSILON = 1e-9;

function logApproxEqual(left: number, right: number): boolean {
  if (left === right) return true;
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return Math.abs(left - right) <= LOG_APPROX_EPSILON * Math.max(1, Math.abs(left), Math.abs(right));
}

function logSumExp(left: number, right: number): number {
  if (left === Number.NEGATIVE_INFINITY) return right;
  if (right === Number.NEGATIVE_INFINITY) return left;
  const maximum = Math.max(left, right);
  return maximum + Math.log(Math.exp(left - maximum) + Math.exp(right - maximum));
}

/**
 * Viterbi (best-derivation) composition: `add` picks the better of two
 * alternatives via `max`, `multiply` accumulates log-score via `+`. Never
 * conflate this with `totalProbabilityLogSemiring` below -- they answer
 * different questions (best single derivation vs. total probability mass
 * over every derivation) and must stay two distinct, separately-labeled
 * base semirings, per plan item 135.
 */
export const viterbiLogSemiring: BaseSemiring<number> = {
  zero: Number.NEGATIVE_INFINITY,
  one: 0,
  add: (left, right) => Math.max(left, right),
  multiply: (left, right) => (left === Number.NEGATIVE_INFINITY || right === Number.NEGATIVE_INFINITY
    ? Number.NEGATIVE_INFINITY
    : left + right),
  approxEqual: logApproxEqual
};

/**
 * Total-probability composition: `add` is `log-sum-exp` (sums probability
 * mass across alternatives), `multiply` is `+` in log space (independent
 * evidence combination). See `viterbiLogSemiring`'s doc comment for why
 * these must never be conflated.
 */
export const totalProbabilityLogSemiring: BaseSemiring<number> = {
  zero: Number.NEGATIVE_INFINITY,
  one: 0,
  add: logSumExp,
  multiply: (left, right) => (left === Number.NEGATIVE_INFINITY || right === Number.NEGATIVE_INFINITY
    ? Number.NEGATIVE_INFINITY
    : left + right),
  approxEqual: logApproxEqual
};

export interface ProofLicenseCarrierEntry<S> {
  state: S;
  value: number;
}

/** A finite map from proof-license state (by its canonical key) to a base-semiring value. */
export type ProofLicenseCarrier<S> = ReadonlyMap<string, ProofLicenseCarrierEntry<S>>;

export interface ProofLicenseSemiringOptions<S> {
  base: BaseSemiring<number>;
  /** Canonical string key for a state -- two states with the same key are the same proof license. */
  stateKey(state: S): string;
  /** The state carrying no proof obligations at all -- the identity element's state. */
  emptyState: S;
  /**
   * Unions two proof-license states into the state a combined derivation
   * would carry. Returns `undefined` when the two states are mutually
   * exclusive (e.g. one requires an atom the other requires absent) -- an
   * incompatible pair contributes nothing to the product, it is never
   * multiplied in as a zero-valued entry.
   */
  unionStates(left: S, right: S): S | undefined;
  /** False for a state that is no longer a legitimate proof license (e.g. it lost its last supporting evidence) -- pruned before emission. */
  isSupported(state: S): boolean;
}

export interface ProofLicenseSemiring<S> {
  zero: ProofLicenseCarrier<S>;
  one: ProofLicenseCarrier<S>;
  add(left: ProofLicenseCarrier<S>, right: ProofLicenseCarrier<S>): ProofLicenseCarrier<S>;
  multiply(left: ProofLicenseCarrier<S>, right: ProofLicenseCarrier<S>): ProofLicenseCarrier<S>;
  /** Removes zero-valued and unsupported entries -- exposed so callers can prune a carrier built by other means. */
  prune(carrier: ProofLicenseCarrier<S>): ProofLicenseCarrier<S>;
  /** Structural equality up to the base semiring's approximate value equality -- for tests and dedup, not hot paths. */
  carrierEqual(left: ProofLicenseCarrier<S>, right: ProofLicenseCarrier<S>): boolean;
}

export function createProofLicenseSemiring<S>(options: ProofLicenseSemiringOptions<S>): ProofLicenseSemiring<S> {
  const { base, stateKey, emptyState, unionStates, isSupported } = options;

  function prune(carrier: ProofLicenseCarrier<S>): ProofLicenseCarrier<S> {
    const out = new Map<string, ProofLicenseCarrierEntry<S>>();
    for (const [key, entry] of carrier) {
      if (entry.value === base.zero) continue;
      if (!isSupported(entry.state)) continue;
      out.set(key, entry);
    }
    return out;
  }

  const zero: ProofLicenseCarrier<S> = new Map();
  const one: ProofLicenseCarrier<S> = prune(new Map([[stateKey(emptyState), { state: emptyState, value: base.one }]]));

  function add(left: ProofLicenseCarrier<S>, right: ProofLicenseCarrier<S>): ProofLicenseCarrier<S> {
    const out = new Map<string, ProofLicenseCarrierEntry<S>>();
    for (const [key, entry] of left) out.set(key, entry);
    for (const [key, entry] of right) {
      const existing = out.get(key);
      out.set(key, existing
        ? { state: existing.state, value: base.add(existing.value, entry.value) }
        : entry);
    }
    return prune(out);
  }

  function multiply(left: ProofLicenseCarrier<S>, right: ProofLicenseCarrier<S>): ProofLicenseCarrier<S> {
    const out = new Map<string, ProofLicenseCarrierEntry<S>>();
    for (const leftEntry of left.values()) {
      for (const rightEntry of right.values()) {
        const unioned = unionStates(leftEntry.state, rightEntry.state);
        if (unioned === undefined) continue;
        const key = stateKey(unioned);
        const value = base.multiply(leftEntry.value, rightEntry.value);
        const existing = out.get(key);
        out.set(key, existing
          ? { state: existing.state, value: base.add(existing.value, value) }
          : { state: unioned, value });
      }
    }
    return prune(out);
  }

  function carrierEqual(left: ProofLicenseCarrier<S>, right: ProofLicenseCarrier<S>): boolean {
    if (left.size !== right.size) return false;
    for (const [key, entry] of left) {
      const other = right.get(key);
      if (!other || !base.approxEqual(entry.value, other.value)) return false;
    }
    return true;
  }

  return { zero, one, add, multiply, prune, carrierEqual };
}
