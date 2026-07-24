import type { Clock, EvidenceSpan, Hasher, JsonValue, ModelState, PolicyProfile, SemanticEntailmentResult, TrainInput } from "./types.js";
import { clamp01, createClock, createHasher, featureSet, mean, toJsonValue, weightedJaccard } from "./primitives.js";
import { createLanguageInductionEngine, type InducedLanguageModel, type LanguageInductionDocument } from "./language-induction.js";
import type { SemanticProofResult } from "./semantic-proof-system.js";
import { SEMANTIC_VERDICT } from "./semantic-codes.js";

export type TrainingStageKind = string;

const TRAIN_STAGE = {
  SELECT: "scce.train.stage.001",
  PROMOTE: "scce.train.stage.002",
  INDUCE_LANGUAGE: "scce.train.stage.003",
  DISTILL: "scce.train.stage.004",
  REPAIR_CURRICULUM: "scce.train.stage.005",
  CHECKPOINT: "scce.train.stage.006"
} as const;

const TRAIN_LABEL = {
  SELECT: "scce.train.label.001",
  PROMOTE: "scce.train.label.002",
  INDUCE_LANGUAGE: "scce.train.label.003",
  DISTILL: "scce.train.label.004",
  REPAIR_CURRICULUM: "scce.train.label.005",
  CHECKPOINT: "scce.train.label.006"
} as const;

const CURRICULUM_KIND = {
  PROOF_OBLIGATION: "scce.curriculum.001",
  COUNTEREXAMPLE: "scce.curriculum.002",
  LANGUAGE_GAP: "scce.curriculum.003",
  PROGRAM_REPAIR: "scce.curriculum.004",
  CONNECTOR_GAP: "scce.curriculum.005"
} as const;

export interface TrainingStage {
  id: string;
  kind: TrainingStageKind;
  label: string;
  inputs: string[];
  outputs: string[];
  score: number;
  risk: number;
  audit: JsonValue;
}

export interface EvidencePromotionDecision {
  evidenceId: string;
  promote: boolean;
  score: number;
  trust: number;
  alpha: number;
  novelty: number;
  coverage: number;
  reasons: string[];
}

export interface CurriculumItem {
  id: string;
  kind: string;
  prompt: string;
  expectedEvidence: string[];
  priority: number;
  difficulty: number;
  source: JsonValue;
}

export interface DistillationExample {
  id: string;
  input: string;
  target: string;
  evidenceIds: string[];
  proofId?: string;
  weight: number;
  tags: string[];
}

export interface TrainingCheckpoint {
  id: string;
  createdAt: number;
  modelState: ModelState;
  languageModel?: InducedLanguageModel;
  promotedEvidenceIds: string[];
  curriculum: CurriculumItem[];
  distillation: DistillationExample[];
  audit: JsonValue;
}

export interface TrainingPlan {
  id: string;
  stages: TrainingStage[];
  promotion: EvidencePromotionDecision[];
  languageDocuments: LanguageInductionDocument[];
  curriculum: CurriculumItem[];
  distillation: DistillationExample[];
  checkpoint: TrainingCheckpoint;
  transaction: {
    isolation: "repeatable_read";
    reads: string[];
    writes: string[];
    batches: Array<{ table: string; rows: number }>;
  };
  audit: JsonValue;
}

