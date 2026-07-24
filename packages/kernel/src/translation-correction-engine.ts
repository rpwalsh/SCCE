import type { Clock, EpisodeId, EvidenceId, SourceVersionId } from "./types.js";
import type { UserCorrectionAlignmentRecord, TranslationAlignmentRecord } from "./storage.js";
import type { IdFactory } from "./ids.js";
import { createIdFactory } from "./ids.js";
import { clamp01, createClock, createHasher } from "./primitives.js";
import type { JsonValue } from "./types.js";

export interface TranslationFeedback {
  episodeId: EpisodeId;
  sourceLanguage: string;
  targetLanguage: string;
  sourceText: string;
  generatedTranslation: string;
  correctedTranslation: string;
  protectedTerms: string[];
  changedTerms: Array<{ original: string; corrected: string; reason: string }>;
  sourceProfileId: string;
  targetProfileId: string;
  evidenceIds: EvidenceId[];
  translationAlignmentIds?: string[];
}

export interface CompetenceFeedback {
  sourceProfileId: string;
  targetProfileId: string;
  successRate: number;
  correctionCount: number;
  averageAlpha: number;
  lastUpdateAt: number;
  translateAlignmentImprovement: number;
}

export interface RoundTripValidationInput {
  originalLanguage: string;
  sourceLanguage: string;
  targetLanguage: string;
  originalText: string;
  sourceTranslation: string;
  targetTranslation: string;
  backTranslation: string;
  preservedEntities: string[];
  preservedNumbers: string[];
  evidenceIds: EvidenceId[];
}

export interface RoundTripValidationResult {
  passed: boolean;
  semanticSimilarity: number;
  entityPreservation: number;
  numberPreservation: number;
  lossVector: {
    semantic: number;
    roles: number;
    quantity: number;
    register: number;
    terminology: number;
  };
  issues: string[];
  confidence: number;
}

export function createCorrectionEngine(options: {
  clock?: Clock;
  idFactory?: Pick<IdFactory, "semanticId">;
} = {}) {
  const clock = options.clock ?? createClock();
  const idFactory = options.idFactory ?? createIdFactory({
    clock,
    hasher: createHasher(),
    deterministicReplay: true
  });
  return {
    recordFeedback(feedback: TranslationFeedback): UserCorrectionAlignmentRecord {
      const createdAt = clock.now();
      const alignmentDelta = computeAlignmentDelta(feedback.sourceText, feedback.generatedTranslation, feedback.correctedTranslation);

      return {
        id: idFactory.semanticId("user_correction_alignment", {
          episodeId: feedback.episodeId,
          sourceProfileId: feedback.sourceProfileId,
          targetProfileId: feedback.targetProfileId,
          correctedTranslation: feedback.correctedTranslation,
          createdAt
        }),
        sourceLanguage: feedback.sourceLanguage,
        targetLanguage: feedback.targetLanguage,
        sourceText: feedback.sourceText,
        previousOutput: feedback.generatedTranslation,
        correctedOutput: feedback.correctedTranslation,
        sourceProfileId: feedback.sourceProfileId,
        targetProfileId: feedback.targetProfileId,
        protectedTerms: feedback.protectedTerms,
        changedTerms: feedback.changedTerms.map((term) => ({
          original: term.original,
          corrected: term.corrected,
          reason: term.reason
        })),
        alignmentDelta,
        alpha: computeAlpha(feedback),
        episodeId: feedback.episodeId,
        evidenceIds: feedback.evidenceIds,
        createdAt
      };
    },

    computeCompetenceFeedback(corrections: UserCorrectionAlignmentRecord[], alignmentRecords: TranslationAlignmentRecord[]): CompetenceFeedback[] {
      const lastUpdateAt = clock.now();
      const competenceByPair: Map<string, { totalAlpha: number; count: number; corrections: number }> = new Map();

      for (const correction of corrections) {
        const key = `${correction.sourceProfileId}→${correction.targetProfileId}`;
        const entry = competenceByPair.get(key) ?? { totalAlpha: 0, count: 0, corrections: 0 };
        entry.totalAlpha += correction.alpha;
        entry.count++;
        entry.corrections++;
        competenceByPair.set(key, entry);
      }

      for (const alignment of alignmentRecords) {
        const key = `${alignment.sourceLanguage}→${alignment.targetLanguage}`;
        const entry = competenceByPair.get(key) ?? { totalAlpha: 0, count: 0, corrections: 0 };
        entry.count++;
        competenceByPair.set(key, entry);
      }

      const feedback: CompetenceFeedback[] = [];
      for (const [key, entry] of competenceByPair) {
        const [sourceId = "unknown", targetId = "unknown"] = key.split("→");
        feedback.push({
          sourceProfileId: sourceId,
          targetProfileId: targetId,
          successRate: clamp01(1 - entry.corrections / Math.max(1, entry.count)),
          correctionCount: entry.corrections,
          averageAlpha: entry.count > 0 ? entry.totalAlpha / entry.count : 0,
          lastUpdateAt,
          translateAlignmentImprovement: entry.corrections > 0 ? 0.15 * (entry.totalAlpha / entry.count) : 0
        });
      }

      return feedback;
    },

    validateRoundTrip(input: RoundTripValidationInput): RoundTripValidationResult {
      const entityPreservation = computeEntityPreservation(input.sourceTranslation, input.backTranslation, input.preservedEntities);
      const numberPreservation = computeNumberPreservation(input.sourceTranslation, input.backTranslation, input.preservedNumbers);
      const semanticSimilarity = computeSemanticSimilarity(input.sourceTranslation, input.backTranslation);

      const lossVector = {
        semantic: 1 - semanticSimilarity,
        roles: computeRoleLoss(input.sourceTranslation, input.backTranslation),
        quantity: 1 - numberPreservation,
        register: 0.1,
        terminology: 0.08
      };

      const totalLoss = (lossVector.semantic + lossVector.roles + lossVector.quantity) / 3;
      const passed = totalLoss < 0.25 && entityPreservation > 0.9 && numberPreservation > 0.95;

      const issues: string[] = [];
      if (semanticSimilarity < 0.7) issues.push("semantic_drift_detected");
      if (entityPreservation < 0.9) issues.push("entity_loss");
      if (numberPreservation < 0.95) issues.push("number_corruption");

      return {
        passed,
        semanticSimilarity,
        entityPreservation,
        numberPreservation,
        lossVector,
        issues,
        confidence: clamp01(0.8 + semanticSimilarity * 0.2)
      };
    }
  };
}

