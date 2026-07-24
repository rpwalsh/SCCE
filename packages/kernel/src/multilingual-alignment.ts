import type { Clock, EvidenceId, SourceVersionId } from "./types.js";
import type { IdFactory } from "./ids.js";
import { createIdFactory } from "./ids.js";
import { createClock, createHasher, mean, toJsonValue } from "./primitives.js";
import type {
  AlignmentObservation,
  LexicalAlignmentModel,
  PhraseAlignmentModel,
  UserCorrectionAlignmentRecord
} from "./storage.js";

export interface AlignmentCorpusInput {
  sourceLanguage: string;
  targetLanguage: string;
  sentencePairs: Array<{
    sourceText: string;
    targetText: string;
    confidence?: number;
  }>;
  documentPairs?: Array<{
    sourceDoc: string;
    targetDoc: string;
    topicAnchors?: string[];
  }>;
  dictionaryTerms?: Array<{
    sourceTerm: string;
    targetTerm: string;
    partOfSpeech?: string;
  }>;
  userCorrections?: UserCorrectionAlignmentRecord[];
  corpusType: "parallel_sentences" | "comparable_documents" | "dictionary" | "locale_bundle" | "aligned_wikipedia" | "user_corrections" | "mixed";
  sourceVersionId?: SourceVersionId;
  evidenceIds: EvidenceId[];
}

export interface AlignedPair {
  sourceSymbol: string;
  targetSymbol: string;
  alignmentBasis: "lexical_overlap" | "positional_window" | "semantic_similarity" | "anchor_shared" | "external_resource" | "user_correction";
  score: number;
  pmiScore: number;
  diceScore: number;
  cooccurrenceCount: number;
}

export interface TranslationAlignmentScore {
  lexicalScore: number;
  phraseScore: number;
  frameScore: number;
  anchorScore: number;
  correctionBoost: number;
  hallucinationPenalty: number;
  finalScore: number;
}

const EMPTY_LEXICAL_MODEL: LexicalAlignmentModel = {
  id: "",
  sourceLanguage: "",
  targetLanguage: "",
  alignmentVersion: 0,
  lexicalTable: {},
  reverseTable: {},
  alignmentCounts: { totalPairs: 0, uniqueSourceTerms: 0, uniqueTargetTerms: 0 },
  perplexity: 0,
  trainingCorpora: [],
  updatedAt: 0
};

const EMPTY_PHRASE_MODEL: PhraseAlignmentModel = {
  id: "",
  sourceLanguage: "",
  targetLanguage: "",
  alignmentVersion: 0,
  phraseTable: [],
  topPhraseCoverage: 0,
  trainingCorpora: [],
  updatedAt: 0
};

