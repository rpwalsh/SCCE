// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { clearCorpusIdentitySignals, corpusIdentityUnits, corpusNamedRuns, primeCorpusIdentitySignals } from "../corpus-identity.js";
import { genericQuestionSignal, namedSubjectAnchors, normalizePriorKey, splitPriorUnits } from "../kernel-answer-primitives.js";

afterEach(() => clearCorpusIdentitySignals());

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

// Verbatim copy of the implementation before letterhood stopped depending on case.
function oldGenericQuestionSignal(unit: string): boolean {
  if (!unit) return true;
  if (unit.length <= 2) return true;
  let letters = 0;
  let repeated = 0;
  let previous = "";
  for (const char of unit) {
    if (char.toLocaleLowerCase() !== char.toLocaleUpperCase()) letters++;
    if (char === previous) repeated++;
    previous = char;
  }
  return letters <= 1 || repeated / Math.max(1, unit.length - 1) > 0.72;
}

function oldNamedSubjectAnchors(text: string): string[] {
  const specific = (anchor: string) => {
    const units = splitPriorUnits(anchor);
    if (units.length >= 2) return true;
    return units.some(unit => [...unit].length >= 3 && !oldGenericQuestionSignal(unit));
  };
  return corpusNamedRuns(text)
    .map(normalizePriorKey)
    .filter(specific)
    .sort((left, right) => splitPriorUnits(right).length - splitPriorUnits(left).length || right.length - left.length);
}

const cased = (char: string) => char.toLocaleLowerCase() !== char.toLocaleUpperCase();
// The identity property's premise: every letter the text carries has case.
const allLettersCased = (text: string) => [...text].every(char => !/\p{Alphabetic}/u.test(char) || cased(char));

