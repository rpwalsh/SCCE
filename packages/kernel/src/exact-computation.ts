// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
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

import type { JsonValue } from "./types.js";

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
  // The gate compares the claim against this rendering, so the rendering has to be trustworthy. Parsing it back and
  // requiring the same quantity checks that `formatExactQuantity` and the parser still agree; if they ever diverge,
  // every claim would be measured against a string that no longer means the number it came from. The string match
  // below is unchanged and still required -- this only refuses when the expected text itself cannot be trusted.
  const roundTrip = parseExactExpression(expected);
  if (roundTrip && !exactQuantitiesEqual(roundTrip.value, quantity)) return { matches: false, expected };
  return { matches: claimedText.trim() === expected, expected };
}

export interface ExactComputationEvaluation {
  expression: string;
  result: ExactQuantity;
  resultText: string;
  answer: string;
  audit: JsonValue;
}

/**
 * Plan item 171's real text-recognition + dispatch half: finds a genuine
 * unit-bearing arithmetic expression in request text and evaluates it
 * exactly. Deliberately distinct from local-evidence-runtime.ts's
 * arithmeticAnswerForText (see this file's header): only fires when a
 * real unit token is present on at least one operand -- plain unitless
 * arithmetic stays on the existing float path unchanged, so this never
 * competes with or shadows that already-wired production route. A
 * mismatched-unit addition/subtraction (`5 km + 3 kg`) is refused
 * outright (returns undefined), never silently coerced or dropped.
 */
export function exactComputationForText(text: string): ExactComputationEvaluation | undefined {
  for (const candidate of exactExpressionCandidates(text)) {
    const parsed = parseExactExpression(candidate);
    if (!parsed || !parsed.hasUnit) continue;
    const resultText = formatExactQuantity(parsed.value);
    return {
      expression: candidate,
      result: parsed.value,
      resultText,
      answer: `${candidate} = ${resultText}.`,
      audit: {
        source: "kernel.turn.deterministic_exact_computation",
        expression: candidate,
        resultText,
        unit: { ...parsed.value.unit }
      }
    };
  }
  return undefined;
}

// Matches a "term" (an optionally-signed number with an optional unit
// suffix, e.g. "5kg", "-3.5m", optionally in a single non-nested paren
// pair) followed by one or more (operator, term) groups. A real regex
// scan, not char-class segmentation: this is what lets a genuine
// expression be found and cleanly isolated wherever it appears inside
// ordinary prose ("...holds 5kg+3kg of material...") without swallowing
// surrounding words into a bogus "unit" token the way naive segmentation
// on letter/digit/operator characters would (a stray word like "holds" or
// "of" sitting between two numbers is not part of the match at all, since
// it does not fit the term/operator grammar).
const EXACT_TERM = "\\(?[+-]?\\d+(?:\\.\\d+)?[a-zA-Z]*\\)?";
const EXACT_EXPRESSION_PATTERN = new RegExp(`${EXACT_TERM}(?:\\s*[+\\-*/^]\\s*${EXACT_TERM})+`, "gu");

function exactExpressionCandidates(text: string): string[] {
  const matches = text.match(EXACT_EXPRESSION_PATTERN) ?? [];
  return matches
    .map(match => match.trim().slice(0, 160))
    .filter(candidate => /\d[a-zA-Z]+/u.test(candidate.replace(/\s+/gu, "")))
    .sort((left, right) => right.length - left.length);
}

interface ExactToken {
  kind: "number" | "unit" | "operator" | "left" | "right";
  value: string;
}

