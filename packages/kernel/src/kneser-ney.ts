import { clamp01, symbolizeData, toJsonValue } from "./primitives.js";
import type { JsonValue } from "./types.js";

export interface KneserNeyModel {
  order: number;
  discount: number;
  observedSymbolCount: number;
  vocabularySize: number;
  counts: Record<string, number>;
  contextCounts: Record<string, number>;
  continuationCounts: Record<string, number>;
  contextContinuationTypes: Record<string, number>;
  totalContinuationTypes: number;
  unigramCounts: Record<string, number>;
  totalUnigramCount: number;
  vocabulary: string[];
}

export interface KneserNeyPrediction {
  symbol: string;
  probability: number;
  logProbability: number;
}

export interface KneserNeyDiagnostics {
  order: number;
  discount: number;
  observedSymbolCount: number;
  vocabularySize: number;
  orderSummary: Array<{ order: number; grams: number; contexts: number }>;
  perplexity: number;
  entropyRate: number;
  topContinuations: KneserNeyPrediction[];
}

export interface BoundedProseContinuation {
  symbols: string[];
  text: string;
  logProbability: number;
  averageLogProbability: number;
  stoppedBy: "eos" | "generationExtent" | "probabilityFloor";
  trace: KneserNeyPrediction[];
}

export function trainKneserNey(text: string | readonly string[], options: { order?: number; discount?: number; vocabularyLimit?: number } = {}): KneserNeyModel {
  const order = Math.max(1, Math.min(6, Math.floor(options.order ?? 3)));
  const discount = clamp01(options.discount ?? 0.75);
  const symbols = normalizeSymbols(text);
  const vocabulary = topVocabulary(symbols, options.vocabularyLimit ?? 20000);
  const vocabSet = new Set(vocabulary);
  const normalized = symbols.map(symbol => vocabSet.has(symbol) ? symbol : "<unk>");
  const padded = [...Array(order - 1).fill("<s>"), ...normalized, "</s>"];
  const counts = new Map<string, number>();
  const contextCounts = new Map<string, number>();
  const continuationContexts = new Map<string, Set<string>>();
  const contextContinuationTypes = new Map<string, Set<string>>();
  const unigramCounts = new Map<string, number>();
  for (const symbol of [...normalized, "</s>"]) unigramCounts.set(symbol, (unigramCounts.get(symbol) ?? 0) + 1);
  for (let n = 1; n <= order; n++) {
    for (let i = 0; i <= padded.length - n; i++) {
      const gram = padded.slice(i, i + n);
      const key = gramKey(gram);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (n > 1) {
        const context = gramKey(gram.slice(0, -1));
        const symbol = gram[gram.length - 1]!;
        contextCounts.set(context, (contextCounts.get(context) ?? 0) + 1);
        if (!continuationContexts.has(symbol)) continuationContexts.set(symbol, new Set());
        continuationContexts.get(symbol)!.add(context);
        if (!contextContinuationTypes.has(context)) contextContinuationTypes.set(context, new Set());
        contextContinuationTypes.get(context)!.add(symbol);
      }
    }
  }
  const continuationCounts = new Map<string, number>();
  for (const [symbol, contexts] of continuationContexts) continuationCounts.set(symbol, contexts.size);
  const totalContinuationTypes = [...continuationContexts.values()].reduce((sum, contexts) => sum + contexts.size, 0);
  return {
    order,
    discount,
    observedSymbolCount: normalized.length,
    vocabularySize: vocabulary.length,
    counts: Object.fromEntries(counts),
    contextCounts: Object.fromEntries(contextCounts),
    continuationCounts: Object.fromEntries(continuationCounts),
    contextContinuationTypes: Object.fromEntries([...contextContinuationTypes.entries()].map(([key, set]) => [key, set.size])),
    totalContinuationTypes,
    unigramCounts: Object.fromEntries(unigramCounts),
    totalUnigramCount: [...unigramCounts.values()].reduce((sum, count) => sum + count, 0),
    vocabulary
  };
}

export function kneserNeyProbability(model: KneserNeyModel, context: readonly string[], symbol: string): number {
  const normalizedSymbol = model.vocabulary.includes(symbol) || symbol === "</s>" ? symbol : "<unk>";
  return recursiveProbability(model, context.slice(-(model.order - 1)), normalizedSymbol, model.order);
}

export function predictKneserNey(model: KneserNeyModel, context: readonly string[], limit = 16): KneserNeyPrediction[] {
  const candidates = [...new Set([...model.vocabulary.slice(0, 5000), "</s>"])];
  return candidates
    .map(symbol => {
      const probability = kneserNeyProbability(model, context, symbol);
      return { symbol, probability, logProbability: Math.log(Math.max(1e-300, probability)) };
    })
    .sort((a, b) => b.probability - a.probability || a.symbol.localeCompare(b.symbol))
    .slice(0, limit);
}

export function kneserNeyPerplexity(model: KneserNeyModel, text: string | readonly string[]): number {
  const symbols = normalizeSymbols(text);
  const padded = [...Array(model.order - 1).fill("<s>"), ...symbols, "</s>"];
  let logProb = 0;
  let count = 0;
  for (let i = model.order - 1; i < padded.length; i++) {
    const context = padded.slice(Math.max(0, i - model.order + 1), i);
    const symbol = padded[i]!;
    logProb += Math.log2(Math.max(1e-300, kneserNeyProbability(model, context, symbol)));
    count++;
  }
  return Math.pow(2, -logProb / Math.max(1, count));
}