function computeAlignmentDelta(sourceText: string, generated: string, corrected: string): JsonValue {
  const sourceTokens = tokenize(sourceText);
  const genTokens = tokenize(generated);
  const corrTokens = tokenize(corrected);

  const changes: Array<{ genTok: string; corrTok: string; count: number }> = [];

  for (let i = 0; i < Math.min(genTokens.length, corrTokens.length); i++) {
    if (genTokens[i] !== corrTokens[i]) {
      const existing = changes.find(c => c.genTok === genTokens[i] && c.corrTok === corrTokens[i]);
      if (existing) {
        existing.count++;
      } else {
        changes.push({ genTok: genTokens[i] ?? "", corrTok: corrTokens[i] ?? "", count: 1 });
      }
    }
  }

  return {
    changedTokenPairs: changes,
    generatedLength: genTokens.length,
    correctedLength: corrTokens.length,
    sourceLength: sourceTokens.length
  };
}

function computeAlpha(feedback: TranslationFeedback): number {
  let alpha = 0.6;

  if (feedback.changedTerms.length === 0) {
    alpha = 0.95;
  } else if (feedback.changedTerms.length <= 2) {
    alpha = 0.85;
  } else if (feedback.changedTerms.length <= 5) {
    alpha = 0.75;
  }

  const protectedCorrections = feedback.changedTerms.filter(t => feedback.protectedTerms.includes(t.original));
  if (protectedCorrections.length > 0) {
    alpha += 0.1;
  }

  // Penalize suspicious corrections: original and corrected share no tokens
  const suspiciousTerms = feedback.changedTerms.filter(t => {
    if (!t.original || !t.corrected) return false;
    const origTokens = new Set(t.original.toLowerCase().split(/\s+/u).filter(Boolean));
    const corrTokens = t.corrected.toLowerCase().split(/\s+/u).filter(Boolean);
    const anyShared = corrTokens.some(tok => origTokens.has(tok));
    const drastic = t.original.length > 0 && t.corrected.length > t.original.length * 3;
    return !anyShared && drastic;
  });
  if (suspiciousTerms.length > 0) {
    alpha -= 0.25 * Math.min(1, suspiciousTerms.length / Math.max(1, feedback.changedTerms.length));
  }

  return clamp01(alpha);
}

