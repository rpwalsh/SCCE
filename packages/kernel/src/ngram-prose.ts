import type { JsonValue } from "./types.js";
import { entropy, toJsonValue, symbolizeData } from "./primitives.js";

export interface NgramProseProfile {
  symbolOrders: Array<{ order: number; total: number; unique: number; entropy: number; top: Array<{ ngram: string; count: number; continuation: number }> }>;
  charOrders: Array<{ order: number; total: number; unique: number; entropy: number; top: Array<{ ngram: string; count: number }> }>;
  boundaryPatterns: Array<{ pattern: string; count: number; ratio: number }>;
  cadence: {
    sentenceCount: number;
    meanSentenceSymbols: number;
    symbolVariance: number;
    punctuationRate: number;
    digitRate: number;
    symbolRate: number;
  };
  audit: JsonValue;
}

export function createNgramProseAnalyzer(options: { maxOrder?: number; topK?: number } = {}) {
  const maxOrder = Math.min(6, Math.max(1, options.maxOrder ?? 6));
  const topK = options.topK ?? 128;
  return {
    analyze(text: string): NgramProseProfile {
      const symbols = symbolizeData(text);
      const chars = [...text.normalize("NFC").toLowerCase()].filter(char => !/\s/u.test(char));
      const symbolOrders = [];
      for (let order = 1; order <= maxOrder; order++) symbolOrders.push(orderStats(symbols, order, topK));
      const charOrders = [];
      for (let order = 1; order <= maxOrder; order++) charOrders.push(charOrderStats(chars, order, topK));
      const boundaryPatterns = boundaryStats(text);
      const cadence = cadenceStats(text);
      return {
        symbolOrders,
        charOrders,
        boundaryPatterns,
        cadence,
        audit: toJsonValue({
          maxOrder,
          symbolCount: symbols.length,
          charCount: chars.length,
          symbolUniqueByOrder: symbolOrders.map(order => [order.order, order.unique]),
          charUniqueByOrder: charOrders.map(order => [order.order, order.unique]),
          cadence
        })
      };
    }
  };
}

function orderStats(symbols: string[], order: number, topK: number): NgramProseProfile["symbolOrders"][number] {
  const counts = new Map<string, number>();
  const continuations = new Map<string, Set<string>>();
  for (let i = 0; i <= symbols.length - order; i++) {
    const gram = symbols.slice(i, i + order).join(" ");
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
    const prefix = symbols.slice(i, i + Math.max(1, order - 1)).join(" ");
    const next = symbols[i + order] ?? "</s>";
    const set = continuations.get(gram) ?? new Set<string>();
    set.add(next);
    continuations.set(gram, set);
    if (order > 1) {
      const prefixSet = continuations.get(prefix) ?? new Set<string>();
      prefixSet.add(symbols[i + order - 1] ?? "</s>");
      continuations.set(prefix, prefixSet);
    }
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topK)
    .map(([ngram, count]) => ({ ngram, count, continuation: continuations.get(ngram)?.size ?? 0 }));
  return { order, total, unique: counts.size, entropy: entropy([...counts.values()]), top };
}

function charOrderStats(chars: string[], order: number, topK: number): NgramProseProfile["charOrders"][number] {
  const counts = new Map<string, number>();
  for (let i = 0; i <= chars.length - order; i++) {
    const gram = chars.slice(i, i + order).join("");
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, topK).map(([ngram, count]) => ({ ngram, count }));
  return { order, total, unique: counts.size, entropy: entropy([...counts.values()]), top };
}

function boundaryStats(text: string): NgramProseProfile["boundaryPatterns"] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const patterns = new Map<string, number>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      patterns.set("blank", (patterns.get("blank") ?? 0) + 1);
      continue;
    }
    const pattern = [
      trimmed.startsWith("#") ? "heading" : "",
      /^\d+[\).\s]/.test(trimmed) ? "numbered" : "",
      /^[-*+]\s/.test(trimmed) ? "bullet" : "",
      /[.!?]$/.test(trimmed) ? "terminal" : "",
      trimmed.includes("|") ? "table-ish" : "",
      /^```/.test(trimmed) ? "code-fence" : ""
    ].filter(Boolean).join("+") || "prose";
    patterns.set(pattern, (patterns.get(pattern) ?? 0) + 1);
  }
  const total = Math.max(1, lines.length);
  return [...patterns.entries()].sort((a, b) => b[1] - a[1]).map(([pattern, count]) => ({ pattern, count, ratio: count / total }));
}

function cadenceStats(text: string): NgramProseProfile["cadence"] {
  const sentences = text.split(/(?<=[.!?])\s+|\n{2,}/u).map(sentence => sentence.trim()).filter(Boolean);
  const sentenceLengths = sentences.map(sentence => symbolizeData(sentence).length);
  const meanSentenceSymbols = sentenceLengths.length ? sentenceLengths.reduce((sum, value) => sum + value, 0) / sentenceLengths.length : 0;
  const symbolVariance = sentenceLengths.length ? sentenceLengths.reduce((sum, value) => sum + (value - meanSentenceSymbols) ** 2, 0) / sentenceLengths.length : 0;
  const chars = [...text];
  const punctuation = chars.filter(char => /\p{Punctuation}/u.test(char)).length;
  const digits = chars.filter(char => /\p{Number}/u.test(char)).length;
  const symbolMarks = chars.filter(char => /\p{Symbol}/u.test(char)).length;
  return {
    sentenceCount: sentences.length,
    meanSentenceSymbols,
    symbolVariance,
    punctuationRate: chars.length ? punctuation / chars.length : 0,
    digitRate: chars.length ? digits / chars.length : 0,
    symbolRate: chars.length ? symbolMarks / chars.length : 0
  };
}