export function createTrainingOrchestrator(options: { hasher?: Hasher; clock?: Clock; now?: () => number } = {}) {
  const hasher = options.hasher ?? createHasher();
  const clock = options.clock ?? createClock();
  const now = options.now ?? (() => clock.now());
  const language = createLanguageInductionEngine({ hasher });
  return {
    plan(input: {
      train: TrainInput;
      evidence: EvidenceSpan[];
      modelState: ModelState;
      recentProofs?: SemanticProofResult[];
      recentEntailments?: SemanticEntailmentResult[];
      policy?: PolicyProfile;
    }): TrainingPlan {
      const t = now();
      const promotion = promoteEvidence(input.evidence, input.train, input.modelState, input.recentEntailments ?? []);
      const promoted = input.evidence.filter(span => promotion.some(decision => decision.promote && decision.evidenceId === String(span.id)));
      const languageDocuments = promoted.map(span => evidenceToLanguageDocument(span));
      const languageModel = languageDocuments.length
        ? language.induce({ documents: languageDocuments, order: 6, maxNgrams: 4096, maxFrames: 2048 })
        : undefined;
      const curriculum = buildCurriculum({ proofs: input.recentProofs ?? [], entailments: input.recentEntailments ?? [], languageModel, evidence: promoted, train: input.train });
      const distillation = buildDistillation({ evidence: promoted, entailments: input.recentEntailments ?? [], curriculum, hasher });
      const checkpoint = checkpointFor({ modelState: input.modelState, languageModel, promotion, curriculum, distillation, hasher, t });
      const stages = stagesFor({ promotion, languageModel, curriculum, distillation, checkpoint, hasher });
      const transaction = {
        isolation: "repeatable_read" as const,
        reads: ["evidence_spans", "model_state", "semantic_proofs", "construct_graphs"],
        writes: ["evidence_spans", "language_units", "language_patterns", "ngram_models", "semantic_frames", "model_state", "events"],
        batches: [
          { table: "evidence_spans", rows: promotion.length },
          { table: "language_units", rows: languageModel?.ngrams.length ?? 0 },
          { table: "semantic_frames", rows: languageModel?.semanticFrames.length ?? 0 },
          { table: "model_state", rows: 1 },
          { table: "events", rows: stages.length + curriculum.length + distillation.length + 1 }
        ]
      };
      const id = `training_plan_${hasher.digestHex(JSON.stringify({ promoted: promotion.filter(p => p.promote).map(p => p.evidenceId), checkpoint: checkpoint.id })).slice(0, 32)}`;
      return {
        id,
        stages,
        promotion,
        languageDocuments,
        curriculum,
        distillation,
        checkpoint,
        transaction,
        audit: toJsonValue({
          promotedEvidence: promotion.filter(item => item.promote).length,
          rejectedEvidence: promotion.filter(item => !item.promote).length,
          languageModel: languageModel ? { id: languageModel.id, symbols: languageModel.symbolCount, frames: languageModel.semanticFrames.length, ngrams: languageModel.ngrams.length } : null,
          curriculum: curriculum.map(item => ({ id: item.id, kind: item.kind, priority: item.priority })),
          distillation: distillation.map(item => ({ id: item.id, weight: item.weight, tags: item.tags })),
          transaction
        })
      };
    }
  };
}

function promoteEvidence(evidence: readonly EvidenceSpan[], train: TrainInput, modelState: ModelState, entailments: readonly SemanticEntailmentResult[]): EvidencePromotionDecision[] {
  const goals = train.config.learningGoals ?? modelState.learningGoals ?? [];
  const namespaces = new Set(train.config.promotion?.namespaces ?? []);
  const minTrust = clamp01(train.config.promotion?.minTrust ?? 0.45);
  const goalFeatures = featureSet(goals.join("\n"), 2048);
  const knownFeatures = new Set(modelState.languageProfiles.flatMap(profile => profile.symbolShapes.map(shape => `shape:${shape.shape}`).concat(profile.charNgrams.map(ng => `char:${ng.ngram}`))));
  const entailmentEvidence = new Set(entailments.flatMap(result => result.evidenceIds.map(String)));
  return evidence.map(span => {
    const trust = trustFromSpan(span);
    const namespaceOk = namespaces.size === 0 || namespaces.has(sourceNamespace(span));
    const novelty = noveltyScore(span.features, knownFeatures);
    const coverage = goalFeatures.length ? weightedJaccard(goalFeatures, span.features) : Math.min(1, span.features.length / 256);
    const proofUse = entailmentEvidence.has(String(span.id)) ? 0.18 : 0;
    const score = clamp01(0.3 * trust + 0.26 * span.alpha + 0.2 * novelty + 0.18 * coverage + proofUse);
    const promote = namespaceOk && trust >= minTrust && score >= Math.max(0.42, minTrust * 0.8);
    const reasons = [
      `trust=${trust.toFixed(3)}`,
      `alpha=${span.alpha.toFixed(3)}`,
      `novelty=${novelty.toFixed(3)}`,
      `coverage=${coverage.toFixed(3)}`
    ];
    if (!namespaceOk) reasons.push("namespace not selected");
    if (trust < minTrust) reasons.push("below trust threshold");
    if (proofUse > 0) reasons.push("used by recent proof");
    return { evidenceId: String(span.id), promote, score, trust, alpha: span.alpha, novelty, coverage, reasons };
  }).sort((a, b) => Number(b.promote) - Number(a.promote) || b.score - a.score);
}

