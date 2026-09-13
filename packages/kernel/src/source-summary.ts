// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { concentrationThreshold, corpusIdentityUnits } from "./corpus-identity.js";
import { SENTENCE_BOUNDARY_SYMBOLS, collapseSurfaceWhitespace, splitSurfaceSentences } from "./surface-linguistics.js";

/**
 * What a source says, compressed to the sentences that carry it.
 *
 * A corpus that holds a novel but no article about the novel could answer nothing about it: the answerhood gate
 * requires the request's relation to appear in the answering sentence, and a novel's prose never says "plot". The
 * source's own sentences are the answer -- the question is which of them, and that is a measurement, not a guess.
 *
 * Degree centrality over a sentence similarity graph, the classical extractive summary. Each sentence is a vector of
 * its content units weighted by inverse sentence frequency, and a sentence's centrality is how much of the rest of
 * the source it resembles. A sentence that restates what many others say is about the source; one that resembles
 * nothing is an aside. Every sentence returned is verbatim, so nothing is invented, and it reads the same way in any
 * script: the units come from the writing system's own boundaries and the weights from this text's own statistics.
 *
 * Three thresholds, none declared: which line breaks the source meant as sentence ends, which similarities count as
 * an edge, and which centralities count as central. Each is a split of values this text actually produced -- the
 * last two by Otsu, the same method the corpus identity arbiter uses.
 *
 * Separating a source's own body from its reprinted, editorial and apparatus matter is two measurements, both of
 * the source's own typography, and neither a keyword list or an offset:
 *
 *   line breaks   A printed book arrives hard-wrapped, and every newline then looks like a sentence end. Measured
 *                 on the corpus: Moby Dick's interior lines close a sentence 4.9% of the time and its paragraph-
 *                 final lines 96.1%, so its interior breaks carry no sentence information and are the printer's
 *                 wrap. Summarized as wrapped lines, the front matter wins -- its imprint and quotation lines are
 *                 short, formulaic and mutually near-identical, while the body's sentences are shredded into
 *                 70-character pieces that resemble nothing. Joining the wrap moved the first apparatus sentence
 *                 from rank 5 to rank 188 (Moby Dick) and rank 6 to rank 82 (Pride and Prejudice). A source whose
 *                 paragraphs are already single lines has no interior breaks to measure and is left untouched.
 *   termination   A title page, a running head, a table-of-contents line, a publisher's imprint and a banner are
 *                 segments the source never closed. Where a source demonstrably terminates its sentences, one it
 *                 did not terminate is not one of its sentences. This is what drops "The Project Gutenberg eBook
 *                 of Moby Dick; Or, The Whale" and "*** START OF THE PROJECT GUTENBERG EBOOK ***".
 *
 * Similarity is shared inverse-sentence-frequency mass damped by both sentences' lengths (TextRank's normalization
 * over LexRank's weights), not the cosine. The cosine measures agreement of direction and so cannot tell a sentence
 * that restates the source from a two-word label: "PORTUGUESE SAILOR." is a unit vector on one rare unit and scores
 * ~1.0 against every other speaker cue, which put ten of them in the summary ahead of the novel.
 */

export interface SourceSummarySentence {
  readonly text: string;
  readonly order: number;
  readonly centrality: number;
}

/** Quantized to integers for the Otsu split, which histograms a bounded range. */
const OTSU_SCALE = 1000;
/**
 * Cost bound on the similarity graph, not a modeling choice: pairwise similarity is quadratic, and a novel's spans
 * run to hundreds of thousands of characters. Sentences are ranked first by a linear informativeness score and the
 * graph is built over the survivors, which is the standard way to keep extractive summarization affordable.
 */
const SIMILARITY_GRAPH_SENTENCE_CAP = 400;

const SENTENCE_TERMINATORS = new Set<string>(SENTENCE_BOUNDARY_SYMBOLS);
const WORD_CHARACTER = /[\p{L}\p{M}\p{N}]/u;

/** Whether the source closed this segment itself; a closing quote or bracket sits after the terminator. */
function sourceTerminated(segment: string): boolean {
  const chars = [...segment];
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index]!;
    if (SENTENCE_TERMINATORS.has(char)) return true;
    if (WORD_CHARACTER.test(char)) return false;
  }
  return false;
}

/**
 * Joins the line breaks a source uses as typographic wrap, leaving the ones it uses as sentence ends.
 *
 * Decided by the source against itself: how often a line that ends a paragraph closes a sentence, against how often
 * a line inside a paragraph does. Both rates come from this text; no rate is declared. Exported so a caller that
 * has already split a source into spans can measure the source once rather than per span.
 */
