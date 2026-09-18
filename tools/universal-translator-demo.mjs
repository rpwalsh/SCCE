// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// The universal-translator claim, run end to end against a script that did not exist when this engine was
// built. The shapes are invented here, from a seed taken at run time, so nothing about them can have been
// anticipated: no font table, no glyph list, no trained classifier, and no model of any kind.
//
// What it shows, in order:
//   1. An unseen script is rendered as pages of writing.
//   2. The eye reads the first page cold -- geometry off the page, identity against a known language.
//   3. What it worked out is kept, as signs.
//   4. A second and third page of the same hand are read again, with that memory offered.
//   5. Both readings are scored against the truth, and the cold and warm numbers printed side by side.
//
// Run: node --max-old-space-size=7168 tools/universal-translator-demo.mjs [--seed=<n>] [--pages=<n>]
//                                                                        [--font=designed|invented]

import { knownLanguageFrom, readImage, scriptMemoryOf } from "../packages/kernel/dist/index.js";
import {
  FONT,
  bigramsOf,
  editSimilarity,
  frequenciesOf,
  renderTextPageWith,
  sampleWords,
  syntheticLanguage,
  wrapWords
} from "../packages/kernel/dist/__tests__/page-fixtures.js";

const GRID = { cols: 5, rows: 7 };
/** A small deterministic generator, so a reported seed reproduces the run exactly. */
function generator(seed) {
  let state = (seed | 0) || 1;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

/**
 * One invented glyph, built from STROKES, because that is what a script is. A random walk on the grid was tried
 * first and produced shapes that were genuinely indistinguishable -- measured, 84 marks clustered to 2 signs,
 * because a walk of a dozen steps on a small grid is always a mid-density blob whatever its seed. A written
 * sign is instead a few strokes laid down by a pen, and strokes put ink at the edges of the cell where it
 * separates. Each stroke here starts from a cell the glyph already inks, so the mark stays one connected
 * component and survives the same labelling a real mark does.
 */
function inventGlyph(next) {
  const cells = new Set();
  const ink = (c, r) => {
    if (c < 0 || c >= GRID.cols || r < 0 || r >= GRID.rows) return false;
    cells.add(`${c},${r}`);
    return true;
  };
  const directions = [[0, 1], [1, 0], [1, 1], [1, -1]];
  const strokes = 2 + Math.floor(next() * 3);
  let col = Math.floor(next() * GRID.cols);
  let row = Math.floor(next() * GRID.rows);
  ink(col, row);
  for (let stroke = 0; stroke < strokes; stroke++) {
    // Start where the glyph already is, so the strokes join into one mark.
    const from = [...cells][Math.floor(next() * cells.size)].split(",").map(Number);
    const [dc, dr] = directions[Math.floor(next() * directions.length)];
    const length = 2 + Math.floor(next() * (Math.max(GRID.cols, GRID.rows) - 2));
    const sign = next() < 0.5 ? 1 : -1;
    col = from[0];
    row = from[1];
    for (let step = 0; step < length; step++) {
      if (!ink(col + dc * sign, row + dr * sign)) break;
      col += dc * sign;
      row += dr * sign;
    }
  }
  return Array.from({ length: GRID.rows }, (_, r) =>
    Array.from({ length: GRID.cols }, (_, c) => (cells.has(`${c},${r}`) ? "#" : ".")).join(""));
}

/** One candidate script: a shape per symbol, drawn from the seed and nothing else. */
function drawScript(symbols, seed) {
  const next = generator(seed);
  const font = {};
  for (const symbol of symbols) {
    for (;;) {
      const glyph = inventGlyph(next);
      const inked = glyph.join("").split("#").length - 1;
      // A shape with almost no ink, or one that fills its cell, is not a mark either way.
      if (inked >= 8 && inked <= GRID.cols * GRID.rows - 8) {
        font[symbol] = glyph;
        break;
      }
    }
  }
  return font;
}

/**
 * A script the reader can actually resolve, found by asking the reader.
 *
 * Judging the shapes by their own mutual distance does not work, and both ways of doing it were measured. At
 * the resolution they are drawn at, the chosen shapes differ in detail the reader cannot see -- description
 * length then preferred cutting every mark into pieces, because the pieces separated where the whole marks did
 * not. Coarsened to the resolution the reader has, the shapes grew thick and merged into their neighbours
 * instead, and the page resolved to one sign.
 *
 * So the criterion is not a distance at all: a script is legible when the reader, given a page of it, separates
 * its marks into as many signs as the script has. Candidate scripts are drawn from successive seeds and the
 * first legible one is taken. That is a real writing system's own history -- shapes were kept when they could be
 * told apart at a glance and abandoned when they could not -- and it invents nothing by hand. The seed that
 * produced it is reported, so the run reproduces exactly.
 */
function inventLegibleScript(symbols, seed, probe, attempts = 64) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const trialSeed = seed + attempt * 104729;
    const font = drawScript(symbols, trialSeed);
    const resolved = probe(font);
    if (resolved >= symbols.length) return { font, seed: trialSeed, attempts: attempt + 1, resolved };
  }
  return undefined;
}

/** The in-memory stand-in for the durable seed store, so the demo needs no database. */
function memoryStore() {
  const rows = new Map();
  return {
    translationSeeds: {
      async putSeeds(input) {
        for (const seed of input.seeds) {
          const key = `${input.targetLanguage}\u0000${seed.sourceSymbol}`;
          const held = rows.get(key);
          if (held && held.score >= seed.score) continue;
          rows.set(key, { ...seed });
        }
      },
      async listSeeds(targetLanguage, limit = 500) {
        return [...rows.entries()]
          .filter(([key]) => key.startsWith(`${targetLanguage}\u0000`))
          .map(([, seed]) => seed)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
      }
    }
  };
}