export function summarizeKneserNey(model: KneserNeyModel, sampleText?: string): KneserNeyDiagnostics {
  const sample = sampleText ? kneserNeyPerplexity(model, sampleText) : NaN;
  const topContinuations = predictKneserNey(model, ["<s>"], 24);
  const entropyRate = -topContinuations.reduce((sum, item) => sum + item.probability * Math.log2(Math.max(1e-300, item.probability)), 0);
  return {
    order: model.order,
    discount: model.discount,
    observedSymbolCount: model.observedSymbolCount,
    vocabularySize: model.vocabularySize,
    orderSummary: orderSummary(model),
    perplexity: Number.isFinite(sample) ? sample : 0,
    entropyRate,
    topContinuations
  };
}

export function continueBoundedProse(model: KneserNeyModel, prompt: string | readonly string[], options: { generationExtent?: number; probabilityFloor?: number; temperature?: number; blockedSymbols?: string[] } = {}): BoundedProseContinuation {
  const context = normalizeSymbols(prompt);
  const generated: string[] = [];
  const trace: KneserNeyPrediction[] = [];
  let logProbability = 0;
  const blocked = new Set(options.blockedSymbols ?? []);
  const generationExtent = options.generationExtent ?? 80;
  const floor = options.probabilityFloor ?? 1e-7;
  const temperature = Math.max(0.05, options.temperature ?? 1);
  let stoppedBy: BoundedProseContinuation["stoppedBy"] = "generationExtent";
  for (let i = 0; i < generationExtent; i++) {
    const predictions = predictKneserNey(model, [...context, ...generated].slice(-(model.order - 1)), 64)
      .filter(item => !blocked.has(item.symbol) && item.symbol !== "<s>");
    const adjusted = predictions.map(item => ({ ...item, probability: Math.pow(item.probability, 1 / temperature) }));
    const total = adjusted.reduce((sum, item) => sum + item.probability, 0);
    const best = adjusted.length ? { ...adjusted[0]!, probability: adjusted[0]!.probability / Math.max(1e-300, total) } : undefined;
    if (!best || best.probability < floor) {
      stoppedBy = "probabilityFloor";
      break;
    }
    if (best.symbol === "</s>") {
      stoppedBy = "eos";
      trace.push(best);
      logProbability += Math.log(Math.max(1e-300, best.probability));
      break;
    }
    generated.push(best.symbol);
    trace.push(best);
    logProbability += Math.log(Math.max(1e-300, best.probability));
  }
  return {
    symbols: generated,
    text: renderSymbols(generated),
    logProbability,
    averageLogProbability: generated.length ? logProbability / generated.length : logProbability,
    stoppedBy,
    trace
  };
}

export function compactKneserNeyForProfile(model: KneserNeyModel, text: string): JsonValue {
  const summary = summarizeKneserNey(model, text);
  const topContinuation = Object.entries(model.continuationCounts).sort((a, b) => b[1] - a[1]).slice(0, 128);
  const topContexts = Object.entries(model.contextContinuationTypes).sort((a, b) => b[1] - a[1]).slice(0, 128);
  return toJsonValue({ summary, topContinuation, topContexts });
}

function orderSummary(model: KneserNeyModel): Array<{ order: number; grams: number; contexts: number }> {
  const out: Array<{ order: number; grams: number; contexts: number }> = [];
  for (let n = 1; n <= model.order; n++) {
    const grams = Object.keys(model.counts).filter(key => key.split("\u0001").length === n).length;
    const contexts = n === 1 ? 1 : Object.keys(model.contextCounts).filter(key => key.split("\u0001").length === n - 1).length;
    out.push({ order: n, grams, contexts });
  }
  return out;
}

function renderSymbols(symbols: readonly string[]): string {
  let out = "";
  for (const symbol of symbols) {
    if (/^[,.;:!?)]$/.test(symbol)) out += symbol;
    else if (/^[(]$/.test(symbol)) out += `${out ? " " : ""}${symbol}`;
    else out += `${out ? " " : ""}${symbol}`;
  }
  return out;
}

function recursiveProbability(model: KneserNeyModel, rawContext: readonly string[], symbol: string, order: number): number {
  if (order <= 1 || rawContext.length === 0) {
    const continuation = model.continuationCounts[symbol] ?? (symbol === "<unk>" ? 1 : 0);
    if (model.totalContinuationTypes > 0 && continuation > 0) return Math.max(1e-12, continuation / model.totalContinuationTypes);
    const unigram = model.unigramCounts[symbol] ?? (symbol === "<unk>" ? 1 : 0);
    return Math.max(1e-12, unigram / Math.max(1, model.totalUnigramCount + (symbol === "<unk>" ? 1 : 0)));
  }
  const context = rawContext.slice(-(order - 1));
  const gram = gramKey([...context, symbol]);
  const contextKey = gramKey(context);
  const count = model.counts[gram] ?? 0;
  const contextCount = model.contextCounts[contextKey] ?? 0;
  const continuationTypes = model.contextContinuationTypes[contextKey] ?? 0;
  if (contextCount <= 0) return recursiveProbability(model, context.slice(1), symbol, order - 1);
  const discounted = Math.max(count - model.discount, 0) / contextCount;
  const lambda = (model.discount * continuationTypes) / contextCount;
  return Math.max(1e-12, discounted + lambda * recursiveProbability(model, context.slice(1), symbol, order - 1));
}

function topVocabulary(symbols: readonly string[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const symbol of symbols) counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
  return ["<unk>", ...[...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, Math.max(1, limit - 1)).map(([symbol]) => symbol)];
}

function gramKey(symbols: readonly string[]): string {
  return symbols.join("\u0001");
}

function normalizeSymbols(value: string | readonly string[]): string[] {
  return typeof value === "string" ? symbolizeData(value) : [...value];
}
