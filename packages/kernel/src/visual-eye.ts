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
  bandMargin,
  transposeImage,
  type GrayImage,
  type PageGrouping,
  type PageLayout
} from "./visual-page-analysis.js";
import {
  calibrateEvidence,
  jitteredPositions,
  pruneByDomination,
  shuffledOrder,
  type HypothesisLattice,
  type Interpretation
} from "./visual-hypothesis-lattice.js";
import {
  decipherPage,
  decipherSigns,
  inventoryCodeLength,
  readPageSigns,
  structuralFit,
  type IdentityFraming,
  type PageSigns,
  type SymbolFrequency
} from "./visual-sign-inventory.js";
import { induceUnits, unitsOf } from "./visual-unit-induction.js";
import { recallSigns, type LearnedSign } from "./visual-script-memory.js";

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
  /** How unevenly sized this grouping's graphemes are; a script sets its graphemes on one scale. */
  readonly extentDispersion: number;
  /** Whether a lattice was found on the page rather than imposed on it. */
  readonly latticeCredible: boolean;
  /** How many bands of writing the page's own row periodicity implies. */
  readonly expectedLines: number;
}

export type ReadingGranularity = "signs" | "units";

/** One reading the eye considered, and what it cost to describe the page that way. */
export interface ConsideredReading {
  readonly orientation: ReadingOrientation;
  readonly grouping: PageGrouping;
  readonly framing: IdentityFraming;
  readonly signCount: number;
  readonly glyphCount: number;
  /** Nats to describe the page this way: the inventory, the ink, the text, the key and the layout. */
  readonly codeLength: number;
}