function tokenizeExactExpression(expression: string): ExactToken[] | undefined {
  const tokens: ExactToken[] = [];
  const compact = expression.replace(/\s+/gu, "");
  for (let index = 0; index < compact.length;) {
    const char = compact[index];
    if (char === undefined) return undefined;
    if ((char >= "0" && char <= "9") || char === ".") {
      let end = index + 1;
      while (end < compact.length) {
        const next = compact[end];
        if (next === undefined || !((next >= "0" && next <= "9") || next === ".")) break;
        end++;
      }
      const raw = compact.slice(index, end);
      if (!/^\d+(?:\.\d+)?$|^\.\d+$/u.test(raw)) return undefined;
      tokens.push({ kind: "number", value: raw });
      index = end;
      continue;
    }
    if ((char >= "a" && char <= "z") || (char >= "A" && char <= "Z")) {
      let end = index + 1;
      while (end < compact.length) {
        const next = compact[end];
        if (next === undefined || !((next >= "a" && next <= "z") || (next >= "A" && next <= "Z"))) break;
        end++;
      }
      tokens.push({ kind: "unit", value: compact.slice(index, end) });
      index = end;
      continue;
    }
    if ("+-*/^".includes(char)) {
      tokens.push({ kind: "operator", value: char });
      index++;
      continue;
    }
    if (char === "(") { tokens.push({ kind: "left", value: char }); index++; continue; }
    if (char === ")") { tokens.push({ kind: "right", value: char }); index++; continue; }
    return undefined;
  }
  return tokens;
}

/** Real decimal-string-to-exact-rational parse: `1.25` becomes exactly `125/100` (reduced to `5/4`), never an approximated float. */
function exactQuantityFromDecimalLiteral(literal: string, unit: UnitVector): ExactQuantity {
  const [wholePart, fractionPart = ""] = literal.split(".");
  const denominator = 10n ** BigInt(fractionPart.length);
  const numerator = BigInt(`${wholePart || "0"}${fractionPart}`);
  return exactQuantity(numerator, denominator, unit);
}

function parseExactExpression(raw: string): { value: ExactQuantity; hasUnit: boolean } | undefined {
  const tokens = tokenizeExactExpression(raw);
  if (!tokens?.length) return undefined;
  let position = 0;
  let operatorCount = 0;
  let numberCount = 0;
  let sawUnit = false;
  const peek = (): ExactToken | undefined => tokens[position];
  const fail = (): never => { throw new Error("invalid exact expression"); };
  const consume = (): ExactToken => {
    const token = tokens[position];
    if (!token) return fail();
    position++;
    return token;
  };
  const parseExpression = (): ExactQuantity => parseAdditive();
  const parseAdditive = (): ExactQuantity => {
    let left = parseMultiplicative();
    while (peek()?.kind === "operator" && (peek()?.value === "+" || peek()?.value === "-")) {
      const operator = consume().value;
      const right = parseMultiplicative();
      operatorCount++;
      try {
        left = operator === "+" ? addExact(left, right) : subtractExact(left, right);
      } catch {
        fail();
      }
    }
    return left;
  };
  const parseMultiplicative = (): ExactQuantity => {
    let left = parseUnary();
    while (peek()?.kind === "operator" && (peek()?.value === "*" || peek()?.value === "/")) {
      const operator = consume().value;
      const right = parseUnary();
      operatorCount++;
      left = operator === "*" ? multiplyExact(left, right) : divideExact(left, right);
    }
    return left;
  };
  const parseUnary = (): ExactQuantity => {
    if (peek()?.kind === "operator" && (peek()?.value === "+" || peek()?.value === "-")) {
      const operator = consume().value;
      const value = parseUnary();
      return operator === "-" ? exactQuantity(-value.numerator, value.denominator, value.unit) : value;
    }
    return parsePrimary();
  };
  const parsePrimary = (): ExactQuantity => {
    const token = consume();
    if (!token) return fail();
    if (token.kind === "number") {
      numberCount++;
      let unit: UnitVector = {};
      if (peek()?.kind === "unit") {
        sawUnit = true;
        unit = { [consume().value]: 1 };
      }
      return exactQuantityFromDecimalLiteral(token.value, unit);
    }
    if (token.kind === "left") {
      const value = parseExpression();
      if (peek()?.kind !== "right") return fail();
      consume();
      return value;
    }
    return fail();
  };
  try {
    const value = parseExpression();
    if (position !== tokens.length || operatorCount < 1 || numberCount < 2) return undefined;
    return { value, hasUnit: sawUnit };
  } catch {
    return undefined;
  }
}
