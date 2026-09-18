// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  learnSignRoles,
  readWithRoles,
  rolesOf,
  wordModelOf,
  type LexicalEntry,
  type SignValues
} from "../visual-sign-roles.js";

// Two more jobs a sign can be doing, neither of them read off the picture. A determinative contributes no
// sound and no word of its own but is there because a particular word is -- Egyptian and Maya both use them,
// and Nahua manuscripts use semantic classifiers the same way. A picture that recurs with nothing in
// particular is not doing linguistic work at all. Both are learned from where the sign recurs, by comparison
// against chance rather than against a chosen threshold.

const HEADS: SignValues[] = [
  { sign: "RABBIT", word: "tochtli", sound: ["toch"] },
  { sign: "WATER", word: "atl", sound: ["a"] },
  { sign: "HILL", word: "tepetl", sound: ["te"] },
  // Neither of these names anything the lexicon has, and neither lends a usable sound.
  { sign: "DET", word: "not-a-word", sound: [] },
  { sign: "PIC", word: "not-a-word", sound: [] }
];

const LEXICON: LexicalEntry[] = [
  { word: "tochtli", spelling: ["toch"] },
  { word: "atl", spelling: ["a"] },
  { word: "tepetl", spelling: ["te"] }
];

const MODEL = wordModelOf([
  ["tochtli", "atl", "tepetl"],
  ["atl", "tochtli", "atl"],
  ["tepetl", "atl", "tochtli"],
  ["tochtli", "tepetl", "atl"],
  ["atl", "tepetl", "tochtli"],
  ["tochtli", "atl", "tochtli"]
]);

/** DET always stands after tochtli. PIC turns up after whatever happens to precede it. */
const PAGE = [
  ["RABBIT", "DET", "WATER"],
  ["WATER", "RABBIT", "DET"],
  ["RABBIT", "DET", "HILL"],
  ["WATER", "PIC", "RABBIT", "DET"],
  ["HILL", "PIC", "WATER"],
  ["RABBIT", "PIC", "HILL"],
  ["RABBIT", "DET", "WATER", "PIC"]
];

describe("signs that carry no sound: indicators of a word, and pictures outside the text", () => {
  it("learns which sign is there because of a word, and which is there for itself", () => {
    const learned = learnSignRoles(PAGE, HEADS, LEXICON, MODEL);
    // DET recurs with tochtli far more than that word's own share of the text would put it there.
    expect(learned.indicators.get("DET")?.word).toBe("tochtli");
    expect(learned.indicators.get("DET")!.share).toBeGreaterThan(0.5);
    // PIC recurs with nothing in particular, so it is not doing linguistic work.
    expect(learned.iconographic.has("PIC")).toBe(true);
    expect(learned.indicators.has("PIC")).toBe(false);
  });

  it("reads a determinative as belonging to its word rather than as a failure", () => {
    const learned = learnSignRoles(PAGE, HEADS, LEXICON, MODEL);
    const signs = ["RABBIT", "DET", "WATER"];
    const reading = readWithRoles(signs, HEADS, LEXICON, MODEL, learned);
    // The words are unchanged: a determinative adds no word of its own.
    expect(reading.words.map(word => word.word)).toEqual(["tochtli", "atl"]);
    // And the sign is accounted for, as an indicator of the word it accompanies.
    expect(reading.unreadable).toBe(0);
    expect(reading.annotations).toEqual([{ index: 1, role: "indicator", word: "tochtli" }]);
    expect(rolesOf(reading, signs.length)).toEqual(["logogram", "indicator", "logogram"]);
  });

  it("reads a picture outside the text as exactly that", () => {
    const learned = learnSignRoles(PAGE, HEADS, LEXICON, MODEL);
    const signs = ["WATER", "PIC", "RABBIT"];
    const reading = readWithRoles(signs, HEADS, LEXICON, MODEL, learned);
    expect(reading.words.map(word => word.word)).toEqual(["atl", "tochtli"]);
    expect(reading.annotations).toEqual([{ index: 1, role: "iconographic" }]);
    expect(reading.unreadable).toBe(0);
  });

  it("does not read an indicator where its word is not what precedes it", () => {
    const learned = learnSignRoles(PAGE, HEADS, LEXICON, MODEL);
    // DET after atl, not after tochtli. It is not standing where an indicator of tochtli can stand, so it is
    // not read as one: a role is about where a sign is, not about which sign it is.
    const reading = readWithRoles(["WATER", "DET"], HEADS, LEXICON, MODEL, learned);
    expect(reading.annotations.some(annotation => annotation.role === "indicator")).toBe(false);
    expect(reading.words.map(word => word.word)).toEqual(["atl"]);
  });

  it("accounts for nothing it has not learned about, rather than guessing a role", () => {
    // Without the learning pass the same signs are simply unread, which is the honest state.
    const reading = readWithRoles(["RABBIT", "DET", "WATER"], HEADS, LEXICON, MODEL);
    expect(reading.annotations).toHaveLength(0);
    expect(reading.unreadable).toBe(1);
  });
});