export function createAlignmentEngine(options: {
  clock?: Clock;
  idFactory?: Pick<IdFactory, "semanticId"> | { next(): string };
} = {}) {
  const clock = options.clock ?? createClock();
  const idFactory = options.idFactory ?? createIdFactory({
    clock,
    hasher: createHasher(),
    deterministicReplay: true
  });
  const nextId = (kind: string, representation: unknown): string =>
    "semanticId" in idFactory
      ? idFactory.semanticId(kind, representation)
      : idFactory.next();

  return {
    trainLexicalAlignment(corpus: AlignmentCorpusInput): LexicalAlignmentModel {
      const updatedAt = clock.now();
      const lexicalTable: Record<string, Record<string, number>> = {};
      const reverseTable: Record<string, Record<string, number>> = {};
      const cooccurrence: Map<string, Map<string, number>> = new Map();

      // Initialize from dictionary terms if available
      if (corpus.dictionaryTerms && corpus.dictionaryTerms.length > 0) {
        for (const term of corpus.dictionaryTerms) {
          const sourceTerm = normalize(term.sourceTerm);
          const targetTerm = normalize(term.targetTerm);
          incrementMap(lexicalTable, sourceTerm, targetTerm, 2);
          incrementMap(reverseTable, targetTerm, sourceTerm, 2);
          incrementCooccurrence(cooccurrence, sourceTerm, targetTerm, 2);
        }
      }

      // Extract word alignments from sentence pairs (IBM Model 1-style)
      for (const pair of corpus.sentencePairs) {
        const sourceTokens = tokenize(pair.sourceText);
        const targetTokens = tokenize(pair.targetText);
        const weight = pair.confidence ?? 1.0;

        for (const sourceToken of sourceTokens) {
          for (const targetToken of targetTokens) {
            incrementMap(lexicalTable, sourceToken, targetToken, weight);
            incrementMap(reverseTable, targetToken, sourceToken, weight);
            incrementCooccurrence(cooccurrence, sourceToken, targetToken, weight);
          }
        }
      }

      // Learn user corrections with high alpha
      if (corpus.userCorrections && corpus.userCorrections.length > 0) {
        for (const correction of corpus.userCorrections) {
          for (const changed of correction.changedTerms) {
            const sourceNorm = normalize(changed.original);
            const targetNorm = normalize(changed.corrected);
            const boost = correction.alpha * 5;
            incrementMap(lexicalTable, sourceNorm, targetNorm, boost);
            incrementMap(reverseTable, targetNorm, sourceNorm, boost);
            incrementCooccurrence(cooccurrence, sourceNorm, targetNorm, boost);
          }
        }
      }

      // Normalize to probabilities
      for (const sourceTerm in lexicalTable) {
        const targets = lexicalTable[sourceTerm];
        if (targets) {
          const sum = Object.values(targets).reduce((a, b) => a + b, 0);
          if (sum > 0) {
            for (const targetTerm in targets) {
              const current = targets[targetTerm];
              if (typeof current === "number") {
                targets[targetTerm] = current / sum;
              }
            }
          }
        }
      }

      for (const targetTerm in reverseTable) {
        const sources = reverseTable[targetTerm];
        if (sources) {
          const sum = Object.values(sources).reduce((a, b) => a + b, 0);
          if (sum > 0) {
            for (const sourceTerm in sources) {
              const current = sources[sourceTerm];
              if (typeof current === "number") {
                sources[sourceTerm] = current / sum;
              }
            }
          }
        }
      }

      const totalPairs = Object.values(lexicalTable)
        .reduce((sum, targets) => sum + Object.values(targets).length, 0);

      return {
        id: nextId("lexical_alignment_model", {
          sourceLanguage: corpus.sourceLanguage,
          targetLanguage: corpus.targetLanguage,
          corpusType: corpus.corpusType,
          sourceVersionId: corpus.sourceVersionId,
          evidenceIds: corpus.evidenceIds,
          updatedAt
        }),
        sourceLanguage: corpus.sourceLanguage,
        targetLanguage: corpus.targetLanguage,
        alignmentVersion: 1,
        lexicalTable,
        reverseTable,
        alignmentCounts: {
          totalPairs,
          uniqueSourceTerms: Object.keys(lexicalTable).length,
          uniqueTargetTerms: Object.keys(reverseTable).length
        },
        perplexity: computePerplexity(lexicalTable, corpus.sentencePairs),
        trainingCorpora: [`corpus_${corpus.corpusType}`],
        updatedAt
      };
    },

    trainPhraseAlignment(corpus: AlignmentCorpusInput, lexicalModel: LexicalAlignmentModel): PhraseAlignmentModel {
      const updatedAt = clock.now();
      const phraseTable: Map<string, Map<string, { fwd: number; rev: number; cooc: number }>> = new Map();
      const maxPhraseLength = 4;

      for (const pair of corpus.sentencePairs) {
        const sourceTokens = tokenize(pair.sourceText);
        const targetTokens = tokenize(pair.targetText);
        const weight = pair.confidence ?? 1.0;

        // Extract phrase pairs using window-based heuristic
        for (let sLen = 1; sLen <= Math.min(maxPhraseLength, sourceTokens.length); sLen++) {
          for (let sIdx = 0; sIdx <= sourceTokens.length - sLen; sIdx++) {
            const sourcePhrase = sourceTokens.slice(sIdx, sIdx + sLen).join(" ");

            // Positional window: allow target phrases near the expected position
            const targetWindow = Math.max(0, Math.floor((sIdx / sourceTokens.length) * targetTokens.length) - 1);
            const targetEnd = Math.min(targetTokens.length, Math.ceil(((sIdx + sLen) / sourceTokens.length) * targetTokens.length) + 1);

            for (let tLen = 1; tLen <= Math.min(maxPhraseLength, targetEnd - targetWindow); tLen++) {
              for (let tIdx = Math.max(targetWindow, 0); tIdx <= targetEnd - tLen; tIdx++) {
                const targetPhrase = targetTokens.slice(tIdx, tIdx + tLen).join(" ");

                // Compute forward and reverse probabilities using lexical alignment
                const fwdProb = estimatePhraseProbability(sourcePhrase, targetPhrase, lexicalModel.lexicalTable);
                const revProb = estimatePhraseProbability(targetPhrase, sourcePhrase, lexicalModel.reverseTable);

                if (fwdProb > 0.05 || revProb > 0.05) {
                  if (!phraseTable.has(sourcePhrase)) {
                    phraseTable.set(sourcePhrase, new Map());
                  }
                  const targets = phraseTable.get(sourcePhrase)!;
                  const entry = targets.get(targetPhrase) ?? { fwd: 0, rev: 0, cooc: 0 };
                  entry.fwd += fwdProb * weight;
                  entry.rev += revProb * weight;
                  entry.cooc += weight;
                  targets.set(targetPhrase, entry);
                }
              }
            }
          }
        }
      }

      // Convert to sorted array with scores
      const phraseArray: PhraseAlignmentModel["phraseTable"] = [];
      let topCoverage = 0;

      for (const [sourcePhrase, targets] of phraseTable) {
        for (const [targetPhrase, scores] of targets) {
          const diceScore = (2 * scores.cooc) / (1 + 1);
          const pmiScore = Math.log((scores.cooc * corpus.sentencePairs.length) / Math.max(1, scores.fwd * scores.rev + 1));
          const score = (scores.fwd + scores.rev) / 2;

          if (score > 0.01) {
            phraseArray.push({
              sourcePhrase,
              targetPhrase,
              forwardProb: scores.fwd / Math.max(1, scores.cooc),
              reverseProb: scores.rev / Math.max(1, scores.cooc),
              lexicalWeights: { forward: scores.fwd, reverse: scores.rev },
              diceScore,
              pmiScore: Math.max(-10, Math.min(10, pmiScore)),
              cooccurrenceCount: scores.cooc,
              evidenceCount: Math.round(scores.cooc)
            });
            topCoverage = Math.max(topCoverage, score);
          }
        }
      }

      // Sort by combined score
      phraseArray.sort((a, b) => {
        const scoreA = (a.forwardProb + a.reverseProb) / 2 + a.diceScore * 0.1;
        const scoreB = (b.forwardProb + b.reverseProb) / 2 + b.diceScore * 0.1;
        return scoreB - scoreA;
      });

      return {
        id: nextId("phrase_alignment_model", {
          lexicalModelId: lexicalModel.id,
          sourceLanguage: corpus.sourceLanguage,
          targetLanguage: corpus.targetLanguage,
          corpusType: corpus.corpusType,
          sourceVersionId: corpus.sourceVersionId,
          evidenceIds: corpus.evidenceIds,
          updatedAt
        }),
        sourceLanguage: corpus.sourceLanguage,
        targetLanguage: corpus.targetLanguage,
        alignmentVersion: 1,
        phraseTable: phraseArray.slice(0, 10000),
        topPhraseCoverage: topCoverage,
        trainingCorpora: [`corpus_${corpus.corpusType}`],
        updatedAt
      };
    },

    scoreAlignment(input: {
      sourceText: string;
      targetText: string;
      lexicalModel: LexicalAlignmentModel;
      phraseModel: PhraseAlignmentModel;
      userCorrections?: UserCorrectionAlignmentRecord[];
      protectedTerms?: string[];
      preservedEntities?: string[];
    }): TranslationAlignmentScore {
      const lexicalScore = scoreLexicalAlignment(input.sourceText, input.targetText, input.lexicalModel);
      const phraseScore = scorePhraseAlignment(input.sourceText, input.targetText, input.phraseModel);
      const anchorScore = scoreAnchorPreservation(input.sourceText, input.targetText, input.preservedEntities ?? []);

      let correctionBoost = 0;
      if (input.userCorrections && input.userCorrections.length > 0) {
        correctionBoost = input.userCorrections.reduce((sum, c) => sum + c.alpha, 0) / Math.max(1, input.userCorrections.length);
      }

      const hallucinationPenalty = detectHallucination(input.targetText, input.sourceText, input.protectedTerms ?? []);

      const finalScore = clamp01(
        0.35 * lexicalScore +
        0.28 * phraseScore +
        0.18 * anchorScore +
        0.12 * correctionBoost +
        0.07 -
        0.08 * hallucinationPenalty
      );

      return {
        lexicalScore,
        phraseScore,
        frameScore: 0.5,
        anchorScore,
        correctionBoost,
        hallucinationPenalty,
        finalScore
      };
    },

    extractAlignmentObservations(corpus: AlignmentCorpusInput): AlignmentObservation[] {
      const observedAt = clock.now();
      const observations: AlignmentObservation[] = [];
      const cooccurrence: Map<string, Map<string, number>> = new Map();

      for (const pair of corpus.sentencePairs) {
        const sourceTokens = tokenize(pair.sourceText);
        const targetTokens = tokenize(pair.targetText);
        const weight = pair.confidence ?? 1.0;

        for (const sourceTok of sourceTokens) {
          for (const targetTok of targetTokens) {
            incrementCooccurrence(cooccurrence, sourceTok, targetTok, weight);
          }
        }
      }

      for (const [sourceSymbol, targets] of cooccurrence) {
        for (const [targetSymbol, count] of targets) {
          const pmiScore = computePmi(count, corpus.sentencePairs.length);
          const diceScore = (2 * count) / (1 + 1);

          observations.push({
            id: `obs_${sourceSymbol}_${targetSymbol}`,
            sourceLanguage: corpus.sourceLanguage,
            targetLanguage: corpus.targetLanguage,
            sourceSymbol,
            targetSymbol,
            alignmentBasis: "lexical_overlap",
            score: Math.min(1, count / 10),
            context: { sourceLeft: [], sourceRight: [], targetLeft: [], targetRight: [] },
            cooccurrenceCount: count,
            pmiScore,
            diceScore,
            corpusId: `corpus_${corpus.corpusType}`,
            sourceVersionId: corpus.sourceVersionId,
            evidenceIds: corpus.evidenceIds,
            observedAt
          });
        }
      }

      return observations;
    }
  };
}

