// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// SCCE's eye: an image of writing in, text out, with no font, no key, no labels and no model.
//
// Reading a page means settling questions that writing systems answer differently -- does the writing run in
// rows or columns, is one mark one grapheme or does a cell hold several strokes, does a line run forwards or
// backwards, is a mark's mirror image the same sign. None of them is guessed from what the script looks like,
// because any such guess is a rule about one family of scripts.
//
// They are settled by two different kinds of evidence, and keeping them apart is what makes this work:
//
//   Layout is decided by the page's own geometry. Which axis the writing runs along is visible without knowing
//   any language at all: on the right axis the marks fall into bands with a clear gap between them, and on the
//   wrong one they do not separate at all. Whether a cell holds several strokes is likewise a measurement -- the
//   commonest number of marks the lattice puts in one cell.
//
//   Identity is decided by the language. Direction and mirroring change which symbol each sign becomes, not how
//   the ink is arranged, so they are scored by how likely the resulting text is under a language SCCE already
//   ingested.
//
// The one thing that cannot arbitrate layout is that likelihood, and it took measurement to see why: a coarser
// reading always scores better per symbol, because a smaller inventory never risks an improbable continuation.
// A two-stroke inventory beat the correct eight-character one, and a one-sign inventory beat everything.
//
// When the page does not settle a question, the reading says so rather than claiming an answer.

import type { CooccurrenceBigram, CrossLingualAlignmentOptions } from "./cross-lingual-alignment.js";
import {
  analyzePage,
  transposeImage,
  type GrayImage,
  type PageGrouping,
  type PageLayout
} from "./visual-page-analysis.js";
import {
  decipherPage,
  readPageSigns,
  type PageSigns,
  type SymbolFrequency
} from "./visual-sign-inventory.js";

/** A language SCCE already knows, at the granularity the script's signs are expected to carry. */
export interface KnownLanguage {
  readonly bigrams: readonly CooccurrenceBigram[];
  readonly frequencies: readonly SymbolFrequency[];
}

export type ReadingOrientation = "rows" | "columns";

/** What the page's geometry said about one candidate layout, before any language was consulted. */
export interface LayoutEvidence {
  readonly orientation: ReadingOrientation;
  readonly grouping: PageGrouping;
  readonly glyphCount: number;
  readonly lineCount: number;
  readonly linesFound: boolean;
  /** Gap between the line-separating distances and the within-line ones: how decisively lines separated. */
  readonly lineMargin: number;
  /** Commonest number of marks a lattice cell held; 1 means cells buy nothing. */
  readonly cellOccupancy: number;
}

export interface VisualReading {
  readonly text: string;
  /** The reading's lines, symbol by symbol; a sign left unassigned reads as "?". */
  readonly lines: readonly (readonly string[])[];
  readonly orientation: ReadingOrientation;
  readonly grouping: PageGrouping;
  readonly reversed: boolean;
  readonly mirrorFolded: boolean;
  readonly signCount: number;
  readonly glyphCount: number;
  /** How often the typical sign recurs. At one, the marks are not the signs of a script. */
  readonly typicalOccurrence: number;
  /** Log-likelihood per symbol of the chosen reading under the known language. */
  readonly fit: number;
  /** How much the chosen direction beat the one rejected. */
  readonly directionMargin: number;
  /** Every candidate layout the geometry was measured on. */
  readonly layoutEvidence: readonly LayoutEvidence[];
  readonly abstained: boolean;
  /** Why the page was not claimed as read, when it was not. */
  readonly abstainedBecause: string | undefined;
  readonly signToSymbol: ReadonlyMap<number, string>;
  readonly layout: PageLayout;
  readonly signs: PageSigns;
}

function evidenceFor(layout: PageLayout, orientation: ReadingOrientation): LayoutEvidence {
  return {
    orientation,
    grouping: layout.grouping,
    glyphCount: layout.lines.reduce((total, line) =>
      total + line.words.reduce((count, word) => count + word.glyphs.length, 0), 0),
    lineCount: layout.lineSplit.count,
    linesFound: layout.lineSplit.accepted,
    lineMargin: layout.lineSplit.margin,
    cellOccupancy: layout.cellOccupancy
  };
}