export interface VisualReading {
  readonly text: string;
  /** The reading's lines, symbol by symbol; a sign left unassigned reads as "?". */
  readonly lines: readonly (readonly string[])[];
  readonly orientation: ReadingOrientation;
  readonly grouping: PageGrouping;
  /**
   * Whether the page read one sign at a time or in the multi-sign units it was found to be written in. An
   * alphabet spends one sign per symbol; a logographic script spends one on a whole word. Which it is, is not
   * declared -- both are read and the shorter description wins.
   */
  readonly granularity: ReadingGranularity;
  /** How many units the page was read in, when it was read in units. */
  readonly unitCount: number;
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
  /**
   * Every reading that was considered, cheapest first, so a caller can see what else the page might say and
   * how far ahead the chosen reading is. This is the product's uncertainty, not a diagnostic: where the margin
   * is small, the page genuinely admits more than one reading and a caller should be told so.
   */
  readonly considered: readonly ConsideredReading[];
  /** Nats by which the chosen reading beat the next cheapest. Small means the page is genuinely ambiguous. */
  readonly margin: number;
  /** How many of this page's signs were already known from a script read before. */
  readonly recalledSigns: number;
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
    cellOccupancy: layout.cellOccupancy,
    extentDispersion: layout.extentDispersion,
    latticeCredible: layout.latticeCredible,
    expectedLines: layout.expectedLines
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
export interface ReadImageOptions extends CrossLingualAlignmentOptions {
  /**
   * Signs read before, from a script this page may be written in. Any that match a sign of this page inside the
   * page's own measured same-sign scale are carried in already known, so a second page of the same hand is
   * easier than the first was.
   */
  readonly remembered?: readonly LearnedSign[];
}

export function readImage(
  image: GrayImage,
  language: KnownLanguage,
  options?: ReadImageOptions
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

  // Two further readings of what one grapheme is: the lattice the script may be set on, and a joined mark cut
  // where it is weakest for a hand that keeps no regular advance.
  const cellLayout = analyzePage(sources[orientation], { grouping: "cells" });
  const cellEvidence = evidenceFor(cellLayout, orientation);
  const pieceLayout = analyzePage(sources[orientation], { grouping: "pieces" });
  const pieceEvidence = evidenceFor(pieceLayout, orientation);

  // What counts as one grapheme is settled by DESCRIPTION LENGTH: the page read through each grouping, scored
  // against the known language, plus the key it needs and the cost of stating where its marks are. Whichever
  // explains the page most briefly is the reading.
  //
  // Nothing simpler works, and each simpler thing fails the same way. Grapheme size agreement hands the lattice
  // every page, because lattice cells are uniformly sized whatever the image held. The page's own band count
  // cannot separate taking a joined word whole from cutting it into letters, since a word-blob and its letters
  // lie on the same lines. And choosing the grouping whose inventory RECURS most picks the coarsest reading
  // every time -- measured, it cut a square-cell script's bars into fragments of two shapes that repeat far
  // more often than its eight characters do, and read 8 per cent of the page. Description length is the one
  // criterion that charges a reading for the text it produces as well as for the inventory it needs.
  // Every reading of what one grapheme is, against every way of framing its identity. Both questions are
  // settled by the same cost, because neither has an answer that holds for all scripts.
  const candidateLayouts = [marksLayouts[orientation]!, cellLayout, pieceLayout];
  const framings: readonly IdentityFraming[] = ["box", "window"];
  const vocabulary = Math.max(2, language.frequencies.length);
  let chosen: {
    layout: PageLayout;
    signs: PageSigns;
    reading: ReturnType<typeof decipherPage>;
    codeLength: number;
  } | undefined;
  const considered: ConsideredReading[] = [];

  for (const candidate of candidateLayouts) for (const framing of framings) {
    const read = readPageSigns(candidate, { framing });
    const count = read.inventory.signOf.length;
    if (!count) continue;
    // What this page shares with a script already read: matched on shape, inside this page's own same-sign
    // scale, and carried in as known rather than guessed at again.
    const recalled = options?.remembered?.length ? recallSigns(read, options.remembered) : [];
    const known = new Map(recalled.map(match => [match.sign, { symbol: match.symbol, strength: match.score }]));
    const reading = decipherPage({
      signs: read,
      languageBigrams: language.bigrams,
      languageFrequencies: language.frequencies,
      known: known.size ? known : undefined,
      options
    });
    const tokens = Math.max(1, read.lines.reduce((total, line) => total + line.length, 0));
    const spreads = candidate.lines
      .map(line => line.words.flatMap(word => word.glyphs).map(glyph => glyph.centroidY))
      .map(positions => (positions.length ? Math.max(...positions) - Math.min(...positions) : 0))
      .sort((a, b) => a - b);
    const typicalSpread = spreads.length ? spreads[spreads.length >> 1]! : 0;
    // L(H) + L(D|H), whole: the inventory and the ink it has to reproduce, the key, the text under the known
    // language, and where the marks lie. The ink term is what lets readings that disagree about how many marks
    // there are be compared at all -- without it the coarsest reading wins on token count alone.
    const inventoryCost = inventoryCodeLength(read);
    const codeLength = inventoryCost.total
      + -reading.fit * tokens
      + reading.signCount * Math.log(vocabulary)
      + candidate.lines.length * Math.log(Math.max(2, candidate.mask.height))
      + tokens * Math.log(1 + typicalSpread);
    considered.push({
      orientation,
      grouping: candidate.grouping,
      framing,
      signCount: reading.signCount,
      glyphCount: count,
      codeLength
    });
    if (!chosen || codeLength < chosen.codeLength) chosen = { layout: candidate, signs: read, reading, codeLength };
  }
  considered.sort((left, right) => left.codeLength - right.codeLength);
  const margin = considered.length > 1 ? considered[1]!.codeLength - considered[0]!.codeLength : 0;

  const layout = chosen ? chosen.layout : marksLayouts[orientation]!;
  const signs = chosen ? chosen.signs : readPageSigns(layout);
  const glyphCount = signs.inventory.signOf.length;
  const layoutEvidence = [...marksEvidence, cellEvidence, pieceEvidence];

  if (!glyphCount) {
    return {
      text: "", lines: [], orientation, grouping: layout.grouping,
      granularity: "signs", unitCount: 0,
      reversed: false, mirrorFolded: false, signCount: 0, glyphCount: 0, typicalOccurrence: 0,
      fit: Number.NEGATIVE_INFINITY, directionMargin: 0, layoutEvidence, considered: [], margin: 0,
      recalledSigns: 0,
      abstained: true, abstainedBecause: "no marks were found on the page",
      signToSymbol: new Map(), layout, signs
    };
  }

  let reading = chosen!.reading;
  const recalledSigns = options?.remembered?.length ? recallSigns(signs, options.remembered).length : 0;
  let granularity: ReadingGranularity = "signs";
  let unitCount = 0;

  // Granularity, settled the same way and on the winning layout. The page's signs are offered as they are and
  // again in the multi-sign units they were found to be written in, and whichever describes the page more
  // briefly is the reading. An alphabet keeps its signs because a unit inventory has to pay for itself; a
  // logographic script does not, because there one sign really does carry a whole word.
  const unitInventory = induceUnits(signs.lines);
  const composites = unitInventory.units.filter(unit => unit.signs.length > 1);
  if (composites.length && glyphCount > 1) {
    const segmented = unitsOf(signs.lines, unitInventory);
    const idOfUnit = new Map<string, number>();
    const asUnits = segmented.map(line => line.map(piece => {
      const key = piece.join(",");
      let id = idOfUnit.get(key);
      if (id === undefined) {
        id = idOfUnit.size;
        idOfUnit.set(key, id);
      }
      return id;
    }));

    const unitReading = decipherSigns({
      lines: asUnits,
      languageBigrams: language.bigrams,
      languageFrequencies: language.frequencies,
      options
    });
    const unitTokens = Math.max(1, asUnits.reduce((total, line) => total + line.length, 0));
    // The unit inventory has to be stated, which is what stops a coarser reading winning for being coarser.
    const unitCost = unitInventory.codeLength
      + -unitReading.fit * unitTokens
      + idOfUnit.size * Math.log(Math.max(2, language.frequencies.length));
    const signTokens = Math.max(1, signs.lines.reduce((total, line) => total + line.length, 0));
    const signCost = unitInventory.baseCodeLength
      + -reading.fit * signTokens
      + reading.signCount * Math.log(Math.max(2, language.frequencies.length));
    if (unitCost < signCost) {
      reading = { ...unitReading, mirrorFolded: reading.mirrorFolded, signCount: idOfUnit.size };
      granularity = "units";
      unitCount = idOfUnit.size;
    }
  }

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
    granularity,
    unitCount,
    reversed: reading.reversed,
    mirrorFolded: reading.mirrorFolded,
    signCount: reading.signCount,
    glyphCount,
    typicalOccurrence,
    fit: reading.fit,
    directionMargin: reading.fit - reading.rejectedFit,
    layoutEvidence,
    considered,
    margin,
    recalledSigns,
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


/** How many null draws each claim is scored against. A cost budget, not a modelling constant. */
export const DEFAULT_NULL_DRAWS = 48;

export interface LatticeOptions extends CrossLingualAlignmentOptions {
  readonly nullDraws?: number;
}

/**
 * Read the image and keep every interpretation nothing else dominates, each scored against its own null.
 *
 * Two claims are calibrated here. That the marks fall into LINES is scored against the same banding measured
 * after the positions are jittered by a glyph's own height, which destroys banding and leaves everything else.
 * That the sequence reads like the LANGUAGE is scored against the same likelihood after the order is shuffled,
 * which destroys adjacency and leaves the inventory and its frequencies untouched. Both come back as a standard
 * score and an empirical tail, so they can be compared with each other and across pages.
 *
 * Where one reading dominates, the lattice has a single member and `readImage` would have said the same thing.
 * Where two stand, what they disagree on is reported rather than settled by a coin toss -- which is the useful
 * answer for a damaged or unfamiliar inscription.
 */
export function readImageWithAlternatives(
  image: GrayImage,
  language: KnownLanguage,
  options: LatticeOptions = {}
): HypothesisLattice {
  const draws = Math.max(1, options.nullDraws ?? DEFAULT_NULL_DRAWS);
  const vocabulary = Math.max(2, language.frequencies.length);
  const sources: Record<ReadingOrientation, GrayImage> = { rows: image, columns: transposeImage(image) };

  const interpretations: Interpretation[] = [];
  for (const orientation of ["rows", "columns"] as const) {
    for (const grouping of ["marks", "cells"] as const) {
      const layout = analyzePage(sources[orientation], { grouping });
      const signs = readPageSigns(layout);
      const glyphs = signs.inventory.signOf.length;
      if (!glyphs) continue;

      const reading = decipherPage({
        signs,
        languageBigrams: language.bigrams,
        languageFrequencies: language.frequencies,
        options
      });

      // Lines: the banding actually found, against the banding left once positions are jittered by a glyph.
      const placed = layout.lines.flatMap(line => line.words.flatMap(word => word.glyphs));
      const heights = placed.map(glyph => glyph.y1 - glyph.y0 + 1).sort((a, b) => a - b);
      const glyphHeight = heights.length ? heights[heights.length >> 1]! : 1;
      const centres = placed.map(glyph => glyph.centroidY);
      const lineNull: number[] = [];
      for (let draw = 0; draw < draws; draw++) {
        lineNull.push(bandMargin(jitteredPositions(centres, glyphHeight, draw + 1), glyphHeight));
      }

      // Language: the likelihood of the reading, against the likelihood once the order is shuffled.
      const sequences = signs.lines;
      const languageNull: number[] = [];
      for (let draw = 0; draw < draws; draw++) {
        languageNull.push(structuralFit(
          sequences.map(sequence => shuffledOrder(sequence, draw * 31 + 7)),
          reading.signToSymbol,
          language.bigrams
        ));
      }

      const unreadable = sequences.flat().filter(sign => !reading.signToSymbol.has(sign)).length;
      const tokens = Math.max(1, sequences.reduce((total, sequence) => total + sequence.length, 0));

      // Description length has to include the LAYOUT, or a reading that finds no lines at all looks cheap. A
      // reading with real lines states each line's position once and then each glyph's small offset from it; a
      // reading with none must state every glyph's position across the whole page. Measured on an ordinary
      // page that is the difference between about 420 nats and about 1220, and without it the wrong axis came
      // out four nats cheaper than the right one and survived as a false alternative.
      const spreads = layout.lines
        .map(line => line.words.flatMap(word => word.glyphs).map(glyph => glyph.centroidY))
        .map(positions => (positions.length ? Math.max(...positions) - Math.min(...positions) : 0))
        .sort((a, b) => a - b);
      const typicalSpread = spreads.length ? spreads[spreads.length >> 1]! : 0;
      const positionCost = layout.lines.length * Math.log(Math.max(2, layout.mask.height))
        + tokens * Math.log(1 + typicalSpread);

      const codeLength = -reading.fit * tokens + reading.signCount * Math.log(vocabulary) + positionCost;

      interpretations.push({
        label: `${orientation}/${grouping}`,
        choices: {
          direction: reading.reversed ? "right-to-left" : "left-to-right",
          grouping,
          mirror: reading.mirrorFolded ? "folded" : "distinct",
          orientation
        },
        text: reading.text,
        codeLength,
        evidence: [
          calibrateEvidence("lines", bandMargin(centres, glyphHeight), lineNull),
          calibrateEvidence("language", reading.fit, languageNull)
        ],
        contradictions: unreadable
      });
    }
  }
  return pruneByDomination(interpretations);
}