function normalize(text: string): string {
  return text.toLowerCase().trim();
}

function tokenize(text: string): string[] {
  return text
    .split(/[\s\p{P}]+/gu)
    .map(t => normalize(t))
    .filter(t => t.length > 0);
}

function incrementMap(map: Record<string, Record<string, number>>, key: string, value: string, delta: number): void {
  if (!map[key]) {
    map[key] = {};
  }
  map[key][value] = (map[key][value] ?? 0) + delta;
}

function incrementCooccurrence(map: Map<string, Map<string, number>>, key: string, value: string, delta: number): void {
  if (!map.has(key)) {
    map.set(key, new Map());
  }
  const targets = map.get(key)!;
  targets.set(value, (targets.get(value) ?? 0) + delta);
}

function scoreLexicalAlignment(sourceText: string, targetText: string, model: LexicalAlignmentModel): number {
  const sourceTokens = tokenize(sourceText);
  const targetTokens = tokenize(targetText);

  if (sourceTokens.length === 0 || targetTokens.length === 0) return 0;

  let alignmentMass = 0;
  let totalLookups = 0;

  for (const sourceTok of sourceTokens) {
    const targets = model.lexicalTable[sourceTok];
    if (targets) {
      const best = Math.max(...Object.values(targets));
      alignmentMass += best;
    }
    totalLookups++;
  }

  return totalLookups > 0 ? clamp01(alignmentMass / totalLookups) : 0;
}

