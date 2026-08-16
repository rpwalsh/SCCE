import { describe, expect, it } from "vitest";
import {
  addExact,
  divideExact,
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