function evidenceToLanguageDocument(span: EvidenceSpan): LanguageInductionDocument {
  return {
    id: String(span.id),
    text: span.text,
    sourceVersionId: span.sourceVersionId,
    evidenceIds: [span.id],
    languageHint: languageHint(span),
    trust: trustFromSpan(span)
  };
}

function buildCurriculum(input: {
  proofs: readonly SemanticProofResult[];
  entailments: readonly SemanticEntailmentResult[];
  languageModel: InducedLanguageModel | undefined;
  evidence: readonly EvidenceSpan[];
  train: TrainInput;
}): CurriculumItem[] {
  const items: CurriculumItem[] = [];
  for (const proof of input.proofs) {
    for (const obligation of proof.obligations) {
      items.push({
        id: `curriculum:${obligation.id}`,
        kind: CURRICULUM_KIND.PROOF_OBLIGATION,
        prompt: obligation.description,
        expectedEvidence: obligation.evidenceIds.map(String),
        priority: clamp01(obligation.weight + (proof.verdict === SEMANTIC_VERDICT.UNDERDETERMINED ? 0.2 : 0)),
        difficulty: clamp01(0.4 + obligation.weight * 0.5),
        source: toJsonValue({ proofId: proof.id, atomId: obligation.atomId, kind: obligation.kind })
      });
    }
    for (const counterexample of proof.counterexamples) {
      items.push({
        id: `curriculum:${counterexample.id}`,
        kind: CURRICULUM_KIND.COUNTEREXAMPLE,
        prompt: `scce.curriculum.prompt.002:${counterexample.reason}`,
        expectedEvidence: counterexample.evidenceIds.map(String),
        priority: clamp01(counterexample.contradiction),
        difficulty: clamp01(0.55 + counterexample.contradiction * 0.35),
        source: toJsonValue(counterexample)
      });
    }
  }
  for (const entailment of input.entailments) {
    if (entailment.boundaries.length) {
      items.push({
        id: `curriculum:boundaries:${String(entailment.claim.id)}`,
        kind: CURRICULUM_KIND.PROOF_OBLIGATION,
        prompt: `scce.curriculum.prompt.003:${entailment.claim.normalized}`,
        expectedEvidence: entailment.evidenceIds.map(String),
        priority: clamp01(1 - entailment.faithfulnessLcb),
        difficulty: clamp01(0.45 + entailment.contradiction * 0.4),
        source: toJsonValue({ claimId: entailment.claim.id, boundaries: entailment.boundaries })
      });
    }
  }
  if (input.languageModel) {
    const sparseFrames = input.languageModel.semanticFrames.filter(frame => frame.support < 0.38).slice(0, 32);
    for (const frame of sparseFrames) {
      items.push({
        id: `curriculum:frame:${frame.id}`,
        kind: CURRICULUM_KIND.LANGUAGE_GAP,
        prompt: `scce.curriculum.prompt.004:${frame.predicate}`,
        expectedEvidence: frame.evidenceIds.map(String),
        priority: clamp01(1 - frame.support),
        difficulty: clamp01(0.35 + (1 - frame.alphaPrior) * 0.35),
        source: toJsonValue({ frameId: frame.id, predicate: frame.predicate, roles: frame.roles.slice(0, 8) })
      });
    }
  }
  for (const goal of input.train.config.learningGoals ?? []) {
    items.push({
      id: `curriculum:goal:${createHasher().digestHex(goal).slice(0, 20)}`,
      kind: CURRICULUM_KIND.CONNECTOR_GAP,
      prompt: goal,
      expectedEvidence: input.evidence.slice(0, 12).map(span => String(span.id)),
      priority: 0.5,
      difficulty: 0.5,
      source: toJsonValue({ configuredGoal: goal })
    });
  }
  return dedupeCurriculum(items).sort((a, b) => b.priority - a.priority || a.difficulty - b.difficulty).slice(0, 512);
}

