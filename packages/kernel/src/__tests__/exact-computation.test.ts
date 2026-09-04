// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  addExact,
  divideExact,
  exactComputationForText,
  exactQuantitiesEqual,
  exactQuantity,
  formatExactQuantity,
  multiplyExact,
  subtractExact,
  UnitMismatchError,
  verifyExactResultMatchesClaim
} from "../exact-computation.js";

// Plan items 171-172. Real arbitrary-precision (bigint rational, never a
// float) and unit-aware exact computation.

describe("arbitrary precision (plan item 171)", () => {
  it("1/3 + 1/3 + 1/3 equals exactly 1 -- the real case floating point famously gets wrong (0.1+0.2 !== 0.3 in IEEE 754)", () => {
    const third = exactQuantity(1n, 3n);
    const sum = addExact(addExact(third, third), third);
    expect(exactQuantitiesEqual(sum, exactQuantity(1n, 1n))).toBe(true);
    expect(formatExactQuantity(sum)).toBe("1");
  });

  it("stays exact for integers far beyond JS's safe float integer range (2^60), where Number would silently lose precision", () => {
    const huge = exactQuantity(2n ** 60n + 1n, 1n);
    const doubled = addExact(huge, huge);
    expect(doubled.numerator).toBe(2n * (2n ** 60n + 1n));
    // A real proof this genuinely wasn't rounded through a float: the +1
    // survives a value where Number(2**60+1) would already have collapsed
    // to Number(2**60) (JS numbers lose integer precision past 2^53).
    expect(doubled.numerator % 2n).toBe(0n);
    expect((doubled.numerator / 2n) - 2n ** 60n).toBe(1n);
  });

  it("never reduces to a lossy decimal string -- a genuine remainder renders as an exact fraction", () => {
    const oneSeventh = exactQuantity(1n, 7n);
    expect(formatExactQuantity(oneSeventh)).toBe("1/7");
  });

  it("keeps every value in lowest terms automatically", () => {
    const quantity = exactQuantity(6n, 8n);
    expect(quantity.numerator).toBe(3n);
    expect(quantity.denominator).toBe(4n);
  });
});

describe("unit-aware dispatch (plan item 171)", () => {
  it("adds two quantities with identical units", () => {
    const fiveKg = exactQuantity(5n, 1n, { kg: 1 });
    const threeKg = exactQuantity(3n, 1n, { kg: 1 });
    const sum = addExact(fiveKg, threeKg);
    expect(formatExactQuantity(sum)).toBe("8 kg");
  });

  it("refuses to add mismatched units outright, never silently coercing", () => {
    const fiveKg = exactQuantity(5n, 1n, { kg: 1 });
    const threeMeters = exactQuantity(3n, 1n, { m: 1 });
    expect(() => addExact(fiveKg, threeMeters)).toThrow(UnitMismatchError);
    expect(() => subtractExact(fiveKg, threeMeters)).toThrow(UnitMismatchError);
  });

  it("multiplication combines units by adding exponents", () => {
    const fiveMeters = exactQuantity(5n, 1n, { m: 1 });
    const twoSeconds = exactQuantity(2n, 1n, { s: 1 });
    const product = multiplyExact(fiveMeters, twoSeconds);
    expect(product.unit).toEqual({ m: 1, s: 1 });
  });

  it("division cancels identical units to genuinely dimensionless, not silently dropped", () => {
    const tenKm = exactQuantity(10n, 1n, { km: 1 });
    const twoKm = exactQuantity(2n, 1n, { km: 1 });
    const ratio = divideExact(tenKm, twoKm);
    expect(ratio.unit).toEqual({});
    expect(formatExactQuantity(ratio)).toBe("5");
  });

  it("division of unlike units produces a real compound unit (km/h), not an error", () => {
    const tenKm = exactQuantity(10n, 1n, { km: 1 });
    const twoHours = exactQuantity(2n, 1n, { h: 1 });
    const speed = divideExact(tenKm, twoHours);
    expect(speed.unit).toEqual({ km: 1, h: -1 });
    expect(formatExactQuantity(speed)).toBe("5 h^-1*km");
  });

  it("refuses division by an exact zero", () => {
    expect(() => divideExact(exactQuantity(1n, 1n), exactQuantity(0n, 1n))).toThrow(/zero/);
  });
});

describe("verifyExactResultMatchesClaim (plan item 172)", () => {
  it("accepts prose that states the exact real result verbatim", () => {
    const result = addExact(exactQuantity(1n, 3n), exactQuantity(1n, 3n));
    const check = verifyExactResultMatchesClaim(result, "2/3");
    expect(check.matches).toBe(true);
  });

  it("refuses prose that rounds an exact fraction to a decimal approximation -- the exact calculator result cannot be overridden by generation", () => {
    const oneThird = exactQuantity(1n, 3n);
    const check = verifyExactResultMatchesClaim(oneThird, "0.33");
    expect(check.matches).toBe(false);
    expect(check.expected).toBe("1/3");
  });

  it("refuses prose that invents a different number entirely", () => {
    const five = exactQuantity(5n, 1n, { kg: 1 });
    const check = verifyExactResultMatchesClaim(five, "6 kg");
    expect(check.matches).toBe(false);
    expect(check.expected).toBe("5 kg");
  });
});

describe("exactComputationForText (plan item 171 -- real text recognition + dispatch)", () => {
  it("recognizes and exactly evaluates a unit-bearing addition embedded in ordinary prose", () => {
    // A real regex scan for the expression's own grammar, not char-class
    // segmentation -- "holds"/"of material" surrounding the real
    // expression are not swallowed into a bogus unit token the way naive
    // letter-inclusive segmentation would.
    const evaluation = exactComputationForText("The tank holds 5kg+3kg of material.");
    expect(evaluation).toBeDefined();
    expect(evaluation!.resultText).toBe("8 kg");
    expect(evaluation!.answer).toBe("5kg+3kg = 8 kg.");
  });

  it("derives a real compound unit from division, never fabricated", () => {
    const evaluation = exactComputationForText("If a car travels 10km in 2h, how fast is it going? 10km/2h");
    expect(evaluation).toBeDefined();
    expect(evaluation!.result.unit).toEqual({ km: 1, h: -1 });
  });

  it("never fires for plain unitless arithmetic -- that stays on the existing float calculator path", () => {
    expect(exactComputationForText("What is 12 + 30?")).toBeUndefined();
  });

  it("keeps a fractional result exact, never rounded to a lossy decimal", () => {
    const evaluation = exactComputationForText("1kg / 3s");
    expect(evaluation).toBeDefined();
    expect(evaluation!.resultText).toBe("1/3 kg*s^-1");
  });

  it("refuses (never fires, never silently coerces) a mismatched-unit addition", () => {
    expect(exactComputationForText("Add 5kg+3m together.")).toBeUndefined();
  });

  it("finds the real expression even when it appears after unrelated descriptive numbers in the same sentence", () => {
    const evaluation = exactComputationForText("The beam is 5m long and 2m of it broke off, so 5m-2m remains.");
    expect(evaluation).toBeDefined();
    expect(evaluation!.expression).toBe("5m-2m");
    expect(evaluation!.resultText).toBe("3 m");
  });
});