/** Decay alpha for a correction record based on age relative to a reference timestamp. */
export function decayCorrectionAlpha(record: { alpha: number; createdAt: number }, nowMs: number, halfLifeMs = 7 * 24 * 60 * 60 * 1000): number {
  const ageMs = Math.max(0, nowMs - record.createdAt);
  const halfLives = ageMs / halfLifeMs;
  return clamp01(record.alpha * Math.pow(0.5, halfLives));
}

/**
 * Detects conflicting corrections for the same source term within a set.
 * Returns pairs of correction records that contradict each other.
 */
export function detectConflictingCorrections(
  corrections: Array<{ id: string; changedTerms: Array<{ original: string; corrected: string; reason: string }> }>
): Array<{ correctionIdA: string; correctionIdB: string; term: string; targetA: string; targetB: string }> {
  const termMap = new Map<string, Array<{ correctionId: string; corrected: string }>>();

  for (const correction of corrections) {
    for (const changed of correction.changedTerms) {
      const key = changed.original.toLowerCase().trim();
      if (!key) continue;
      const entry = termMap.get(key) ?? [];
      entry.push({ correctionId: correction.id, corrected: changed.corrected.toLowerCase().trim() });
      termMap.set(key, entry);
    }
  }

  const conflicts: Array<{ correctionIdA: string; correctionIdB: string; term: string; targetA: string; targetB: string }> = [];
  for (const [term, entries] of termMap) {
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i]!;
        const b = entries[j]!;
        if (a.corrected !== b.corrected) {
          conflicts.push({ correctionIdA: a.correctionId, correctionIdB: b.correctionId, term, targetA: a.corrected, targetB: b.corrected });
        }
      }
    }
  }
  return conflicts;
}

function computeEntityPreservation(source: string, backtranslation: string, entities: string[]): number {
  if (entities.length === 0) return 1.0;

  const preserved = entities.filter(entity => backtranslation.includes(entity)).length;
  return clamp01(preserved / entities.length);
}

function computeNumberPreservation(source: string, backtranslation: string, numbers: string[]): number {
  if (numbers.length === 0) return 1.0;

  const sourceNumbers = extractNumbers(source);
  const btNumbers = extractNumbers(backtranslation);

  if (sourceNumbers.length === 0) return 1.0;

  const preserved = sourceNumbers.filter(n => btNumbers.includes(n)).length;
  return clamp01(preserved / sourceNumbers.length);
}

function computeSemanticSimilarity(source: string, backtranslation: string): number {
  const sourceTokens = new Set(tokenize(source).map(normalizeSemanticToken));
  const btTokens = new Set(tokenize(backtranslation).map(normalizeSemanticToken));

  const intersection = Array.from(sourceTokens).filter(t => btTokens.has(t)).length;
  const union = new Set([...sourceTokens, ...btTokens]).size;
  const jaccard = union > 0 ? intersection / union : 0.5;
  const lenRatio = Math.min(source.length, backtranslation.length) / Math.max(source.length, backtranslation.length, 1);
  const overlapOnSource = sourceTokens.size > 0 ? intersection / sourceTokens.size : 0.5;
  return clamp01(0.55 * overlapOnSource + 0.25 * jaccard + 0.2 * lenRatio);
}

function computeRoleLoss(source: string, backtranslation: string): number {
  const lenRatio = Math.min(source.length, backtranslation.length) / Math.max(source.length, backtranslation.length);
  const lenLoss = 1 - lenRatio;
  return Math.min(1, lenLoss * 0.5);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\p{P}]+/gu)
    .filter(t => t.length > 0);
}

function extractNumbers(text: string): string[] {
  const numberMatches = text.match(/\d+(?:\.\d+)?/g) ?? [];
  return numberMatches;
}

function normalizeSemanticToken(token: string): string {
  if (token.endsWith("ing") && token.length > 5) return token.slice(0, -3);
  if (token.endsWith("ed") && token.length > 4) return token.slice(0, -2);
  if (token.endsWith("es") && token.length > 4) return token.slice(0, -2);
  if (token.endsWith("s") && token.length > 3) return token.slice(0, -1);
  return token;
}