function buildDistillation(input: { evidence: readonly EvidenceSpan[]; entailments: readonly SemanticEntailmentResult[]; curriculum: readonly CurriculumItem[]; hasher: Hasher }): DistillationExample[] {
  const examples: DistillationExample[] = [];
  for (const entailment of input.entailments) {
    const evidence = input.evidence.filter(span => entailment.evidenceIds.map(String).includes(String(span.id))).slice(0, 8);
    if (!evidence.length) continue;
    const target = `scce.distill.target.001:${entailment.force}:${entailment.support.toFixed(3)}:${entailment.contradiction.toFixed(3)}:${entailment.claim.normalized}`;
    examples.push({
      id: `distill_${input.hasher.digestHex(`${entailment.claim.id}:${target}`).slice(0, 24)}`,
      input: evidence.map(span => span.textPreview).join("\n"),
      target,
      evidenceIds: evidence.map(span => String(span.id)),
      proofId: String(entailment.proof.id),
      weight: clamp01(0.4 * entailment.support + 0.35 * entailment.faithfulnessLcb + 0.25 * (1 - entailment.contradiction)),
      tags: ["scce.tag.001", entailment.force]
    });
  }
  for (const item of input.curriculum.slice(0, 128)) {
    examples.push({
      id: `distill_${input.hasher.digestHex(`${item.id}:${item.prompt}`).slice(0, 24)}`,
      input: item.prompt,
      target: `scce.distill.target.002:${item.priority.toFixed(3)}:${item.difficulty.toFixed(3)}`,
      evidenceIds: item.expectedEvidence,
      weight: clamp01(item.priority * (1 - item.difficulty * 0.25)),
      tags: ["scce.tag.002", item.kind]
    });
  }
  return examples.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id)).slice(0, 512);
}

function checkpointFor(input: {
  modelState: ModelState;
  languageModel?: InducedLanguageModel;
  promotion: EvidencePromotionDecision[];
  curriculum: CurriculumItem[];
  distillation: DistillationExample[];
  hasher: Hasher;
  t: number;
}): TrainingCheckpoint {
  const promotedEvidenceIds = input.promotion.filter(item => item.promote).map(item => item.evidenceId);
  const modelState: ModelState = {
    ...input.modelState,
    languageProfiles: input.modelState.languageProfiles,
    latentConcepts: input.modelState.latentConcepts,
    learnedProgramPatterns: [
      ...input.modelState.learnedProgramPatterns,
      ...input.distillation.slice(0, 64).map(example => toJsonValue({ id: example.id, tags: example.tags, weight: example.weight }))
    ].slice(-2048),
    learningGoals: [...new Set([...input.modelState.learningGoals, ...input.curriculum.slice(0, 128).map(item => item.prompt)])].slice(-1024),
    trainingSteps: input.modelState.trainingSteps + 1
  };
  const id = `checkpoint_${input.hasher.digestHex(JSON.stringify({ promotedEvidenceIds, curriculum: input.curriculum.map(c => c.id), distillation: input.distillation.map(d => d.id), t: input.t })).slice(0, 32)}`;
  return {
    id,
    createdAt: input.t,
    modelState,
    languageModel: input.languageModel,
    promotedEvidenceIds,
    curriculum: input.curriculum,
    distillation: input.distillation,
    audit: toJsonValue({
      promotedEvidenceIds,
      languageModelId: input.languageModel?.id,
      curriculumCount: input.curriculum.length,
      distillationCount: input.distillation.length,
      trainingSteps: modelState.trainingSteps
    })
  };
}

