// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  readWithRoles,
  roleEvidence,
  rolesOf,
  wordModelOf,
  type LexicalEntry,
  type SignValues
} from "../visual-sign-roles.js";

// The claim: the same picture can name what it shows in one place and lend only its sound in another, and which
// it is doing is inferred from what explanation it permits there -- never from the picture. Nothing in the code
// under test knows what a rabbit looks like, or that rabbits are animals, or that place names exist.
//
// The case is the one Nahua scholarship gives: a rabbit sign contributes "toch" and a teeth sign contributes
// "tlan", and together they write the place name Tochtlan, which is not about rabbits or teeth. The same rabbit
// sign elsewhere on the page means a rabbit.

const SIGNS: SignValues[] = [
  // Each sign names a thing, and lends that thing's name as sound.
  { sign: "RABBIT", word: "tochtli", sound: ["toch", "tli"] },
  { sign: "TEETH", word: "tlantli", sound: ["tlan", "tli"] },
  { sign: "WATER", word: "atl", sound: ["a", "tl"] },
  { sign: "HILL", word: "tepetl", sound: ["te", "petl"] },
  { sign: "STONE", word: "tetl", sound: ["te", "tl"] }
];

/**
 * A rebus needs the sign's leading sound, not its whole name, so the signs are also given their heads. This is
 * the acrophonic use: the first sound of the thing's name. It is supplied as data, not inferred here.
 */
const HEADS: SignValues[] = [
  { sign: "RABBIT", word: "tochtli", sound: ["toch"] },
  { sign: "TEETH", word: "tlantli", sound: ["tlan"] },
  { sign: "WATER", word: "atl", sound: ["a"] },
  { sign: "HILL", word: "tepetl", sound: ["te"] },
  { sign: "STONE", word: "tetl", sound: ["te"] }
];

const LEXICON: LexicalEntry[] = [
  { word: "tochtli", spelling: ["toch", "tli"] },
  { word: "tlantli", spelling: ["tlan", "tli"] },
  { word: "atl", spelling: ["a", "tl"] },
  { word: "tepetl", spelling: ["te", "petl"] },
  { word: "tetl", spelling: ["te", "tl"] },
  // Place names, spelled across two signs each, and about neither of the things those signs show.
  { word: "tochtlan", spelling: ["toch", "tlan"] },
  { word: "atetl", spelling: ["a", "te", "tl"] },
  { word: "tetlan", spelling: ["te", "tlan"] }
];

/** Text of the known language: the words, in sentences, as the language was ingested. */
const SPOKEN = [
  ["tochtli", "atl", "tepetl"],
  ["tochtlan", "atl", "tochtli"],
  ["atl", "tochtlan", "tepetl"],
  ["tetlan", "tochtli", "atl"],
  ["tochtlan", "tepetl", "atl"],
  ["tochtli", "tetl", "tochtlan"],
  ["atetl", "tochtli", "tepetl"],
  ["tochtlan", "tochtli", "atl"]
];
const MODEL = wordModelOf(SPOKEN);

describe("inferring what job a picture is doing, never from the picture", () => {
  it("reads a sign alone as the thing it shows", () => {
    // A rabbit on its own, then water: two logograms, no rebus needed to explain them.
    const reading = readWithRoles(["RABBIT", "WATER"], HEADS, LEXICON, MODEL);
    expect(reading.words.map(word => word.word)).toEqual(["tochtli", "atl"]);
    expect(reading.words.map(word => word.role)).toEqual(["logogram", "logogram"]);
    expect(reading.unreadable).toBe(0);
  });

  it("reads a rabbit and teeth together as a place name that is about neither", () => {
    const reading = readWithRoles(["RABBIT", "TEETH"], HEADS, LEXICON, MODEL);
    // Taken for their meanings these two signs are "rabbit teeth", which the language never says; taken for
    // their sounds they spell a word it does. So that is what they are doing.
    expect(reading.words).toHaveLength(1);
    expect(reading.words[0]!.word).toBe("tochtlan");
    expect(reading.words[0]!.role).toBe("phonogram");
    expect(reading.words[0]!.signs).toEqual([0, 1]);
  });

  it("lets one sign play both parts in the same line", () => {
    // RABBIT TEETH spells the place name; the RABBIT after it means a rabbit.
    const signs = ["RABBIT", "TEETH", "RABBIT", "WATER"];
    const reading = readWithRoles(signs, HEADS, LEXICON, MODEL);
    expect(reading.words.map(word => word.word)).toEqual(["tochtlan", "tochtli", "atl"]);
    const roles = rolesOf(reading, signs.length);
    // The first rabbit lent its sound; the second named itself. Same picture, different job, one line.
    expect(roles[0]).toBe("phonogram");
    expect(roles[1]).toBe("phonogram");
    expect(roles[2]).toBe("logogram");
    expect(roles[3]).toBe("logogram");
  });

  it("prefers the reading that is shorter to describe, whichever way that falls", () => {
    // STONE and TEETH could be two words or one spelled across both. Neither sign's own word is common here
    // and "tetlan" is, so the joint reading wins and the pair is one place name.
    const joint = readWithRoles(["STONE", "TEETH"], HEADS, LEXICON, MODEL);
    expect(joint.words).toHaveLength(1);
    expect(joint.words[0]!.word).toBe("tetlan");

    // WATER and STONE could spell "atetl", but read as themselves they are two words the language uses far
    // more often, and that reading is shorter to describe. So it is taken -- description length decides, and
    // it does not simply prefer to merge. A rebus is not assumed wherever one is possible.
    const apart = readWithRoles(["WATER", "STONE"], HEADS, LEXICON, MODEL);
    expect(apart.words.map(word => word.word)).toEqual(["atl", "tetl"]);
    expect(apart.words.map(word => word.role)).toEqual(["logogram", "logogram"]);
    expect(apart.cost).toBeLessThan(
      readWithRoles(["WATER", "STONE"], HEADS, LEXICON.filter(e => e.word !== "atl" && e.word !== "tetl"), MODEL).cost
    );
  });

  it("quotes how strongly a sign's own occurrences say which job it is doing", () => {
    // On a line where the rabbit must be a rebus, forbidding the sound costs more than forbidding the meaning.
    const asRebus = roleEvidence(["RABBIT", "TEETH"], "RABBIT", HEADS, LEXICON, MODEL);
    expect(asRebus.logRatio).toBeGreaterThan(0);
    // On a line where it names itself, the ratio goes the other way.
    const asItself = roleEvidence(["RABBIT", "WATER"], "RABBIT", HEADS, LEXICON, MODEL);
    expect(asItself.logRatio).toBeLessThan(asRebus.logRatio);
  });

  it("states a sign it cannot account for rather than inventing a word for it", () => {
    const reading = readWithRoles(["RABBIT", "UNKNOWN", "WATER"], HEADS, LEXICON, MODEL);
    expect(reading.unreadable).toBe(1);
    // The signs around it still read.
    expect(reading.words.map(word => word.word)).toEqual(["tochtli", "atl"]);
  });

  it("uses the whole name as sound where that is what spells the word", () => {
    // Given the signs' full names rather than their heads, a rabbit alone still spells its own word, and the
    // reading is the logogram one because that is the same word at lower cost.
    const reading = readWithRoles(["RABBIT"], SIGNS, LEXICON, MODEL);
    expect(reading.words[0]!.word).toBe("tochtli");
    expect(reading.words[0]!.role).toBe("logogram");
  });
});
