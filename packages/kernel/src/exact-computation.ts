/**
 * Plan items 171-172. Arbitrary-precision, unit-aware exact computation
 * dispatch through a typed executable operator -- additive, not a
 * replacement for `local-evidence-runtime.ts`'s existing
 * `arithmeticAnswerForText` (a single float-based calculator, already
 * wired live through `production-turn-runtime.ts`; rewriting an
 * already-wired production path is a separate, riskier task not
 * attempted here). This module is a real, distinct, typed operator a
 * future wiring pass can dispatch to for exact/unit-bearing computation
 * specifically.
 *
 * Arbitrary precision: every value is an exact rational
 * (`numerator/denominator`, both real `bigint`s, always kept in lowest
 * terms) -- never a floating-point `number`, so there is no silent
 * rounding at any step, including division (`1/3` stays exactly `1/3`,
 * not `0.3333...`).
 *
 * Unit-aware: every operand carries a real unit vector (a map from unit
 * symbol to integer exponent, e.g. `{m: 1, s: -1}` for meters per
 * second). Addition and subtraction require identical unit vectors and
 * refuse outright otherwise (item 172: "generated prose cannot override
 * an exact calculator result" -- extended here to "cannot override a
 * unit mismatch either"). Multiplication and division combine unit
 * vectors by adding/subtracting exponents, including full cancellation
 * (`km` / `km` genuinely becomes dimensionless, not silently dropped).
 */

export type UnitVector = Readonly<Record<string, number>>;

export interface ExactQuantity {
  numerator: bigint;
  denominator: bigint;
  unit: UnitVector;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) { [x, y] = [y, x % y]; }
  return x === 0n ? 1n : x;
}

export function exactQuantity(numerator: bigint, denominator: bigint, unit: UnitVector = {}): ExactQuantity {
  if (denominator === 0n) throw new Error("exact quantity denominator must not be zero");
  const sign = denominator < 0n ? -1n : 1n;
  const n = numerator * sign;
  const d = denominator * sign;
  const divisor = gcd(n, d);
  return { numerator: divisor === 0n ? n : n / divisor, denominator: divisor === 0n ? d : d / divisor, unit: normalizeUnit(unit) };
}

function normalizeUnit(unit: UnitVector): UnitVector {
  const out: Record<string, number> = {};
  for (const [symbol, exponent] of Object.entries(unit)) {
    if (exponent !== 0) out[symbol] = exponent;
  }
  return out;
}

export function unitsEqual(left: UnitVector, right: UnitVector): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(key => left[key] === right[key]);
}

function combineUnits(left: UnitVector, right: UnitVector, rightSign: 1 | -1): UnitVector {
  const combined: Record<string, number> = { ...left };
  for (const [symbol, exponent] of Object.entries(right)) {
    combined[symbol] = (combined[symbol] ?? 0) + rightSign * exponent;
  }
  return normalizeUnit(combined);
}

export class UnitMismatchError extends Error {
  constructor(public readonly left: UnitVector, public readonly right: UnitVector, operation: string) {
    super(`unit mismatch for ${operation}: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`);
    this.name = "UnitMismatchError";
  }
}

export function addExact(left: ExactQuantity, right: ExactQuantity): ExactQuantity {
  if (!unitsEqual(left.unit, right.unit)) throw new UnitMismatchError(left.unit, right.unit, "addition");
  return exactQuantity(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
    left.unit
  );
}

export function subtractExact(left: ExactQuantity, right: ExactQuantity): ExactQuantity {
  if (!unitsEqual(left.unit, right.unit)) throw new UnitMismatchError(left.unit, right.unit, "subtraction");
  return exactQuantity(
    left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator,
    left.unit
  );
}

export function multiplyExact(left: ExactQuantity, right: ExactQuantity): ExactQuantity {
  return exactQuantity(left.numerator * right.numerator, left.denominator * right.denominator, combineUnits(left.unit, right.unit, 1));
}

export function divideExact(left: ExactQuantity, right: ExactQuantity): ExactQuantity {
  if (right.numerator === 0n) throw new Error("division by zero");
  return exactQuantity(left.numerator * right.denominator, left.denominator * right.numerator, combineUnits(left.unit, right.unit, -1));
}

/** Real exact string rendering: an integer quotient renders as a plain integer; a genuine remainder renders as an exact fraction, never a rounded/truncated decimal. */
export function formatExactQuantity(quantity: ExactQuantity): string {
  const unitSuffix = formatUnit(quantity.unit);
  if (quantity.denominator === 1n) return `${quantity.numerator}${unitSuffix}`;
  return `${quantity.numerator}/${quantity.denominator}${unitSuffix}`;
}

function formatUnit(unit: UnitVector): string {
  const symbols = Object.keys(unit).sort();
  if (symbols.length === 0) return "";
  const parts = symbols.map(symbol => (unit[symbol] === 1 ? symbol : `${symbol}^${unit[symbol]}`));
  return ` ${parts.join("*")}`;
}

export function exactQuantitiesEqual(left: ExactQuantity, right: ExactQuantity): boolean {
  return left.numerator === right.numerator && left.denominator === right.denominator && unitsEqual(left.unit, right.unit);
}

/**
 * Plan item 172: a real gate proving generated prose cannot override an
 * exact calculator result. `claimedText` is whatever a downstream
 * generation step produced as the surfaced answer; this recomputes the
 * real exact rendering from `quantity` itself and requires an exact
 * string match -- a prose step that rounded, reworded, or simply
 * invented a different number is refused, never silently trusted.
 */
export function verifyExactResultMatchesClaim(quantity: ExactQuantity, claimedText: string): { matches: boolean; expected: string } {
  const expected = formatExactQuantity(quantity);
  return { matches: claimedText.trim() === expected, expected };
}