export function unwrapTypographicLineBreaks(text: string): string {
  const normalized = text.replace(/\r\n?/gu, "\n");
  const lines = normalized.split("\n");
  let paragraphFinal = 0;
  let paragraphFinalClosed = 0;
  let interior = 0;
  let interiorClosed = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    const closed = sourceTerminated(line);
    if ((lines[index + 1] ?? "").trim()) {
      interior += 1;
      if (closed) interiorClosed += 1;
    } else {
      paragraphFinal += 1;
      if (closed) paragraphFinalClosed += 1;
    }
  }
  // Nothing to compare: a source with no paragraph breaks, or none inside one, has taught nothing about its breaks.
  if (!paragraphFinal || !interior) return text;
  // Cross-multiplied rather than divided, so the comparison is exact.
  if (interiorClosed * paragraphFinal >= paragraphFinalClosed * interior) return text;
  return normalized
    .split(/\n[ \t]*\n+/u)
    .map(paragraph => paragraph.replace(/\n/gu, " "))
    .join("\n\n");
}

export function centralSentences(text: string, closedClass: ReadonlySet<string>): SourceSummarySentence[] {
  const segments = splitSurfaceSentences(unwrapTypographicLineBreaks(text))
    .map(sentence => sentence.trim())
    .filter(Boolean);
  const closedSegments = segments.filter(sourceTerminated);
  // A source that closes most of its segments has an apparatus wherever it did not; one that closes few is not
  // punctuated prose at all, and every segment it has is all it has.
  const sentences = closedSegments.length > segments.length - closedSegments.length ? closedSegments : segments;
  if (sentences.length < 2) return sentences.map((sentence, order) => ({ text: sentence, order, centrality: 1 }));

  // Content units per sentence: what the language uses as scaffolding carries no aboutness.
  const unitsPer = sentences.map(sentence => corpusIdentityUnits(sentence).filter(unit => !closedClass.has(unit)));
  const sentenceFrequency = new Map<string, number>();
  for (const units of unitsPer) for (const unit of new Set(units)) sentenceFrequency.set(unit, (sentenceFrequency.get(unit) ?? 0) + 1);

  // Inverse sentence frequency: a unit every sentence uses distinguishes none of them.
  const allWeight = (units: readonly string[]): number => {
    let weight = 0;
    for (const unit of new Set(units)) weight += Math.log(sentences.length / (sentenceFrequency.get(unit) ?? 1)) + 1;
    return units.length ? weight / Math.sqrt(units.length) : 0;
  };
  // Linear prefilter so the quadratic step below stays bounded; survivors keep their position in the source.
  const considered = sentences.length <= SIMILARITY_GRAPH_SENTENCE_CAP
    ? sentences.map((_, order) => order)
    : sentences
        .map((_, order) => ({ order, weight: allWeight(unitsPer[order]!) }))
        .sort((left, right) => right.weight - left.weight)
        .slice(0, SIMILARITY_GRAPH_SENTENCE_CAP)
        .map(row => row.order)
        .sort((left, right) => left - right);
  const sourceOrder = considered;
  const keptSentences = considered.map(order => sentences[order]!);
  const keptUnits = considered.map(order => unitsPer[order]!);
  const total = keptSentences.length;
  const vectors = keptUnits.map(units => {
    const weights = new Map<string, number>();
    for (const unit of units) {
      const df = sentenceFrequency.get(unit) ?? 1;
      const idf = Math.log(total / df) + 1;
      weights.set(unit, (weights.get(unit) ?? 0) + idf);
    }
    return { weights, units: units.length };
  });

  // How much of this source's information the two sentences share, damped by how much each of them holds.
  const sharedInformation = (left: number, right: number): number => {
    const a = vectors[left]!;
    const b = vectors[right]!;
    if (!a.weights.size || !b.weights.size) return 0;
    const [small, large] = a.weights.size <= b.weights.size ? [a, b] : [b, a];
    let shared = 0;
    for (const [unit, weight] of small.weights) {
      const other = large.weights.get(unit);
      if (other !== undefined) shared += Math.min(weight, other);
    }
    const damping = Math.log(a.units + 1) + Math.log(b.units + 1);
    return damping > 0 ? shared / damping : 0;
  };

  const similarities: number[][] = [];
  const observed: number[] = [];
  let ceiling = 0;
  for (let row = 0; row < total; row += 1) similarities.push(new Array<number>(total).fill(0));
  for (let row = 0; row < total; row += 1) {
    for (let column = row + 1; column < total; column += 1) {
      const value = sharedInformation(row, column);
      similarities[row]![column] = value;
      similarities[column]![row] = value;
      if (value > 0) {
        observed.push(value);
        if (value > ceiling) ceiling = value;
      }
    }
  }
  if (!observed.length) return keptSentences.map((sentence, index) => ({ text: sentence, order: sourceOrder[index]!, centrality: 0 }));

  // An edge exists where the similarity is in the upper class of what this source's sentences actually reach. A
  // fixed cut-off would summarize a technical manual and a novel by the same standard; they share no scale. Shared
  // information is unbounded above, so the observed values are scaled by their own peak before the Otsu histogram.
  const edgeThreshold = ceiling > 0
    ? concentrationThreshold(observed.map(value => Math.round((value / ceiling) * OTSU_SCALE)), OTSU_SCALE) / OTSU_SCALE * ceiling
    : 0;
  const centrality = new Array<number>(total).fill(0);
  for (let row = 0; row < total; row += 1) {
    for (let column = 0; column < total; column += 1) {
      if (row === column) continue;
      const value = similarities[row]![column]!;
      if (value >= edgeThreshold) centrality[row] = (centrality[row] ?? 0) + value;
    }
  }
  let peak = 0;
  for (const value of centrality) if (value > peak) peak = value;
  return keptSentences.map((sentence, index) => ({
    text: sentence,
    order: sourceOrder[index]!,
    centrality: peak > 0 ? (centrality[index] ?? 0) / peak : 0
  }));
}