function scorePhraseAlignment(sourceText: string, targetText: string, model: PhraseAlignmentModel): number {
  if (model.phraseTable.length === 0) return 0;

  const sourceTokens = tokenize(sourceText);
  let coverage = 0;
  let totalCovered = 0;

  for (let i = 0; i < sourceTokens.length; i++) {
    for (let len = 1; len <= Math.min(4, sourceTokens.length - i); len++) {
      const phrase = sourceTokens.slice(i, i + len).join(" ");
      const match = model.phraseTable.find(p => p.sourcePhrase === phrase);
      if (match) {
        coverage += (match.forwardProb + match.reverseProb) / 2;
        totalCovered++;
      }
    }
  }

  return totalCovered > 0 ? clamp01(coverage / totalCovered) : 0.3;
}

function scoreAnchorPreservation(sourceText: string, targetText: string, preservedEntities: string[]): number {
  if (preservedEntities.length === 0) return 0.5;

  const sourceTokens = new Set(tokenize(sourceText));
  const targetTokens = new Set(tokenize(targetText));
  const preserved = preservedEntities.filter(entity => {
    if (targetText.includes(entity) || sourceText.includes(entity)) return true;
    const norm = normalize(entity);
    return sourceTokens.has(norm) || targetTokens.has(norm);
  });
  const numberAnchors = Array.from(new Set((sourceText.match(/\d+(?:\.\d+)?/g) ?? [])));
  const preservedNumbers = numberAnchors.filter(num => targetText.includes(num)).length;
  const base = preserved.length / preservedEntities.length;
  const numeric = numberAnchors.length > 0 ? preservedNumbers / numberAnchors.length : 1;
  return clamp01(0.8 * base + 0.2 * numeric);
}

