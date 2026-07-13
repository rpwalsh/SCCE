import type { IdFactory } from "./ids.js";
import type { LanguageCompetenceVector, LanguageProfile, SourceVersionId } from "./types.js";
import { clamp01, entropy, symbolizeData } from "./primitives.js";
import { compactKneserNeyForProfile, trainKneserNey } from "./kneser-ney.js";
import { createNgramProseAnalyzer } from "./ngram-prose.js";

export function createLanguageAcquisitionEngine(options: { idFactory: IdFactory }) {
  const prose = createNgramProseAnalyzer({ maxOrder: 6, topK: 128 });
  return {
    acquire(input: { sourceVersionId: SourceVersionId; text: string; createdAt: number }): LanguageProfile {
      const chars = [...input.text.normalize("NFC")].filter(char => !/\s/u.test(char));
      const scripts = scriptMass(chars);
      const symbols = symbolizeData(input.text).slice(0, 10000);
      const shapeCounts = count(symbols.map(symbolShape));
      const ngrams = count(charNgrams(chars.join("").toLowerCase(), 3));
      const kneserNey = trainKneserNey(symbols, { order: 6, discount: 0.75, vocabularyLimit: 12000 });
      const ngramProfile = prose.analyze(input.text);
      const values = [...ngrams.values()];
      const direction = directionFrom(chars);
      const competenceVector = competenceFrom({ chars, symbols, scripts, ngramProfile });
      return {
        id: options.idFactory.semanticId("language_profile", { sourceVersionId: input.sourceVersionId, scripts, top: [...ngrams.entries()].slice(0, 16) }),
        sourceVersionId: input.sourceVersionId,
        scripts: [...scripts.entries()].map(([script, mass]) => ({ script, mass })),
        symbolShapes: [...shapeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 64).map(([shape, c]) => ({ shape, count: c })),
        charNgrams: [...ngrams.entries()].sort((a, b) => b[1] - a[1]).slice(0, 256).map(([ngram, c]) => ({ ngram, count: c })),
        direction,
        entropy: entropy(values),
        competenceVector,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        kneserNey: compactKneserNeyForProfile(kneserNey, input.text),
        ngramProfile: ngramProfile.audit
      };
    }
  };
}

function scriptMass(chars: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const char of chars) counts.set(scriptOf(char), (counts.get(scriptOf(char)) ?? 0) + 1);
  const total = Math.max(1, chars.length);
  return new Map([...counts.entries()].sort((a, b) => b[1] - a[1]).map(([script, count]) => [script, count / total]));
}

function scriptOf(char: string): string {
  if (/\p{Script=Latin}/u.test(char)) return "script:Latn";
  if (/\p{Script=Arabic}/u.test(char)) return "script:Arab";
  if (/\p{Script=Hebrew}/u.test(char)) return "script:Hebr";
  if (/\p{Script=Han}/u.test(char)) return "script:Hani";
  if (/\p{Script=Hangul}/u.test(char)) return "script:Hang";
  if (/\p{Script=Hiragana}/u.test(char)) return "script:Hira";
  if (/\p{Script=Katakana}/u.test(char)) return "script:Kana";
  if (/\p{Script=Cyrillic}/u.test(char)) return "script:Cyrl";
  if (/\p{Script=Devanagari}/u.test(char)) return "script:Deva";
  if (/\p{Script=Thai}/u.test(char)) return "script:Thai";
  if (/\p{Script=Greek}/u.test(char)) return "script:Greek";
  if (/\p{Number}/u.test(char)) return "script:Zyyy:number";
  return "script:Zxxx";
}

function directionFrom(chars: string[]): LanguageProfile["direction"] {
  const rtl = chars.filter(char => /\p{Script=Arabic}|\p{Script=Hebrew}/u.test(char)).length;
  const ltr = chars.filter(char => /\p{Script=Latin}|\p{Script=Cyrillic}|\p{Script=Han}|\p{Script=Hangul}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(char)).length;
  if (rtl > 0 && ltr > 0) return "mixed";
  if (rtl > 0) return "rtl";
  if (ltr > 0) return "ltr";
  return "unknown";
}

function symbolShape(symbol: string): string {
  return [...symbol].map(char => (/\p{Letter}/u.test(char) ? "L" : /\p{Number}/u.test(char) ? "N" : "P")).join("");
}

function charNgrams(text: string, n: number): string[] {
  const chars = [...text];
  const out: string[] = [];
  for (let i = 0; i <= chars.length - n; i++) out.push(chars.slice(i, i + n).join(""));
  return out;
}

function count(values: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const value of values) out.set(value, (out.get(value) ?? 0) + 1);
  return out;
}

function competenceFrom(input: {
  chars: string[];
  symbols: string[];
  scripts: Map<string, number>;
  ngramProfile: ReturnType<ReturnType<typeof createNgramProseAnalyzer>["analyze"]>;
}): LanguageCompetenceVector {
  const dominantScriptMass = Math.max(0, ...input.scripts.values());
  const uniqueSymbols = new Set(input.symbols).size;
  const symbolCount = input.symbols.length;
  const symbolOrders = input.ngramProfile.symbolOrders;
  const highOrder = Math.max(0, ...symbolOrders.filter(order => order.order >= 3).map(order => order.total));
  const cadence = input.ngramProfile.cadence;
  const scriptRecognition = clamp01(dominantScriptMass * Math.min(1, input.chars.length / 24));
  const segmentationQuality = clamp01(symbolCount ? Math.min(1, symbolCount / 512) * (uniqueSymbols / Math.max(1, symbolCount)) ** 0.25 : 0);
  const lexicalCoverage = clamp01(Math.log2(1 + uniqueSymbols) / 15);
  const phraseFluency = clamp01(Math.log2(1 + highOrder) / 16);
  const syntacticCoverage = clamp01(Math.min(1, cadence.sentenceCount / 64) * (1 - Math.min(0.7, cadence.symbolRate)));
  const generationReliability = clamp01(0.34 * lexicalCoverage + 0.33 * phraseFluency + 0.33 * segmentationQuality);
  return {
    scriptRecognition,
    segmentationQuality,
    lexicalCoverage,
    phraseFluency,
    syntacticCoverage,
    semanticFrameCoverage: 0,
    translationAlignment: 0,
    entailmentReliability: 0,
    generationReliability,
    correctionStability: 0,
    localizationReliability: 0
  };
}