/**
 * The central sentences of a source, in the order the source states them, bounded by how many characters the caller
 * can speak. Document order matters: a summary whose sentences are ranked by score reads as a list of fragments,
 * while the same sentences in the source's own order read as an account of it.
 */
export function summarizeSource(input: {
  text: string;
  closedClass: ReadonlySet<string>;
  maxChars: number;
}): string {
  const scored = centralSentences(input.text, input.closedClass);
  if (!scored.length) return "";
  const values = scored.map(sentence => Math.round(sentence.centrality * OTSU_SCALE)).filter(value => value > 0);
  // Which sentences are central is the same kind of question as which similarities are edges, answered the same way.
  const threshold = values.length >= 2 ? concentrationThreshold(values, OTSU_SCALE) / OTSU_SCALE : 0;
  const central = scored.filter(sentence => sentence.centrality >= threshold && sentence.centrality > 0);
  const chosen = (central.length ? central : scored)
    .slice()
    .sort((left, right) => right.centrality - left.centrality);
  const kept: SourceSummarySentence[] = [];
  const spoken = new Set<string>();
  let used = 0;
  for (const sentence of chosen) {
    // A source that repeats a line -- a refrain, a reprinted extract, a chunk overlapping its neighbour -- makes that
    // line maximally central, so the summary said it several times over. Each distinct sentence is spoken once.
    const key = sentence.text.normalize("NFC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
    if (spoken.has(key)) continue;
    const cost = sentence.text.length + (kept.length ? 1 : 0);
    if (used + cost > input.maxChars) continue;
    spoken.add(key);
    kept.push(sentence);
    used += cost;
  }
  return kept
    .sort((left, right) => left.order - right.order)
    .map(sentence => sentence.text)
    .join(" ");
}

export interface SourceSummaryExcerpt {
  /** The central sentences, in the source's own order. */
  readonly text: string;
  /** Positions in the caller's span list that the spoken sentences came from, for citation. */
  readonly spokenFrom: number[];
}

/**
 * What one source says, spoken out of the spans a turn actually admitted, or nothing.
 *
 * The turn hands over the spans it admitted; those belonging to the source most of them belong to are summarized
 * together, and the result is returned only when every sentence of it is found inside one of those spans. A summary
 * that cannot be located in the evidence is not a summary of it, so the caller gets nothing rather than prose it
 * cannot cite. Pure: no clock, no storage, no corpus beyond the spans and the scaffolding passed in.
 */
export function summarizeAdmittedSource(input: {
  spans: readonly { sourceKey: string; text: string }[];
  closedClass: ReadonlySet<string>;
  maxChars: number;
}): SourceSummaryExcerpt | undefined {
  const perSource = new Map<string, number[]>();
  for (let index = 0; index < input.spans.length; index += 1) {
    const key = input.spans[index]!.sourceKey;
    perSource.set(key, [...(perSource.get(key) ?? []), index]);
  }
  // One source, or the summary would weld two documents into an account of neither.
  const positions = [...perSource.values()].sort((left, right) => right.length - left.length)[0] ?? [];
  if (!positions.length) return undefined;
  const texts = positions.map(position => input.spans[position]!.text);
  const summary = summarizeSource({ text: texts.join("\n\n"), closedClass: input.closedClass, maxChars: input.maxChars });
  if (!summary) return undefined;
  const comparable = texts.map(text => collapseSurfaceWhitespace(text));
  const sentences = splitSurfaceSentences(summary).map(sentence => collapseSurfaceWhitespace(sentence)).filter(Boolean);
  if (!sentences.length) return undefined;
  if (!sentences.every(sentence => comparable.some(text => text.includes(sentence)))) return undefined;
  const spokenFrom = positions.filter((_, index) => sentences.some(sentence => comparable[index]!.includes(sentence)));
  return spokenFrom.length ? { text: summary, spokenFrom } : undefined;
}