/** Writing organises into lines, so the axis whose marks separate into bands most decisively is the one. */
function strongerLayout(a: LayoutEvidence, b: LayoutEvidence): number {
  if (a.linesFound !== b.linesFound) return a.linesFound ? -1 : 1;
  if (a.lineMargin !== b.lineMargin) return b.lineMargin - a.lineMargin;
  return b.lineCount - a.lineCount;
}

/**
 * Read an image of writing. Layout is measured off the page, identity is scored against the known language, and
 * anything the evidence leaves open is reported rather than guessed.
 */
export function readImage(
  image: GrayImage,
  language: KnownLanguage,
  options?: CrossLingualAlignmentOptions
): VisualReading {
  const sources: Record<ReadingOrientation, GrayImage> = { rows: image, columns: transposeImage(image) };
  const marksLayouts = {
    rows: analyzePage(sources.rows, { grouping: "marks" }),
    columns: analyzePage(sources.columns, { grouping: "marks" })
  };
  const marksEvidence = [
    evidenceFor(marksLayouts.rows, "rows"),
    evidenceFor(marksLayouts.columns, "columns")
  ];

  const ranked = [...marksEvidence].sort(strongerLayout);
  const orientation = ranked[0]!.orientation;
  const undecided = strongerLayout(ranked[0]!, ranked[1]!) === 0;

  // A cell grouping earns its place only where a cell demonstrably holds more than one mark: that is what CJK
  // and Hangul do and what Latin does not, and it is a measurement rather than a judgement about the script.
  const cellLayout = analyzePage(sources[orientation], { grouping: "cells" });
  const cellEvidence = evidenceFor(cellLayout, orientation);
  const useCells = cellEvidence.cellOccupancy > 1;
  const layout = useCells ? cellLayout : marksLayouts[orientation];

  const signs = readPageSigns(layout);
  const glyphCount = signs.inventory.signOf.length;
  const layoutEvidence = [...marksEvidence, cellEvidence];

  if (!glyphCount) {
    return {
      text: "", lines: [], orientation, grouping: layout.grouping,
      reversed: false, mirrorFolded: false, signCount: 0, glyphCount: 0, typicalOccurrence: 0,
      fit: Number.NEGATIVE_INFINITY, directionMargin: 0, layoutEvidence,
      abstained: true, abstainedBecause: "no marks were found on the page",
      signToSymbol: new Map(), layout, signs
    };
  }

  const reading = decipherPage({
    signs,
    languageBigrams: language.bigrams,
    languageFrequencies: language.frequencies,
    options
  });

  // Writing repeats its signs: that is what makes a script a closed inventory rather than a pile of shapes.
  // Measured on blank paper the typical sign occurs once, against 27 on a written page, so a page whose marks
  // almost never repeat carries no inventory and is not read. A page with no repetition anywhere cannot
  // establish a same-sign scale either, so this refuses exactly the pages nothing could be learned from.
  const occurrences = signs.inventory.clusters.map(c => c.occurrences).sort((a, b) => a - b);
  const typicalOccurrence = occurrences.length ? occurrences[occurrences.length >> 1]! : 0;

  const indistinct = glyphCount > 1 && !signs.inventory.distinguishable;
  const abstainedBecause = indistinct
    ? "the page's marks could not be told apart, so there is no inventory to read"
    : typicalOccurrence <= 1
      ? "the page's marks almost never repeat, so they are not the signs of a script"
      : undecided
        ? "neither axis of the page separated its marks into lines, so the reading direction is unknown"
        : undefined;

  return {
    text: reading.text,
    lines: reading.readings,
    orientation,
    grouping: layout.grouping,
    reversed: reading.reversed,
    mirrorFolded: reading.mirrorFolded,
    signCount: reading.signCount,
    glyphCount,
    typicalOccurrence,
    fit: reading.fit,
    directionMargin: reading.fit - reading.rejectedFit,
    layoutEvidence,
    abstained: abstainedBecause !== undefined,
    abstainedBecause,
    signToSymbol: reading.signToSymbol,
    layout,
    signs
  };
}

/** The known language in the shape the eye consumes, from adjacency and symbol counts already measured. */
export function knownLanguageFrom(
  bigrams: readonly CooccurrenceBigram[],
  frequencies: readonly SymbolFrequency[]
): KnownLanguage {
  return { bigrams, frequencies: [...frequencies].sort((a, b) => b.count - a.count) };
}