function stagesFor(input: {
  promotion: EvidencePromotionDecision[];
  languageModel?: InducedLanguageModel;
  curriculum: CurriculumItem[];
  distillation: DistillationExample[];
  checkpoint: TrainingCheckpoint;
  hasher: Hasher;
}): TrainingStage[] {
  const promoted = input.promotion.filter(item => item.promote).length;
  const stages: TrainingStage[] = [
    stage(TRAIN_STAGE.SELECT, TRAIN_LABEL.SELECT, ["scce.io.001", "scce.io.002"], ["scce.io.003"], promoted / Math.max(1, input.promotion.length), 0.18, { decisions: input.promotion.length }, input.hasher),
    stage(TRAIN_STAGE.PROMOTE, TRAIN_LABEL.PROMOTE, ["scce.io.003"], ["scce.io.004"], promoted ? 0.8 : 0.2, promoted ? 0.26 : 0.1, { promoted }, input.hasher)
  ];
  if (input.languageModel) stages.push(stage(TRAIN_STAGE.INDUCE_LANGUAGE, TRAIN_LABEL.INDUCE_LANGUAGE, ["scce.io.004"], ["scce.io.005"], clamp01(Math.log1p(input.languageModel.symbolCount) / 12), 0.22, { modelId: input.languageModel.id }, input.hasher));
  if (input.distillation.length) stages.push(stage(TRAIN_STAGE.DISTILL, TRAIN_LABEL.DISTILL, ["scce.io.006", "scce.io.004"], ["scce.io.007"], mean(input.distillation.map(item => item.weight)), 0.2, { examples: input.distillation.length }, input.hasher));
  if (input.curriculum.length) stages.push(stage(TRAIN_STAGE.REPAIR_CURRICULUM, TRAIN_LABEL.REPAIR_CURRICULUM, ["scce.io.008", "scce.io.009"], ["scce.io.010"], mean(input.curriculum.map(item => item.priority)), 0.24, { items: input.curriculum.length }, input.hasher));
  stages.push(stage(TRAIN_STAGE.CHECKPOINT, TRAIN_LABEL.CHECKPOINT, ["scce.io.011", "scce.io.005", "scce.io.007"], ["scce.io.011"], 0.9, 0.32, { checkpointId: input.checkpoint.id }, input.hasher));
  return stages;
}

function stage(kind: TrainingStageKind, label: string, inputs: string[], outputs: string[], score: number, risk: number, audit: unknown, hasher: Hasher): TrainingStage {
  return {
    id: `train_stage_${hasher.digestHex(`${kind}:${label}:${inputs.join("|")}:${outputs.join("|")}`).slice(0, 24)}`,
    kind,
    label,
    inputs,
    outputs,
    score: clamp01(score),
    risk: clamp01(risk),
    audit: toJsonValue(audit)
  };
}

function dedupeCurriculum(items: CurriculumItem[]): CurriculumItem[] {
  const map = new Map<string, CurriculumItem>();
  for (const item of items) {
    const existing = map.get(item.id);
    if (!existing || item.priority > existing.priority) map.set(item.id, item);
  }
  return [...map.values()];
}

function noveltyScore(features: readonly string[], known: Set<string>): number {
  if (features.length === 0) return 0;
  const unseen = features.filter(feature => !known.has(feature)).length;
  return unseen / features.length;
}

function trustFromSpan(span: EvidenceSpan): number {
  const trust = span.trustVector;
  if (!trust || typeof trust !== "object" || Array.isArray(trust)) return span.status === "promoted" ? 0.65 : 0.42;
  const record = trust as Record<string, JsonValue>;
  const values = Object.values(record).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return values.length ? clamp01(mean(values)) : span.status === "promoted" ? 0.65 : 0.42;
}

function sourceNamespace(span: EvidenceSpan): string {
  const provenance = jsonObject(span.provenance);
  const metadata = jsonObject(provenance.metadata);
  const trust = jsonObject(span.trustVector);
  for (const value of [provenance.namespace, metadata.namespace, metadata.ingestionLane, trust.namespace]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "local";
}

function languageHint(span: EvidenceSpan): string | undefined {
  const hints = span.languageHints;
  if (!hints || typeof hints !== "object" || Array.isArray(hints)) return undefined;
  const record = hints as Record<string, JsonValue>;
  const value = record.language ?? record.primary ?? record.tag;
  return typeof value === "string" ? value : undefined;
}

function jsonObject(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}