function realRequestTexts(): string[] {
  const texts: string[] = [];
  const capitals = readFileSync(resolve(repoRoot, "tools/capitals-probe.mjs"), "utf8").match(/QUESTIONS = \[([\s\S]*?)\]/)?.[1] ?? "";
  texts.push(...[...capitals.matchAll(/"([^"]+)"/g)].map(match => match[1]!));
  for (const file of ["tools/probe-questions.txt", "tools/probe-followups.txt"]) {
    texts.push(...readFileSync(resolve(repoRoot, file), "utf8").split(/\r?\n/).filter(line => line && !line.startsWith("#")));
  }
  for (const file of ["tools/datasets/wiki-qa.json", "tools/datasets/nonwiki-qa.json"]) {
    const questions = (JSON.parse(readFileSync(resolve(repoRoot, file), "utf8")) as { questions: Array<{ text?: string }> }).questions;
    texts.push(...questions.map(question => question.text).filter((text): text is string => typeof text === "string"));
  }
  const results = process.env.SCCE_HEAD_TO_HEAD_RESULTS ?? resolve(repoRoot, "artifacts/head-to-head/results-final.json");
  if (existsSync(results)) {
    const rows = (JSON.parse(readFileSync(results, "utf8")) as { rows: Array<{ prompt?: string }> }).rows;
    texts.push(...rows.map(row => row.prompt).filter((text): text is string => typeof text === "string"));
  }
  return texts;
}

function generatedCasedTexts(count: number): string[] {
  const alphabet: string[] = [];
  for (const [from, to] of [[0x41, 0x24f], [0x370, 0x3ff], [0x400, 0x52f], [0x1e00, 0x1fff]] as const) {
    for (let cp = from; cp <= to; cp++) {
      const char = String.fromCodePoint(cp);
      if (/\p{Alphabetic}/u.test(char) && cased(char)) alphabet.push(char);
    }
  }
  const other = ["0", "7", "'", "-", ".", "?", ",", "’", " ", " ", "́", "Ⅻ", "ⓐ"];
  let seed = 0x5cce;
  const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 0x100000000;
  const out: string[] = [];
  for (let index = 0; index < count; index++) {
    const length = Math.floor(next() * 14);
    let text = "";
    for (let position = 0; position < length; position++) {
      const roll = next();
      if (roll < 0.2 && text) text += [...text].at(-1)!;
      else if (roll < 0.35) text += other[Math.floor(next() * other.length)]!;
      else text += alphabet[Math.floor(next() * alphabet.length)]!;
    }
    out.push(text);
  }
  return out;
}

describe("genericQuestionSignal reads letterhood from Unicode, not from case", () => {
  it("keeps a primed single-unit identity in Hebrew, Arabic and Chinese", () => {
    primeCorpusIdentitySignals({ closedClass: new Set(["איפה", "أين", "在哪里"]), identities: new Set(["ירושלים", "القدس", "耶路撒冷"]), spread: new Map(), concentration: 0 });
    expect(namedSubjectAnchors("איפה ירושלים")).toEqual(["ירושלים"]);
    expect(namedSubjectAnchors("أين القدس")).toEqual(["القدس"]);
    expect(namedSubjectAnchors("耶路撒冷 在哪里")).toEqual(["耶路撒冷"]);
  });

  it("still drops closed-class and degenerate units in those scripts", () => {
    primeCorpusIdentitySignals({ closedClass: new Set(["איפה", "أين", "在哪里"]), identities: new Set(), spread: new Map(), concentration: 0 });
    expect(namedSubjectAnchors("איפה")).toEqual([]);
    expect(namedSubjectAnchors("أين")).toEqual([]);
    expect(namedSubjectAnchors("在哪里")).toEqual([]);
    expect(genericQuestionSignal("ההההה")).toBe(true);
    expect(genericQuestionSignal("ש")).toBe(true);
  });

  it("counts every cased code point as a letter, so cased input cannot change", () => {
    const casedButNotAlphabetic: number[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const char = String.fromCodePoint(cp);
      if (cased(char) && !/\p{Alphabetic}/u.test(char)) casedButNotAlphabetic.push(cp);
    }
    expect(casedButNotAlphabetic).toEqual([]);
  });

  it("is identical to the cased-only implementation on real requests and generated cased strings", () => {
    const real = realRequestTexts().filter(allLettersCased);
    const generated = generatedCasedTexts(20000).filter(allLettersCased);
    expect(real.length).toBeGreaterThan(50);
    console.info(`identity property: ${real.length} real request texts, ${generated.length} generated`);
    const documentFrequency = new Map<string, number>();
    for (const text of real) for (const unit of new Set(corpusIdentityUnits(text))) documentFrequency.set(unit, (documentFrequency.get(unit) ?? 0) + 1);
    const byFrequency = [...documentFrequency].sort((left, right) => right[1] - left[1]);
    const closedClass = new Set(byFrequency.slice(0, Math.ceil(byFrequency.length / 20)).map(([unit]) => unit));
    const identities = new Set(real.flatMap(text => corpusIdentityUnits(text).filter(unit => !closedClass.has(unit))).filter((_, index) => index % 7 === 0));
    const mismatches: string[] = [];
    let compared = 0;
    const primings = [
      () => clearCorpusIdentitySignals(),
      () => primeCorpusIdentitySignals({ closedClass, identities: new Set(), spread: new Map(), concentration: 0 }),
      () => primeCorpusIdentitySignals({ closedClass, identities, spread: new Map(), concentration: 0 })
    ];
    for (const prime of primings) {
      prime();
      for (const text of [...real, ...generated]) {
        const units = new Set([...text.split(/\s+/), ...splitPriorUnits(normalizePriorKey(text)), ...corpusIdentityUnits(text), text]);
        for (const unit of units) {
          compared++;
          if (genericQuestionSignal(unit) !== oldGenericQuestionSignal(unit)) mismatches.push(`generic:${unit}`);
        }
        compared++;
        if (JSON.stringify(namedSubjectAnchors(text)) !== JSON.stringify(oldNamedSubjectAnchors(text))) mismatches.push(`anchors:${text}`);
      }
    }
    console.info(`identity property: ${compared} comparisons, ${mismatches.length} mismatches`);
    expect(mismatches.slice(0, 20)).toEqual([]);
  });
});
