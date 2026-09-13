// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { concentrationThreshold, corpusIdentityUnits } from "./corpus-identity.js";
import { splitSurfaceSentences } from "./surface-linguistics.js";

/**
 * What a source says, compressed to the sentences that carry it.
 *
 * A corpus that holds a novel but no article about the novel could answer nothing about it: the answerhood gate
 * requires the request's relation to appear in the answering sentence, and a novel's prose never says "plot". The
 * source's own sentences are the answer -- the question is which of them, and that is a measurement, not a guess.
 *
 * Degree centrality over a sentence similarity graph, the classical extractive summary. Each sentence is a vector of
 * its content units weighted by inverse sentence frequency, similarity is the cosine between them, and a sentence's
 * centrality is how much of the rest of the source it resembles. A sentence that restates what many others say is
 * about the source; one that resembles nothing is an aside. Every sentence returned is verbatim, so nothing is
 * invented, and it reads the same way in any script: the units come from the writing system's own boundaries and the
 * weights from this text's own statistics.
 *
 * Two thresholds, neither declared: which similarities count as an edge, and which centralities count as central.
 * Both are Otsu splits of the values actually observed here, the same method the corpus identity arbiter uses.
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

export function centralSentences(text: string, closedClass: ReadonlySet<string>): SourceSummarySentence[] {
  const sentences = splitSurfaceSentences(text)
    .map(sentence => sentence.trim())
    .filter(Boolean);
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
    let norm = 0;
    for (const weight of weights.values()) norm += weight * weight;
    return { weights, norm: Math.sqrt(norm) };
  });

  const cosine = (left: number, right: number): number => {
    const a = vectors[left]!;
    const b = vectors[right]!;
    if (!a.norm || !b.norm) return 0;
    const [small, large] = a.weights.size <= b.weights.size ? [a, b] : [b, a];
    let dot = 0;
    for (const [unit, weight] of small.weights) {
      const other = large.weights.get(unit);
      if (other !== undefined) dot += weight * other;
    }
    return dot / (a.norm * b.norm);
  };

  const similarities: number[][] = [];
  const observed: number[] = [];
  for (let row = 0; row < total; row += 1) similarities.push(new Array<number>(total).fill(0));
  for (let row = 0; row < total; row += 1) {
    for (let column = row + 1; column < total; column += 1) {
      const value = cosine(row, column);
      similarities[row]![column] = value;
      similarities[column]![row] = value;
      if (value > 0) observed.push(Math.round(value * OTSU_SCALE));
    }
  }
  if (!observed.length) return keptSentences.map((sentence, index) => ({ text: sentence, order: sourceOrder[index]!, centrality: 0 }));

  // An edge exists where the similarity is in the upper class of what this source's sentences actually reach. A
  // fixed cut-off would summarize a technical manual and a novel by the same standard; they share no scale.
  const edgeThreshold = concentrationThreshold(observed, OTSU_SCALE) / OTSU_SCALE;
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