function detectHallucination(targetText: string, sourceText: string, protectedTerms: string[]): number {
  const targetTokens = new Set(tokenize(targetText));
  const sourceTokens = new Set(tokenize(sourceText));

  const unaligned = Array.from(targetTokens).filter(t => !sourceTokens.has(t));
  const unalignedCount = unaligned.length;

  const hallucinationRisk = unalignedCount / Math.max(1, targetTokens.size);
  return clamp01(hallucinationRisk * 0.5);
}

function estimatePhraseProbability(sourcePhrase: string, targetPhrase: string, lexicalTable: Record<string, Record<string, number>>): number {
  const sourceTokens = tokenize(sourcePhrase);
  const targetTokens = tokenize(targetPhrase);

  if (sourceTokens.length === 0 || targetTokens.length === 0) return 0.01;

  let prob = 0;
  for (const sourceTok of sourceTokens) {
    for (const targetTok of targetTokens) {
      const p = lexicalTable[sourceTok]?.[targetTok] ?? 0.01;
      prob = Math.max(prob, p);
    }
  }

  return Math.pow(prob, 1 / (sourceTokens.length + targetTokens.length));
}

function computePerplexity(lexicalTable: Record<string, Record<string, number>>, pairs: Array<{ sourceText: string; targetText: string; confidence?: number }>): number {
  let logProb = 0;
  let totalWords = 0;

  for (const pair of pairs) {
    const targetTokens = tokenize(pair.targetText);
    for (const token of targetTokens) {
      logProb += Math.log(0.1);
      totalWords++;
    }
  }

  return totalWords > 0 ? Math.exp(-logProb / totalWords) : 50;
}

function computePmi(cooc: number, totalPairs: number): number {
  if (cooc < 2) return -10;
  const pmi = Math.log((cooc * totalPairs) / Math.max(1, cooc * cooc));
  return Math.max(-10, Math.min(10, pmi));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