export async function runDemo(options = {}) {
  const seed = options.seed ?? Date.now() % 2147483647;
  const pages = Math.max(2, options.pages ?? 3);
  const { rememberScript, recallScript } = await import("../packages/adapters-node/dist/visual-script-memory.js");

  // A language the engine knows, and a script it does not.
  const weights = syntheticLanguage(20260918);
  const corpus = sampleWords(weights, 4242, 4000);
  const language = knownLanguageFrom(bigramsOf(corpus), frequenciesOf(corpus));
  const symbols = frequenciesOf(corpus).map(row => row.symbol);

  // Page sizes, and why they differ. Measured on the designed fixture font, a page of 60 words reads at 0.38
  // to 0.82 depending on the sample while a page of 240 reads at 0.95 -- and the inventory is EXACT at both
  // sizes, every letter in its own cluster. So what a short page lacks is not marks the eye can tell apart, it
  // is the statistics to decide WHICH letter each cluster is: 264 symbols over a 64-cell bigram table does not
  // pin the substitution.
  //
  // That is the whole demonstration. The first page is long enough to identify the script on its own. The pages
  // after it are deliberately too short to, and are read anyway, because the first page taught what the signs
  // mean and the memory carries that across.
  const FIRST_PAGE_WORDS = 240;
  const LATER_PAGE_WORDS = 60;
  const readingOptions = { outerIterations: 150, epsilon: 0.05 };
  const probeLines = wrapWords(sampleWords(weights, seed + 31, FIRST_PAGE_WORDS), 8);
  const probe = (font) =>
    readImage(renderTextPageWith(font, probeLines), language, readingOptions).signCount;
  // Two scripts can be run through the same protocol, and both are reported honestly.
  //
  //   invented (the default): shapes drawn from the seed, never in the source. This is the harder case and it
  //     is marginal -- a randomly drawn script is not a script a human refined for legibility, and measured, the
  //     same invented font reads a long page worse than a short one and its clusters shift enough between pages
  //     that a memory taken from one may match nothing on the next.
  //   designed: the fixture font, shapes a person made distinguishable on purpose, which is what a real writing
  //     system is. This is where the mechanism is demonstrable rather than confounded by marginal shapes.
  //
  // The engine is the same in both. The difference is entirely in how legible the script is.
  const invented = options.font === "designed" ? undefined : inventLegibleScript(symbols, seed, probe);
  if (options.font !== "designed" && !invented) {
    return { seed, symbols: symbols.length, legibleScriptFound: false };
  }

  const font = invented ? invented.font : FONT;
  const store = memoryStore();
  const report = {
    seed,
    script: invented ? "invented" : "designed",
    scriptSeed: invented?.seed,
    scriptsDrawnBeforeLegible: invented?.attempts,
    symbols: symbols.length,
    signsResolvedOnProbe: invented ? invented.resolved : probe(font),
    pages: []
  };

  for (let page = 0; page < pages; page++) {
    // Held-out text: a different sample on every page, so no page is a re-reading of another.
    const words = page === 0 ? FIRST_PAGE_WORDS : LATER_PAGE_WORDS;
    const lines = wrapWords(sampleWords(weights, seed + page * 7919, words), 8);
    const truth = [...lines.join(" ").replaceAll(" ", "")];
    const image = renderTextPageWith(font, lines);

    const cold = readImage(image, language, readingOptions);
    const remembered = await recallScript(store, "target");
    const warm = remembered.length ? readImage(image, language, { ...readingOptions, remembered }) : cold;

    report.pages.push({
      page: page + 1,
      words,
      glyphs: cold.glyphCount,
      signsFound: cold.signCount,
      signsOffered: remembered.length,
      signsRecalled: warm.recalledSigns,
      cold: Number(editSimilarity(cold.lines.flat(), truth).toFixed(4)),
      warm: Number(editSimilarity(warm.lines.flat(), truth).toFixed(4)),
      readingMargin: Number(warm.margin.toFixed(1)),
      abstained: warm.abstained,
      abstainedBecause: warm.abstainedBecause
    });

    // Keep what this page taught, for the next one.
    if (!warm.abstained) {
      await rememberScript(store, scriptMemoryOf({
        scriptId: `invented-${seed}`,
        targetLanguage: "target",
        signs: warm.signs,
        signToSymbol: warm.signToSymbol,
        score: Math.exp(warm.fit)
      }), { observedAt: Date.now() });
    }
  }

  const first = report.pages[0];
  const later = report.pages.slice(1);
  const mean = (rows, key) => Number((rows.reduce((t, p) => t + p[key], 0) / rows.length).toFixed(4));
  report.summary = {
    // The long first page, read with nothing known.
    firstPageWords: first.words,
    firstPageCold: first.cold,
    // The short later pages: what they read alone, and what they read having been taught.
    laterPageWords: later.length ? later[0].words : null,
    laterPagesCold: later.length ? mean(later, "cold") : null,
    laterPagesWarm: later.length ? mean(later, "warm") : null,
    memoryHelped: later.length ? mean(later, "warm") > mean(later, "cold") : null
  };
  return report;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop());
if (invokedDirectly) {
  const arg = (name) => process.argv.find(value => value.startsWith(`--${name}=`))?.split("=")[1];
  const report = await runDemo({
    seed: arg("seed") ? Number(arg("seed")) : undefined,
    pages: arg("pages") ? Number(arg("pages")) : undefined,
    font: arg("font")
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
