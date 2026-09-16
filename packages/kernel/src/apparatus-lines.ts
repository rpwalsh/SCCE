// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { calibrated } from "./calibrations/prod-calibrations.js";
import { residueTokens, structuralResidueMeasurement, type StructuralResidueMeasurement } from "./structural-residue.js";

/**
 * Apparatus at ingest: the lines of a document that are its machinery rather than its text.
 *
 * `structural-residue.ts` already measures the shape apparatus has. T20 records why it cannot see a reference list:
 * it is applied per sentence, and one entry -- `* [https://... ABBA's Essential, Influential Melancholy]. NPR, 23
 * May 2015` -- repeats no bigram, so `symbolDensity * (1 - bigramDiversity)` is exactly 0. The skeleton is not in
 * the entry. It is in the list, and the list only exists while the document still has line structure, which the
 * wiki normalizer destroys in its last step.
 *
 * So the unit measured here is a RUN: the contiguous lines that open with the same token, blank lines not ending
 * one. A bibliography opens every line with the same bullet, a table with the same separator, a table of contents
 * with the same word; a paragraph stands by itself and is the singleton it is. The quantity is how much more of its
 * length the run spends on symbols than the document around it does -- the document is its own baseline, because
 * `symbolDensity` alone cannot be asked to suit both a novel written in quotation marks and a marked-up article.
 * Measured on the real dump and on real books, run density against document density:
 *
 *   ABBA external links, 7 lines    0.491 - 0.190 = 0.300   removed
 *   Andy Warhol bibliography, 5     0.500 - 0.180 = 0.320   removed
 *   Apple revenue table, 166        0.549 - 0.188 = 0.361   removed
 *   ABBA section headings, 4        0.846 - 0.190 = 0.656   removed
 *   Dorian Gray dialogue, 17        0.383 - 0.174 = 0.209   kept
 *   Jane Eyre dialogue, 6           0.367 - 0.189 = 0.178   kept
 *   Moby-Dick contents, 56          0.339 - 0.173 = 0.166   kept: a contents list is not symbol-dense, and
 *                                                           nothing here reaches it. Stated, not papered over.
 *
 * A run of one line is never apparatus: a repetition needs two, and requiring it is what keeps a paragraph of
 * chemistry (`Initial experiments yielded four americium isotopes: 241 Am, 242 Am...`, 0.272 on its own) out of the
 * class. The cut is `ingest.apparatus_run_residue_cut`, the Otsu split of the corpus's own run population --
 * `tools/derive-apparatus-line-cuts.mjs` recomputes it. No markup literal, no template name, no word.
 */

/** A repetition is two lines. Not a tuned quantity: one line repeats nothing. */
const REPETITION = 2;

export interface ApparatusRun {
  /** Indices into the document's lines, in order; blank lines between members are not included. */
  lineIndices: readonly number[];
  /** The token every member line opens with. */
  opening: string;
  text: string;
  measurement: StructuralResidueMeasurement;
  /** How much more of its length the run spends on symbols than the document it sits in. */
  excessSymbolDensity: number;
  apparatus: boolean;
}

export interface ApparatusLineMeasurement {
  index: number;
  line: string;
  tokens: number;
  runLines: number;
  score: number;
  apparatus: boolean;
}

/** The cut in force, resolved through the calibration table like every other decided quantity. */
export function apparatusRunCut(): number {
  return calibrated("ingest.apparatus_run_residue_cut");
}

/** The document's line runs, each scored by the structural-residue measure. Pure, language-free. */
export function measureApparatusRuns(text: string, cut: number = apparatusRunCut()): ApparatusRun[] {
  // The document is its own baseline, so a novel dense in quotation marks and an article dense in markup are each
  // judged against themselves rather than against one number that would have to suit both.
  const whole = structuralResidueMeasurement(String(text ?? ""));
  const lines = String(text ?? "").split("\n");
  const tokenized = lines.map(line => residueTokens(line));
  const carrying: number[] = [];
  for (let index = 0; index < lines.length; index++) if (tokenized[index]!.length > 0) carrying.push(index);
  const runs: ApparatusRun[] = [];
  let start = 0;
  while (start < carrying.length) {
    const opening = tokenized[carrying[start]!]![0]!;
    let end = start;
    while (end + 1 < carrying.length && tokenized[carrying[end + 1]!]![0] === opening) end++;
    const lineIndices = carrying.slice(start, end + 1);
    const runText = lineIndices.map(index => lines[index]!).join("\n");
    const measurement = structuralResidueMeasurement(runText);
    const excessSymbolDensity = measurement.symbolDensity - whole.symbolDensity;
    runs.push({
      lineIndices,
      opening,
      text: runText,
      measurement,
      excessSymbolDensity,
      apparatus: lineIndices.length >= REPETITION && excessSymbolDensity >= cut
    });
    start = end + 1;
  }
  return runs;
}

/** Per-line view of the same measurement, for tools and for reporting what a document lost. Pure. */
export function measureApparatusLines(text: string, cut: number = apparatusRunCut()): ApparatusLineMeasurement[] {
  const lines = String(text ?? "").split("\n");
  const rows: ApparatusLineMeasurement[] = lines.map((line, index) => ({ index, line, tokens: 0, runLines: 0, score: 0, apparatus: false }));
  for (const run of measureApparatusRuns(text, cut)) {
    for (const index of run.lineIndices) {
      rows[index] = {
        index,
        line: lines[index]!,
        tokens: residueTokens(lines[index]!).length,
        runLines: run.lineIndices.length,
        score: run.excessSymbolDensity,
        apparatus: run.apparatus
      };
    }
  }
  return rows;
}

/** The document without the runs its own line population measures as apparatus. Pure. */
export function stripApparatusLines(text: string, cut: number = apparatusRunCut()): string {
  const lines = String(text ?? "").split("\n");
  const dropped = new Set<number>();
  for (const run of measureApparatusRuns(text, cut)) if (run.apparatus) for (const index of run.lineIndices) dropped.add(index);
  return lines.filter((_line, index) => !dropped.has(index)).join("\n");
}
