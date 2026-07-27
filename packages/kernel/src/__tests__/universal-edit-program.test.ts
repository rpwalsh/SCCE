import { describe, expect, it } from "vitest";
import { applyEditProgram, induceEditProgram, type EditOperationKind } from "../universal-edit-program.js";

function kinds(source: string, target: string): EditOperationKind[] {
  return induceEditProgram(source, target).map(op => op.kind);
}

describe("universal edit-program induction: base COPY/INSERT/DELETE/SUBSTITUTE (plan item 98)", () => {
  it("induces a single null op for identical strings", () => {
    expect(kinds("hello", "hello")).toEqual(["null"]);
    expect(applyEditProgram("hello", induceEditProgram("hello", "hello"))).toBe("hello");
  });

  it("induces copy + insert for a pure suffix addition, and round-trips exactly", () => {
    const ops = induceEditProgram("walk", "walked");
    expect(ops.map(op => op.kind)).toEqual(["copy", "insert"]);
    expect(applyEditProgram("walk", ops)).toBe("walked");
  });

  it("induces insert + copy for a pure prefix addition, and round-trips exactly", () => {
    const ops = induceEditProgram("happy", "unhappy");
    expect(ops.map(op => op.kind)).toEqual(["insert", "copy"]);
    expect(applyEditProgram("happy", ops)).toBe("unhappy");
  });

  it("induces a substitution for a single-character change, and round-trips exactly", () => {
    const ops = induceEditProgram("cat", "car");
    expect(ops.some(op => op.kind === "substitute")).toBe(true);
    expect(applyEditProgram("cat", ops)).toBe("car");
  });

  it("induces a pure delete for a suffix removal, and round-trips exactly", () => {
    const ops = induceEditProgram("walked", "walk");
    expect(ops.map(op => op.kind)).toEqual(["copy", "delete"]);
    expect(applyEditProgram("walked", ops)).toBe("walk");
  });
});

describe("MOVE and REPEAT detection are real structural conditions, not asserted (plan item 98)", () => {
  it("detects a move when a deleted run's exact text reappears in an inserted run elsewhere", () => {
    const ops = induceEditProgram("XYabc", "abcXY");
    expect(ops.some(op => op.kind === "move")).toBe(true);
    expect(applyEditProgram("XYabc", ops)).toBe("abcXY");
  });

  it("detects a repeat when an inserted run duplicates its adjacent copied run, on either side", () => {
    // The minimum-edit-distance alignment for a reduplication like this
    // has two equally-optimal-cost forms (copy-then-insert-identical, or
    // insert-then-copy-identical); which one the DP's tie-breaking
    // produces is not a caller-visible contract, only that the repeat is
    // correctly recognized and the round-trip is correct either way.
    const ops = induceEditProgram("run", "runrun");
    expect(ops.map(op => op.kind).sort()).toEqual(["copy", "repeat"]);
    expect(applyEditProgram("run", ops)).toBe("runrun");
  });

  it("does not fabricate a move for a deleted run with no matching inserted text anywhere", () => {
    const ops = induceEditProgram("walked", "walk");
    expect(ops.some(op => op.kind === "move")).toBe(false);
  });
});

describe("JOIN/SPLIT reclassification for single boundary characters (plan item 98)", () => {
  it("reclassifies a deleted single boundary character as a join", () => {
    const ops = induceEditProgram("ice-cream", "icecream");
    expect(ops.some(op => op.kind === "join")).toBe(true);
    expect(applyEditProgram("ice-cream", ops)).toBe("icecream");
  });

  it("reclassifies an inserted single boundary character as a split", () => {
    const ops = induceEditProgram("icecream", "ice-cream");
    expect(ops.some(op => op.kind === "split")).toBe(true);
    expect(applyEditProgram("icecream", ops)).toBe("ice-cream");
  });

  it("does not reclassify a multi-character deletion as a join even if it contains a boundary character", () => {
    const ops = induceEditProgram("ice-cream-cake", "cake");
    expect(ops.some(op => op.kind === "join")).toBe(false);
  });
});

describe("held-out productivity: an induced program generalizes to a different source (plan item 99)", () => {
  it("a program induced from one word pair applies its structural pattern to a held-out word of the same shape", () => {
    // Induce the "-ed" suffix pattern from one real example pair.
    const ops = induceEditProgram("walk", "walked");
    // Apply the SAME induced program (unmodified) to a different,
    // held-out source that shares the same copy/insert structure --
    // real generalization, not replaying the original pair.
    expect(applyEditProgram("jump", ops)).toBe("jumped");
    expect(applyEditProgram("play", ops)).toBe("played");
  });

  it("a prefix-insertion program generalizes to a different held-out stem", () => {
    const ops = induceEditProgram("happy", "unhappy");
    expect(applyEditProgram("kind", ops)).toBe("unkind");
    expect(applyEditProgram("clear", ops)).toBe("unclear");
  });

  it("copy operations read from the held-out source's own content, not the original induction pair's literal text", () => {
    // If copy replayed the original literal text instead of reading the
    // new source, applying "cook"->"cooked"'s program to "look" would
    // wrongly produce "cooked" (the original copied text) instead of
    // "looked". ("bake" is deliberately avoided here: English elides the
    // stem's silent "e" before "-ed" -- "bake"+"d"="baked", not
    // "bake"+"ed" -- which is a real orthographic exception a purely
    // positional copy+insert program has no way to know about, not a bug
    // in this mechanism.)
    const ops = induceEditProgram("cook", "cooked");
    expect(applyEditProgram("look", ops)).toBe("looked");
  });
});
