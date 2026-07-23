import type { BoundaryProfile, DetailProfilePolicy } from "./control-plane-profiles.js";
import type { CognitiveProposal, PlannedClaim } from "./cognitive-planner.js";
import type { CorrectionRuleRecord } from "./storage.js";
import type { DiscoursePlan, OutputForce, SurfacePlan } from "./mouth-types.js";
import type { TurnRequirement, TurnRequirementField } from "./turn-requirements.js";
import type { ConstructGraph, FieldState, JsonValue, RequestedAuthority } from "./types.js";
import { clamp01, featureSet, toJsonValue, weightedJaccard } from "./primitives.js";
import { SURFACE_QUALITY_ISSUE_IDS, SURFACE_QUALITY_REJECTION_IDS, detectCannedAnswerSpeech } from "./surface-quality.js";
import { featureScore, provisionalHeuristicScore, type ScoreTrace } from "./scoring/score-trace.js";
import { CALIBRATION_IDS, CALIBRATION_TASK_CLASS_IDS, calibrateRuntimeScore, type CalibrationModelSet } from "./calibration-spine.js";

export type SurfaceProofVerdict =
  | "certified"
  | "insufficient_evidence"
  | "contradicted"
  | "unsupported_prior_only"
  | "source_bound_only"
  | "ambiguous";

export interface SurfaceEnergyCandidate {
  id: string;
  text: string;
  force?: OutputForce;
  evidenceIds?: readonly string[];
  importedPieceIds?: readonly string[];
  languageActivation?: number;
  languageFit?: number;
  semanticPreservation?: number;
  correctionAppliedCount?: number;
  forbiddenSurfaceHits?: readonly string[];
  boundaryDecisions?: readonly SurfaceBoundaryDecision[];
  metadata?: JsonValue;
}

export interface SurfaceBoundaryDecision {
  kind?: string;
  text: string;
  source?: string;
  boundarySource?: string;
  repeatedBoundaryPenalty?: number;
}

export interface DirectQuoteBinding {
  id: string;
  text: string;
}

export interface ForbiddenSurfaceBinding {
  id: string;
  text?: string;
}

export interface SurfaceOutputFeatureBinding {
  id: string;
  requirementId?: string;
  surface?: string;
  hard?: boolean;
  trace?: JsonValue;
}

export type SurfaceOutputFeature = TurnRequirement | SurfaceOutputFeatureBinding;

export interface SurfaceRevisionConstraint {
  defectId: string;
  defectKind: string;
  requestedCorrection?: {
    operation: string;
    targetIds: readonly string[];
    preserveClaimIds: readonly string[];
  };
}

/**
 * Invariants captured immediately before final readability/formatting passes.
 * The final scorer rejects a renderer that loses any of them.
 */
export interface SurfaceTransformationBaseline {
  requiredSurfaces?: readonly string[];
  requiredCodeLiterals?: readonly string[];
  minimumLineCount?: number;
  minimumListMarkerCount?: number;
  minimumCodeFenceCount?: number;
}

export interface SurfaceEnergyContext {
  construct?: ConstructGraph;
  requestedAuthority?: RequestedAuthority;
  requirementField?: TurnRequirementField;
  selectedProposal?: CognitiveProposal;
  claimBases?: readonly PlannedClaim[];
  requiredOutputFeatures?: readonly SurfaceOutputFeature[];
  prohibitedOutputFeatures?: readonly SurfaceOutputFeature[];
  revisionConstraints?: readonly SurfaceRevisionConstraint[];
  transformationBaseline?: SurfaceTransformationBaseline;
  minimumSemanticPreservation?: number;
  surfacePlan: SurfacePlan;
  discoursePlan?: DiscoursePlan;
  proofVerdict?: SurfaceProofVerdict;
  forceClass?: string;
  expectedForce?: OutputForce;
  field?: FieldState;
  fieldSummary?: {
    alphaPressure?: number;
    ppfMass?: number;
    contradictionPressure?: number;
    actionability?: number;
  };
  languagePrior?: {
    activation?: number;
    fit?: number;
    support?: number;
    importedPieceIds?: readonly string[];
    surfaces?: readonly string[];
  };
  correction?: {
    rules?: readonly CorrectionRuleRecord[];
    termRewrites?: readonly { pattern: string; replacement: string }[];
    styleVector?: readonly number[];
    registerVector?: readonly number[];
  };
  styleVector?: readonly number[];
  registerVector?: readonly number[];
  detailProfile?: DetailProfilePolicy;
  boundaryProfile?: BoundaryProfile;
  requiredEntities?: readonly string[];
  requiredNumbers?: readonly string[];
  requiredCaveats?: readonly string[];
  forbiddenSurfaces?: readonly ForbiddenSurfaceBinding[];
  directQuoteBindings?: readonly DirectQuoteBinding[];
  learnedPriorEvidenceIds?: readonly string[];
  directEvidenceIds?: readonly string[];
  calibrationModels?: CalibrationModelSet;
  calibrationTaskClass?: string;
}

export interface SurfaceEnergyComponent {
  id: string;
  lambda: number;
  raw: number;
  contribution: number;
  polarity: "loss" | "support";
  reasonIds: string[];
  trace: JsonValue;
}

export interface SurfaceEnergyHardViolation {
  id: string;
  severity: "reject";
  trace: JsonValue;
}

export interface SurfaceEnergyResult {
  candidateId: string;
  textHash: string;
  valid: boolean;
  energy: number;
  loss: number;
  support: number;
  surfaceScore: number;
  priorIdsUsed: string[];
  correctionIdsUsed: string[];
  proofVerdictUsed?: SurfaceProofVerdict;
  hardViolations: SurfaceEnergyHardViolation[];
  components: SurfaceEnergyComponent[];
  scoreTrace: ScoreTrace[];
  trace: JsonValue;
}

export interface RankedSurfaceCandidate {
  candidate: SurfaceEnergyCandidate;
  result: SurfaceEnergyResult;
  rank: number;
}

interface SurfaceStats {
  normalized: string;
  surfaceUnits: string[];
  sentences: string[];
  surfaceUnitCount: number;
  charCount: number;
  punctuationCount: number;
  boundaryTexts: string[];
}

const LAMBDA = {
  semantic: 1.35,
  proof: 1.75,
  force: 0.9,
  contradiction: 1.3,
  repetition: 0.72,
  fragment: 0.82,
  caveat: 1.16,
  correction: 0.86,
  style: 0.42,
  detail: 0.58,
  boundary: 0.68,
  language: 0.86,
  action: 0.36,
  compression: 0.44
} as const;

export const GENERAL_COGNITION_SURFACE_BOOTSTRAP = Object.freeze({
  schema: "scce.surface_general_cognition.bootstrap.v1" as const,
  version: "surface-general-cognition.bootstrap.2026-07-12.v1",
  objective: "surface.general_cognition.bootstrap.v1",
  coefficients: Object.freeze({
    meaningPreservation: 0.22,
    requirementCoverage: 0.16,
    coherence: 0.13,
    learnedLanguageFit: 0.12,
    directness: 0.10,
    structure: 0.09,
    styleFit: 0.07,
    surfaceNovelty: 0.06,
    rhythm: 0.05,
    repetition: -0.24,
    contradictionLeak: -0.28,
    telemetryLeak: -0.32,
    fakeFactualAuthority: -0.70
  })
});

export function scoreSurfaceEnergy(candidate: SurfaceEnergyCandidate, context: SurfaceEnergyContext): SurfaceEnergyResult {
  const stats = surfaceStats(candidate);
  const hardViolations = hardConstraintViolations(candidate, context, stats);
  const requirementAware = Boolean(context.requirementField);
  const creative = isCreativeSurface(candidate, context);
  const components = requirementAware
    ? generalCognitionSurfaceComponents(candidate, context, stats)
    : creative
      ? creativeSurfaceComponents(candidate, context, stats)
      : defaultSurfaceComponents(candidate, context, stats, hardViolations);
  const loss = sum(components.filter(item => item.polarity === "loss").map(item => item.contribution));
  const support = sum(components.filter(item => item.polarity === "support").map(item => item.contribution));
  const surfaceScore = Number((support - loss).toFixed(8));
  const hardPenalty = hardViolations.length * 100;
  const rawEnergy = Number((loss - support + hardPenalty).toFixed(8));
  const rawUtility = requirementAware
    ? clamp01((surfaceScore + 1.54) / 2.54)
    : creative
      ? clamp01((surfaceScore + 1.04) / 2.04)
      : clamp01(1 / (1 + Math.max(0, rawEnergy)));
  const calibratedUtility = calibrateRuntimeScore({
    raw: rawUtility,
    calibrationId: CALIBRATION_IDS.mouthSurfaceFit,
    taskClass: context.calibrationTaskClass ?? (requirementAware ? CALIBRATION_TASK_CLASS_IDS.generalCognition : creative ? CALIBRATION_TASK_CLASS_IDS.creativeGeneration : CALIBRATION_TASK_CLASS_IDS.sourceBoundQa),
    modelSet: context.calibrationModels,
    meaning: "calibrated surface ranking utility",
    provenance: ["walsh-surface-energy.ts:scoreSurfaceEnergy"],
    inputs: ["loss", "support", "hardPenalty", candidate.id]
  });
  const energy = calibratedUtility.calibrated
    ? Number(((1 / Math.max(0.000001, calibratedUtility.value)) - 1).toFixed(8))
    : rawEnergy;
  const priorIdsUsed = uniqueStrings([...(candidate.importedPieceIds ?? []), ...(context.languagePrior?.importedPieceIds ?? [])]);
  const correctionIdsUsed = uniqueStrings([...(context.correction?.rules ?? []).map(rule => rule.id)]);
  const scoreTrace: ScoreTrace[] = [
    featureScore({
      value: loss,
      range: [0, 1000],
      meaning: "surface energy loss aggregate",
      inputs: components.filter(item => item.polarity === "loss").map(item => item.id),
      provenance: ["walsh-surface-energy.ts:scoreSurfaceEnergy"]
    }),
    featureScore({
      value: support,
      range: [0, 1000],
      meaning: "surface energy support aggregate",
      inputs: components.filter(item => item.polarity === "support").map(item => item.id),
      provenance: ["walsh-surface-energy.ts:scoreSurfaceEnergy"]
    }),
    provisionalHeuristicScore({
      value: rawUtility,
      range: [0, 1],
      meaning: "surface ranking utility heuristic",
      inputs: ["loss", "support", "hardPenalty"],
      provenance: ["walsh-surface-energy.ts:scoreSurfaceEnergy"],
      failureModes: ["energy_scale_shift", "component_weight_drift"]
    }),
    ...(calibratedUtility.scoreTrace ? [calibratedUtility.scoreTrace] : [])
  ];
  return {
    candidateId: candidate.id,
    textHash: hashText(candidate.text),
    valid: hardViolations.length === 0,
    energy,
    loss,
    support,
    surfaceScore,
    priorIdsUsed,
    correctionIdsUsed,
    proofVerdictUsed: context.proofVerdict,
    hardViolations,
    components,
    scoreTrace,
    trace: toJsonValue({
      source: "walsh.surface_energy",
      candidateId: candidate.id,
      surfaceUnitCount: stats.surfaceUnitCount,
      proofVerdict: context.proofVerdict ?? null,
      expectedForce: context.expectedForce ?? null,
      requestedAuthority: context.requestedAuthority ?? null,
      objective: requirementAware ? GENERAL_COGNITION_SURFACE_BOOTSTRAP.objective : creative ? "surface.creative.bootstrap.v1" : "surface.walsh.default.v1",
      bootstrapVersion: requirementAware ? GENERAL_COGNITION_SURFACE_BOOTSTRAP.version : null,
      coefficientSchema: requirementAware ? GENERAL_COGNITION_SURFACE_BOOTSTRAP.coefficients : creative ? {
        meaningPreservation: 0.30,
        constraintCoverage: 0.20,
        knFluency: 0.16,
        styleFit: 0.14,
        surfaceNovelty: 0.12,
        actionability: 0.08,
        repetition: -0.24,
        contradictionLeak: -0.30,
        fakeFactualAuthority: -0.50
      } : null,
      hardViolations: hardViolations.map(item => item.id),
      rawEnergy,
      energy,
      loss,
      support,
      surfaceScore,
      calibration: calibratedUtility,
      scoreTrace,
      priorIdsUsed,
      correctionIdsUsed
    })
  };
}

function defaultSurfaceComponents(
  candidate: SurfaceEnergyCandidate,
  context: SurfaceEnergyContext,
  stats: SurfaceStats,
  hardViolations: readonly SurfaceEnergyHardViolation[]
): SurfaceEnergyComponent[] {
  const semantic = semanticLoss(candidate, context, stats);
  const proof = proofViolation(candidate, context, stats);
  const force = forceMismatch(candidate, context);
  const contradiction = contradictionLeak(candidate, context, stats);
  const repetition = repetitionCost(candidate, context, stats);
  const fragment = fragmentCost(candidate, context, stats);
  const caveat = caveatLoss(candidate, context, stats);
  const correction = correctionViolation(candidate, context, stats);
  const style = styleVectorDistance(candidate, context, stats);
  const detail = detailProfileDistance(candidate, context, stats);
  const boundary = boundaryInstability(candidate, context, stats);
  const language = languagePriorSupport(candidate, context, stats, hardViolations, proof.raw);
  const action = actionability(candidate, context, stats);
  const compression = compressionFit(candidate, context, stats);
  return [
    component("surface.energy.semantic_loss", LAMBDA.semantic, semantic),
    component("surface.energy.proof_violation", LAMBDA.proof, proof),
    component("surface.energy.force_mismatch", LAMBDA.force, force),
    component("surface.energy.contradiction_leak", LAMBDA.contradiction, contradiction),
    component("surface.energy.repetition_cost", LAMBDA.repetition, repetition),
    component("surface.energy.fragment_cost", LAMBDA.fragment, fragment),
    component("surface.energy.caveat_loss", LAMBDA.caveat, caveat),
    component("surface.energy.correction_violation", LAMBDA.correction, correction),
    component("surface.energy.style_vector_distance", LAMBDA.style, style),
    component("surface.energy.detail_profile_distance", LAMBDA.detail, detail),
    component("surface.energy.boundary_instability", LAMBDA.boundary, boundary),
    component("surface.energy.language_prior_support", LAMBDA.language, language, "support"),
    component("surface.energy.actionability", LAMBDA.action, action, "support"),
    component("surface.energy.compression_fit", LAMBDA.compression, compression, "support")
  ];
}

function generalCognitionSurfaceComponents(candidate: SurfaceEnergyCandidate, context: SurfaceEnergyContext, stats: SurfaceStats): SurfaceEnergyComponent[] {
  const meaning = generalMeaningPreservation(candidate, context, stats);
  const requirement = generalRequirementCoverage(candidate, context, stats);
  const coherence = generalCoherence(candidate, context, stats);
  const language = generalLearnedLanguageFit(candidate, context);
  const directness = generalDirectness(candidate, context, stats);
  const structure = generalStructure(candidate, context, stats);
  const style = generalStyleFit(candidate, context, stats);
  const novelty = generalSurfaceNovelty(candidate, context);
  const rhythm = generalRhythm(stats);
  const repetition = repetitionCost(candidate, context, stats);
  const contradiction = contradictionLeak(candidate, context, stats);
  const telemetry = telemetryLeak(candidate);
  const fakeFactual = generalFakeFactualAuthority(candidate, context, stats);
  return [
    component("surface.general.meaning_preservation", 0.22, meaning, "support"),
    component("surface.general.requirement_coverage", 0.16, requirement, "support"),
    component("surface.general.coherence", 0.13, coherence, "support"),
    component("surface.general.learned_language_fit", 0.12, language, "support"),
    component("surface.general.directness", 0.10, directness, "support"),
    component("surface.general.structure", 0.09, structure, "support"),
    component("surface.general.style_fit", 0.07, style, "support"),
    component("surface.general.surface_novelty", 0.06, novelty, "support"),
    component("surface.general.rhythm", 0.05, rhythm, "support"),
    component("surface.general.repetition", 0.24, repetition),
    component("surface.general.contradiction_leak", 0.28, contradiction),
    component("surface.general.telemetry_leak", 0.32, telemetry),
    component("surface.general.fake_factual_authority", 0.70, fakeFactual)
  ];
}

function creativeSurfaceComponents(candidate: SurfaceEnergyCandidate, context: SurfaceEnergyContext, stats: SurfaceStats): SurfaceEnergyComponent[] {
  const meaning = creativeMeaningPreservation(candidate, context, stats);
  const constraint = creativeConstraintCoverage(context, stats);
  const fluency = creativeKnFluency(candidate);
  const style = creativeStyleFit(candidate, context, stats);
  const novelty = creativeSurfaceNovelty(candidate, context);
  const action = actionability(candidate, context, stats);
  const repetition = repetitionCost(candidate, context, stats);
  const contradiction = contradictionLeak(candidate, context, stats);
  const fakeFactual = fakeFactualAuthority(candidate, context, stats);
  return [
    component("surface.creative.meaning_preservation", 0.30, meaning, "support"),
    component("surface.creative.constraint_coverage", 0.20, constraint, "support"),
    component("surface.creative.kn_fluency", 0.16, fluency, "support"),
    component("surface.creative.style_fit", 0.14, style, "support"),
    component("surface.creative.surface_novelty", 0.12, novelty, "support"),
    component("surface.creative.actionability", 0.08, action, "support"),
    component("surface.creative.repetition", 0.24, repetition),
    component("surface.creative.contradiction_leak", 0.30, contradiction),
    component("surface.creative.fake_factual_authority", 0.50, fakeFactual)
  ];
}

function generalMeaningPreservation(candidate: SurfaceEnergyCandidate, context: SurfaceEnergyContext, stats: SurfaceStats): TermScore {
  const declared = clamp01(candidate.semanticPreservation ?? 1 - semanticLoss(candidate, context, stats).raw);
  const claims = claimBasesFor(context).filter(claim => claim.text.trim());
  if (!claims.length) {
    return { raw: declared, reasonIds: [declared >= 0.6 ? "surface.general.meaning.preserved" : "surface.general.meaning.weak"], trace: toJsonValue({ declared, claimCount: 0 }) };
  }
  const candidateFeatures = featureSet(candidate.text, 512);
  const claimCoverage = meanOr(claims.map(claim => {
    if (containsSurface(stats.normalized, claim.text)) return 1;
    return weightedJaccard(candidateFeatures, featureSet(claim.text, 256));
  }), declared);
  const raw = clamp01(declared * 0.64 + claimCoverage * 0.36);
  return {
    raw,
    reasonIds: [raw >= 0.6 ? "surface.general.meaning.preserved" : "surface.general.meaning.claim_loss"],
    trace: toJsonValue({ declared, claimCoverage, claimIds: claims.map(claim => claim.id).slice(0, 32) })
  };
}

function generalRequirementCoverage(candidate: SurfaceEnergyCandidate, context: SurfaceEnergyContext, stats: SurfaceStats): TermScore {
  const required = context.requiredOutputFeatures ?? context.requirementField?.requiredFeatures ?? [];
  const prohibited = context.prohibitedOutputFeatures ?? context.requirementField?.prohibitedFeatures ?? [];
  const satisfied = new Set(context.selectedProposal?.satisfiedRequirementIds ?? []);
  const missed = new Set(context.selectedProposal?.missedRequirementIds ?? []);
  const metadata = recordValue(candidate.metadata);
  const emittedFeatureIds = new Set(stringArray(metadata.outputFeatureIds));
  const resolvedRevisionIds = new Set(stringArray(metadata.resolvedRevisionConstraintIds));
  let coveredWeight = 0;
  let requiredWeight = 0;
  for (const feature of required) {
    const weight = outputFeatureWeight(feature);
    requiredWeight += weight;
    const surface = outputFeatureSurface(feature);
    if (satisfied.has(feature.id) || emittedFeatureIds.has(feature.id) || (surface && containsSurface(stats.normalized, surface))) coveredWeight += weight;
  }
  const proposalCoverage = context.selectedProposal?.quality.reasoning.requirementCoverage;
  const explicitCoverage = requiredWeight > 0 ? clamp01(coveredWeight / requiredWeight) : proposalCoverage ?? 1;
  const prohibitedHits = prohibited.filter(feature => {
    const surface = outputFeatureSurface(feature);
    return emittedFeatureIds.has(feature.id) || Boolean(surface && containsSurface(stats.normalized, surface));
  });
  const missedRate = required.length ? required.filter(feature => missed.has(feature.id)).length / required.length : 0;
  const revisionConstraints = context.revisionConstraints ?? [];
  const unresolvedRevisionRate = revisionConstraints.length
    ? revisionConstraints.filter(constraint => !resolvedRevisionIds.has(constraint.defectId)).length / revisionConstraints.length
    : 0;
  const base = proposalCoverage === undefined ? explicitCoverage : explicitCoverage * 0.54 + clamp01(proposalCoverage) * 0.46;
  const raw = clamp01(base - prohibitedHits.length / Math.max(1, prohibited.length) * 0.58 - missedRate * 0.34 - unresolvedRevisionRate * 0.22);
  return {
    raw,
    reasonIds: [raw >= 0.7 ? "surface.general.requirements.covered" : "surface.general.requirements.incomplete"],
    trace: toJsonValue({ requiredCount: required.length, prohibitedCount: prohibited.length, coveredWeight, requiredWeight, proposalCoverage: proposalCoverage ?? null, prohibitedHits: prohibitedHits.map(feature => feature.id), missedRequirementIds: [...missed], unresolvedRevisionConstraintIds: revisionConstraints.filter(constraint => !resolvedRevisionIds.has(constraint.defectId)).map(constraint => constraint.defectId) })
  };
}

function generalCoherence(candidate: SurfaceEnergyCandidate, context: SurfaceEnergyContext, stats: SurfaceStats): TermScore {
  const reasoning = context.selectedProposal?.quality.reasoning;
  const relationContinuity = clamp01(reasoning?.relationContinuity ?? 0.62);
  const contradictionHandling = clamp01(reasoning?.contradictionHandling ?? 0.62);
  const fragmentFit = clamp01(1 - fragmentCost(candidate, context, stats).raw);
  const raw = clamp01(relationContinuity * 0.42 + contradictionHandling * 0.24 + fragmentFit * 0.34);
  return { raw, reasonIds: [raw >= 0.62 ? "surface.general.coherence.connected" : "surface.general.coherence.fragmented"], trace: toJsonValue({ relationContinuity, contradictionHandling, fragmentFit }) };
}

function generalLearnedLanguageFit(candidate: SurfaceEnergyCandidate, context: SurfaceEnergyContext): TermScore {
  const activation = clamp01(candidate.languageActivation ?? context.languagePrior?.activation ?? 0);
  const fit = clamp01(candidate.languageFit ?? context.languagePrior?.fit ?? activation);
  const support = clamp01(context.languagePrior?.support ?? 0);
  const raw = clamp01(fit * 0.58 + activation * 0.27 + support * 0.15);
  return { raw, reasonIds: [raw >= 0.5 ? "surface.general.language.learned_fit" : "surface.general.language.weak_fit"], trace: toJsonValue({ activation, fit, support, ngramIsNotSoleObjective: true }) };
}

function generalDirectness(candidate: SurfaceEnergyCandidate, context: SurfaceEnergyContext, stats: SurfaceStats): TermScore {
  const compression = compressionFit(candidate, context, stats).raw;
  const sentenceCount = Math.max(1, stats.sentences.length);
  const firstSentenceShare = stats.sentences[0] ? surfaceUnitsFrom(stats.sentences[0]).length / Math.max(1, stats.surfaceUnitCount) : 0;
  const directOpening = clamp01(firstSentenceShare * sentenceCount);
  const raw = clamp01(compression * 0.68 + directOpening * 0.32);
  return { raw, reasonIds: [raw >= 0.55 ? "surface.general.directness.fit" : "surface.general.directness.diffuse"], trace: toJsonValue({ compression, directOpening, sentenceCount }) };
}

function generalStructure(candidate: SurfaceEnergyCandidate, context: SurfaceEnergyContext, stats: SurfaceStats): TermScore {
  const fragmentFit = clamp01(1 - fragmentCost(candidate, context, stats).raw);
  const boundaryFit = clamp01(1 - boundaryInstability(candidate, context, stats).raw);
  const plannedUnits = context.discoursePlan?.units.length ?? context.surfacePlan.orderedPoints.length;
  const observedUnits = Math.max(1, stats.sentences.length);
  const planFit = clamp01(1 - Math.abs(observedUnits - Math.max(1, plannedUnits)) / Math.max(2, plannedUnits));
  const raw = clamp01(fragmentFit * 0.42 + boundaryFit * 0.31 + planFit * 0.27);
  return { raw, reasonIds: [raw >= 0.6 ? "surface.general.structure.stable" : "surface.general.structure.weak"], trace: toJsonValue({ fragmentFit, boundaryFit, planFit, plannedUnits, observedUnits }) };
}

function generalStyleFit(candidate: SurfaceEnergyCandidate, context: SurfaceEnergyContext, stats: SurfaceStats): TermScore {
  const distance = styleVectorDistance(candidate, context, stats).raw;
  const raw = clamp01(1 - distance);
  return { raw, reasonIds: [raw >= 0.6 ? "surface.general.style.aligned" : "surface.general.style.distant"], trace: toJsonValue({ distance }) };
}

function generalSurfaceNovelty(candidate: SurfaceEnergyCandidate, context: SurfaceEnergyContext): TermScore {
  const candidateFeatures = featureSet(candidate.text, 384);
  const surfaces = context.languagePrior?.surfaces ?? [];
  const maxOverlap = surfaces.reduce((maximum, surface) => Math.max(maximum, weightedJaccard(candidateFeatures, featureSet(surface, 384))), 0);
  const siblingSurfaces = context.selectedProposal?.claims.map(claim => claim.text).filter(Boolean) ?? [];
  const siblingOverlap = siblingSurfaces.reduce((maximum, surface) => Math.max(maximum, weightedJaccard(candidateFeatures, featureSet(surface, 384))), 0);
  const raw = clamp01(1 - maxOverlap * 0.72 - Math.max(0, siblingOverlap - 0.88) * 0.28);
  return { raw, reasonIds: [raw >= 0.45 ? "surface.general.novel" : "surface.general.repetitive_prior"], trace: toJsonValue({ memorySurfaceCount: surfaces.length, maxOverlap, siblingOverlap }) };
}

function generalRhythm(stats: SurfaceStats): TermScore {
  const lengths = stats.sentences.map(sentence => surfaceUnitsFrom(sentence).length).filter(length => length > 0);
  if (!lengths.length) return { raw: 0, reasonIds: ["surface.general.rhythm.empty"], trace: toJsonValue({ sentenceLengths: [] }) };
  const average = sum(lengths) / lengths.length;
  const variance = sum(lengths.map(length => (length - average) ** 2)) / lengths.length;
  const normalizedSpread = Math.sqrt(variance) / Math.max(1, average);
  const lengthFit = clamp01(1 - Math.abs(average - 15) / 24);
  const variationFit = lengths.length === 1 ? 0.72 : clamp01(1 - Math.abs(normalizedSpread - 0.32) / 0.72);
  const raw = clamp01(lengthFit * 0.62 + variationFit * 0.38);
  return { raw, reasonIds: [raw >= 0.55 ? "surface.general.rhythm.balanced" : "surface.general.rhythm.uneven"], trace: toJsonValue({ sentenceLengths: lengths, average, normalizedSpread }) };
}

function isCreativeSurface(candidate: SurfaceEnergyCandidate, context: SurfaceEnergyContext): boolean {
  return context.requestedAuthority === "creative" ||
    candidate.force === "creative" ||
    context.surfacePlan.constructForces[0]?.id === "CreativeConstruct";
}

function creativeMeaningPreservation(candidate: SurfaceEnergyCandidate, context: SurfaceEnergyContext, stats: SurfaceStats): TermScore {
  const raw = clamp01(candidate.semanticPreservation ?? 1 - semanticLoss(candidate, context, stats).raw);
  return { raw, reasonIds: [raw >= 0.6 ? "surface.creative.meaning.preserved" : "surface.creative.meaning.weak"], trace: toJsonValue({ semanticPreservation: candidate.semanticPreservation ?? null }) };
}

function creativeConstraintCoverage(context: SurfaceEnergyContext, stats: SurfaceStats): TermScore {
  const constraints = inventionTraceRows(context.construct, "constraints");
  const weighted = constraints
    .map(row => ({ surface: stringValue(row.surface), weight: positiveNumber(row.weight, 1), satisfied: row.satisfied === true }))
    .filter(row => row.surface || row.satisfied);
  if (!weighted.length) {
    const terms = requiredTerms(context);
    const denominator = Math.max(1, sum(terms.map(term => term.weight)));
    const covered = sum(terms.filter(term => containsSurface(stats.normalized, term.text)).map(term => term.weight));
    const raw = terms.length ? clamp01(covered / denominator) : 1;
    return { raw, reasonIds: ["surface.creative.constraint.required_terms"], trace: toJsonValue({ requiredTermCount: terms.length, coveredWeight: covered, totalWeight: denominator }) };
  }
  const totalWeight = sum(weighted.map(row => row.weight));
  const coveredRows = weighted.filter(row => (row.satisfied && !row.surface) || (Boolean(row.surface) && creativeSurfaceCovers(stats.normalized, row.surface)));
  const coveredWeight = sum(coveredRows.map(row => row.weight));
  const raw = clamp01(coveredWeight / Math.max(0.000001, totalWeight));
  return { raw, reasonIds: [raw >= 0.75 ? "surface.creative.constraint.covered" : "surface.creative.constraint.missing"], trace: toJsonValue({ totalWeight, coveredWeight, coveredConstraintSurfaces: coveredRows.map(row => row.surface).filter(Boolean) }) };
}

function creativeSurfaceCovers(normalizedText: string, surface: string): boolean {
  if (containsSurface(normalizedText, surface)) return true;
  return weightedJaccard(featureSet(normalizedText, 256), featureSet(surface, 256)) >= 0.28;
}

function creativeKnFluency(candidate: SurfaceEnergyCandidate): TermScore {
  const raw = clamp01(candidate.languageFit ?? candidate.languageActivation ?? 0);
  return { raw, reasonIds: [raw >= 0.5 ? "surface.creative.kn_fluency.supported" : "surface.creative.kn_fluency.weak"], trace: toJsonValue({ languageFit: candidate.languageFit ?? null, languageActivation: candidate.languageActivation ?? null }) };
}

function creativeStyleFit(candidate: SurfaceEnergyCandidate, context: SurfaceEnergyContext, stats: SurfaceStats): TermScore {
  const distance = styleVectorDistance(candidate, context, stats);
  const raw = clamp01(1 - distance.raw);
  return { raw, reasonIds: [raw >= 0.6 ? "surface.creative.style.aligned" : "surface.creative.style.distant"], trace: toJsonValue({ distance: distance.raw, distanceTrace: distance.trace }) };
}

function creativeSurfaceNovelty(candidate: SurfaceEnergyCandidate, context: SurfaceEnergyContext): TermScore {
  const candidateFeatures = featureSet(candidate.text, 384);
  const memorySurfaces = context.languagePrior?.surfaces ?? [];
  const maxOverlap = memorySurfaces.reduce((maximum, surface) => Math.max(maximum, weightedJaccard(candidateFeatures, featureSet(surface, 384))), 0);
  const raw = clamp01(1 - maxOverlap);
  return { raw, reasonIds: [raw >= 0.5 ? "surface.creative.novel" : "surface.creative.memory_repetition"], trace: toJsonValue({ comparedSurfaceCount: memorySurfaces.length, maxWeightedJaccard: maxOverlap }) };
}

function fakeFactualAuthority(candidate: SurfaceEnergyCandidate, context: SurfaceEnergyContext, stats: SurfaceStats): TermScore {
  const invention = inventionMetadata(context.construct);
  const basisEvidenceIds = new Set(stringArray(invention?.basisEvidenceIds));
  const claimBasis = inventionTraceRows(context.construct, "claimBasis");
  let exposedFactualPremises = 0;
  let unsupportedFactualPremises = 0;
  for (const row of claimBasis) {
    if (stringValue(row.kind) !== "factual_premise" && stringValue(row.force) !== "observed") continue;
    const surface = stringValue(row.surface);
    if (surface && !containsSurface(stats.normalized, surface)) continue;
    exposedFactualPremises++;
    const evidenceIds = stringArray(row.evidenceIds).filter(id => basisEvidenceIds.has(id));
    if (!evidenceIds.length) unsupportedFactualPremises++;
  }
  const explicitUnsupported = clamp01(numberValue(recordValue(invention?.trace).unsupportedFactualAssertion, 0));
  const candidateBasisEvidence = (candidate.evidenceIds ?? []).filter(id => basisEvidenceIds.has(id));
  const externallyAssertiveWithoutBasis = isAssertiveForce(candidate.force ?? context.expectedForce) && !candidateBasisEvidence.length ? 1 : 0;
  const claimBasisPenalty = exposedFactualPremises ? unsupportedFactualPremises / exposedFactualPremises : 0;
  const raw = clamp01(Math.max(explicitUnsupported, externallyAssertiveWithoutBasis, claimBasisPenalty));
  return {
    raw,
    reasonIds: [raw > 0 ? "surface.creative.fake_factual_authority" : "surface.creative.invented_content_nonfactual"],
    trace: toJsonValue({
      candidateForce: candidate.force ?? null,
      basisEvidenceCount: basisEvidenceIds.size,
      candidateBasisEvidenceCount: candidateBasisEvidence.length,
      exposedFactualPremises,
      unsupportedFactualPremises,
      explicitUnsupported,
      inventedContentWithoutEvidenceIsPenalized: false
    })
  };
}

function generalFakeFactualAuthority(candidate: SurfaceEnergyCandidate, context: SurfaceEnergyContext, stats: SurfaceStats): TermScore {
  const claims = claimBasesFor(context);
  const factualClaims = claims.filter(claim => claim.externallyFactual && claimIsExposed(claim, candidate, stats));
  const unsupportedClaims = factualClaims.filter(claim => !plannedClaimBasisIsAdmissible(claim));
  const candidateEvidence = new Set(candidate.evidenceIds ?? []);
  const groundedFactualClaims = factualClaims.filter(claim => plannedClaimBasisIsAdmissible(claim) && claim.evidenceIds.some(id => candidateEvidence.has(String(id))));
  const admissibleBasisEvidence = new Set(claims.filter(plannedClaimBasisIsAdmissible).flatMap(claim => claim.evidenceIds.map(String)));
  const directEvidence = new Set(context.directEvidenceIds ?? []);
  const candidateHasGroundingEvidence = [...candidateEvidence].some(id => admissibleBasisEvidence.has(id) || directEvidence.has(id));
  const externalAuthorityRequired = (context.requirementField?.externalTruthAuthority ?? 0) >= 0.5;
  const assertiveWithoutGrounding = externalAuthorityRequired && isAssertiveForce(candidate.force ?? context.expectedForce) && groundedFactualClaims.length === 0 && !candidateHasGroundingEvidence;
  const unsupportedRate = factualClaims.length ? unsupportedClaims.length / factualClaims.length : 0;
  const raw = clamp01(Math.max(unsupportedRate, assertiveWithoutGrounding ? 1 : 0));
  return {
    raw,
    reasonIds: [raw > 0 ? "surface.general.fake_factual_authority" : "surface.general.factual_basis_admissible"],
    trace: toJsonValue({ factualClaimIds: factualClaims.map(claim => claim.id), unsupportedClaimIds: unsupportedClaims.map(claim => claim.id), groundedClaimIds: groundedFactualClaims.map(claim => claim.id), candidateHasGroundingEvidence, externalAuthorityRequired, assertiveWithoutGrounding })
  };
}

function telemetryLeak(candidate: SurfaceEnergyCandidate): TermScore {
  const issues = detectCannedAnswerSpeech(candidate.text);
  const qualityTelemetry = issues.some(issue => issue.id === SURFACE_QUALITY_ISSUE_IDS.telemetry || issue.kind === "sq.kind.6b9e13d0");
  const internal = internalTelemetryHits(candidate.text);
  const metadata = recordValue(candidate.metadata);
  const declared = clamp01(numberValue(metadata.telemetryLeak, 0));
  const raw = clamp01(Math.max(qualityTelemetry ? 1 : 0, internal.length ? 1 : 0, declared));
  return { raw, reasonIds: [raw > 0 ? "surface.general.telemetry_leak" : "surface.general.telemetry_clear"], trace: toJsonValue({ qualityTelemetry, internal, declared }) };
}

function internalTelemetryHits(text: string): string[] {
  const normalized = normalizeSurface(text);
  const hits: string[] = [];
  const add = (id: string) => {
    if (!hits.includes(id)) hits.push(id);
  };
  if (/\b(?:construct|graph|feature\s*vector|score|proof|database\s*record)\s*(?:id|ids|label|labels|internals?)\s*[:=]/iu.test(text)) add("surface.telemetry.internal_label");
  if (/\b(?:node|edge|construct|candidate|proof|trace|frame|pattern):[a-z0-9_.:-]{3,}\b/iu.test(text)) add("surface.telemetry.control_identifier");
  if (/\b(?:node|edge|relation|hyperedge)_[0-9a-f]{32,64}\b/iu.test(text)) add("surface.telemetry.graph_identifier");
  const jsonLike = (normalized.startsWith("{") && normalized.endsWith("}")) || (normalized.startsWith("[") && normalized.endsWith("]"));
  if (jsonLike && /"(?:candidateId|constructIds|graphNodeIds|graphEdgeIds|featureVector|scoreTrace|proofVerdict|activeImportRunIds|databaseRecord)"\s*:/iu.test(text)) add("surface.telemetry.json_record");
  return hits;
}

function claimBasesFor(context: SurfaceEnergyContext): readonly PlannedClaim[] {
  return context.claimBases ?? context.selectedProposal?.claims ?? [];
}

function claimIsExposed(claim: PlannedClaim, candidate: SurfaceEnergyCandidate, stats: SurfaceStats): boolean {
  if (containsSurface(stats.normalized, claim.text)) return true;
  if (!claim.text.trim()) return false;
  return weightedJaccard(featureSet(candidate.text, 384), featureSet(claim.text, 256)) >= 0.26;
}

function plannedClaimBasisIsAdmissible(claim: PlannedClaim): boolean {
  if (!claim.text.trim()) return false;
  switch (claim.basis) {
    case "direct_evidence":
    case "source_synthesis":
      return claim.evidenceIds.length > 0;
    case "reasoned_inference":
    case "causal_inference":
    case "temporal_inference":
      return claim.graphEdgeIds.length > 0 || claim.priorIds.length > 0;
    case "counterfactual":
      return claim.hypothetical && (claim.graphEdgeIds.length > 0 || claim.priorIds.length > 0 || claim.graphNodeIds.length > 0);
    case "learned_prior":
      return claim.priorIds.length > 0 || claim.graphNodeIds.length > 0;
    case "invented":
    case "conjectured":
      return !claim.externallyFactual;
    case "translated":
      return claim.priorIds.length > 0 || claim.graphNodeIds.length > 0;
    case "action_result":
      return Boolean(claim.actionReceiptId);
    case "unsupported":
      return false;
  }
}

export function rankBySurfaceEnergy(candidates: readonly SurfaceEnergyCandidate[], context: SurfaceEnergyContext): RankedSurfaceCandidate[] {
  return candidates
    .map(candidate => ({ candidate, result: scoreSurfaceEnergy(candidate, context), rank: 0 }))
    .sort((left, right) =>
      Number(right.result.valid) - Number(left.result.valid) ||
      left.result.energy - right.result.energy ||
      left.candidate.id.localeCompare(right.candidate.id)
    )
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

export function explainSurfaceEnergy(result: SurfaceEnergyResult): JsonValue {
  const general = result.components.some(component => component.id.startsWith("surface.general."));
  const creative = result.components.some(component => component.id.startsWith("surface.creative."));
  return toJsonValue({
    candidateId: result.candidateId,
    textHash: result.textHash,
    valid: result.valid,
    energy: result.energy,
    surfaceScore: result.surfaceScore,
    objective: general ? GENERAL_COGNITION_SURFACE_BOOTSTRAP.objective : creative ? "surface.creative.bootstrap.v1" : "surface.walsh.default.v1",
    bootstrapVersion: general ? GENERAL_COGNITION_SURFACE_BOOTSTRAP.version : null,
    coefficientSchema: general ? GENERAL_COGNITION_SURFACE_BOOTSTRAP.coefficients : null,
    proofVerdictUsed: result.proofVerdictUsed ?? null,
    hardViolations: result.hardViolations,
    components: result.components.map(item => ({
      id: item.id,
      lambda: item.lambda,
      raw: item.raw,
      contribution: item.contribution,
      polarity: item.polarity,
      reasonIds: item.reasonIds,
      trace: item.trace
    }))
  });
}

function hardConstraintViolations(candidate: SurfaceEnergyCandidate, context: SurfaceEnergyContext, stats: SurfaceStats): SurfaceEnergyHardViolation[] {
  const out: SurfaceEnergyHardViolation[] = [];
  const add = (id: string, trace: JsonValue = {}) => out.push({ id, severity: "reject", trace });
  const numberSurfaces = requiredNumberSurfaces(context);
  const missingNumbers = numberSurfaces.filter(value => !containsSurface(stats.normalized, value));
  const requiredEntities = requiredEntitiesFor(context);
  const missingEntities = requiredEntities.filter(value => !containsSurface(stats.normalized, value));
  const requiredCaveats = requiredCaveatsFor(context);
  const missingCaveats = requiredCaveats.filter(value => !containsSurface(stats.normalized, value));
  const forbidden = forbiddenSurfaceHits(candidate, context, stats);
  const cannedSpeech = detectCannedAnswerSpeech(candidate.text);
  const proof = context.proofVerdict;
  const assertive = isAssertiveForce(candidate.force ?? context.expectedForce);
  const proofBoundarySurface = Boolean(proof && proof !== "certified" && !assertive);
  const programSurface = context.surfacePlan.constructForces.some(force => force.id === "ProgramConstruct");
  const creativeSurface = candidate.force === "creative" || context.surfacePlan.constructForces.some(force => force.id === "CreativeConstruct");
  if (missingNumbers.length && !proofBoundarySurface && !programSurface && !creativeSurface) add("surface.reject.required_number_dropped", toJsonValue({ missingNumbers }));
  if (missingEntities.length && !proofBoundarySurface && !programSurface && !creativeSurface) add("surface.reject.required_entity_dropped", toJsonValue({ missingEntities }));
  for (const quote of context.directQuoteBindings ?? []) {
    if (quote.text && !candidate.text.includes(quote.text)) add("surface.reject.direct_quote_mutated", toJsonValue({ quoteId: quote.id }));
  }
  if (forbidden.length) add("surface.reject.forbidden_surface", toJsonValue({ forbidden }));
  if (cannedSpeech.length) add(SURFACE_QUALITY_REJECTION_IDS.blockedSurface, toJsonValue({ issues: cannedSpeech.map(issue => ({ id: issue.id, kind: issue.kind, matched: issue.matched })) }));
  const learnedEvidence = new Set(context.learnedPriorEvidenceIds ?? []);
  const citedLearned = (candidate.evidenceIds ?? []).filter(id => learnedEvidence.has(id));
  if (citedLearned.length && isAssertiveForce(candidate.force ?? context.expectedForce)) add("surface.reject.learned_prior_cited_as_evidence", toJsonValue({ evidenceIds: citedLearned }));
  const fragment = fragmentCost(candidate, context, stats);
  if (fragment.raw > 0.88 && stats.surfaceUnitCount > 0) add("surface.reject.phrase_salad", fragment.trace);
  if (context.requirementField) {
    const telemetry = telemetryLeak(candidate);
    if (telemetry.raw > 0) add("surface.reject.telemetry_leak", telemetry.trace);
    const fakeFactual = generalFakeFactualAuthority(candidate, context, stats);
    if (fakeFactual.raw > 0) add("surface.reject.fake_factual_authority", fakeFactual.trace);
    const minimumPreservation = clamp01(context.minimumSemanticPreservation ?? 0);
    if (minimumPreservation > 0 && (candidate.semanticPreservation ?? 0) < minimumPreservation) {
      add("surface.reject.semantic_meaning_loss", toJsonValue({ required: minimumPreservation, observed: candidate.semanticPreservation ?? null }));
    }
    const requiredOutputSurfaces = (context.requiredOutputFeatures ?? [])
      .filter(feature => outputFeatureHard(feature))
      .map(outputFeatureSurface)
      .filter((surface): surface is string => Boolean(surface));
    const missingOutputSurfaces = requiredOutputSurfaces.filter(surface => !containsSurface(stats.normalized, surface));
    if (missingOutputSurfaces.length) add("surface.reject.required_output_feature_dropped", toJsonValue({ missingOutputSurfaces }));
    const prohibitedOutputHits = (context.prohibitedOutputFeatures ?? [])
      .map(outputFeatureSurface)
      .filter((surface): surface is string => Boolean(surface))
      .filter(surface => containsSurface(stats.normalized, surface));
    if (prohibitedOutputHits.length) add("surface.reject.prohibited_output_feature", toJsonValue({ prohibitedOutputHits }));
    const transformation = context.transformationBaseline;
    if (transformation) {
      const missingSurfaces = uniqueStrings([...(transformation.requiredSurfaces ?? []), ...(transformation.requiredCodeLiterals ?? [])])
        .filter(surface => !containsSurface(stats.normalized, surface));
      if (missingSurfaces.length) add("surface.reject.final_transformation_invariant_loss", toJsonValue({ missingSurfaces }));
      const format = surfaceFormatStats(candidate.text);
      const lineLoss = format.lineCount < Math.max(1, transformation.minimumLineCount ?? 1);
      const listLoss = format.listMarkerCount < Math.max(0, transformation.minimumListMarkerCount ?? 0);
      const codeFenceLoss = format.codeFenceCount < Math.max(0, transformation.minimumCodeFenceCount ?? 0);
      if (lineLoss || listLoss || codeFenceLoss) add("surface.reject.requested_format_lost", toJsonValue({ expected: transformation, observed: format }));
    }
  }
  return out;
}

function semanticLoss(candidate: SurfaceEnergyCandidate, context: SurfaceEnergyContext, stats: SurfaceStats): TermScore {
  const terms = requiredTerms(context);
  const missing = terms.filter(term => !containsSurface(stats.normalized, term.text));
  const weightedMissing = sum(missing.map(term => term.weight));
  const denominator = Math.max(1, sum(terms.map(term => term.weight)));
  const preservation = candidate.semanticPreservation;
  const preservationLoss = preservation === undefined ? 0 : clamp01(1 - preservation);
  const raw = clamp01(weightedMissing / denominator * 0.78 + preservationLoss * 0.22);
  return { raw, reasonIds: missing.length ? ["energy.semantic.missing_required_surface"] : ["energy.semantic.covered"], trace: toJsonValue({ missing: missing.map(term => term.text), required: terms.length, preservation: preservation ?? null }) };
}

function proofViolation(candidate: SurfaceEnergyCandidate, context: SurfaceEnergyContext, stats: SurfaceStats): TermScore {
  const proof = context.proofVerdict;
  if (!proof || proof === "certified") return { raw: 0, reasonIds: ["energy.proof.certified_or_unset"], trace: toJsonValue({ proof: proof ?? null }) };
  const caveats = requiredCaveatsFor(context);
  const caveatCovered = caveats.length > 0 && caveats.some(caveat => containsSurface(stats.normalized, caveat));
  const assertive = isAssertiveForce(candidate.force ?? context.expectedForce);
  let raw = 0.35;
  if (proof === "contradicted") raw = assertive ? 1 : caveatCovered ? 0.08 : 0.34;
  else if (proof === "unsupported_prior_only" || proof === "insufficient_evidence") raw = assertive ? 0.9 : caveatCovered ? 0.12 : 0.52;
  else if (proof === "source_bound_only") raw = assertive ? 0.62 : caveatCovered ? 0.1 : 0.32;
  else if (proof === "ambiguous") raw = assertive ? 0.58 : caveatCovered ? 0.1 : 0.28;
  return { raw: clamp01(raw), reasonIds: [caveatCovered ? "energy.proof.caveat_preserved" : "energy.proof.caveat_missing", assertive ? "energy.proof.assertive_surface" : "energy.proof.bounded_surface"], trace: toJsonValue({ proof, assertive, caveatCovered }) };
}

function forceMismatch(candidate: SurfaceEnergyCandidate, context: SurfaceEnergyContext): TermScore {
  const expected = context.expectedForce ?? context.surfacePlan.forceBindings[0]?.force;
  if (!expected || !candidate.force) return { raw: 0.08, reasonIds: ["energy.force.partial_binding"], trace: toJsonValue({ expected: expected ?? null, observed: candidate.force ?? null }) };
  const raw = candidate.force === expected ? 0 : compatibleForce(expected, candidate.force) ? 0.18 : 0.72;
  return { raw, reasonIds: [raw === 0 ? "energy.force.exact" : raw < 0.3 ? "energy.force.compatible" : "energy.force.mismatch"], trace: toJsonValue({ expected, observed: candidate.force }) };
}

function contradictionLeak(candidate: SurfaceEnergyCandidate, context: SurfaceEnergyContext, stats: SurfaceStats): TermScore {
  const contradictionPressure = clamp01(context.fieldSummary?.contradictionPressure ?? context.field?.alphaTrace.surfaces.contradiction ?? 0);
  const proofContradicted = context.proofVerdict === "contradicted";
  const hasCaveat = requiredCaveatsFor(context).some(caveat => containsSurface(stats.normalized, caveat));
  const assertive = isAssertiveForce(candidate.force ?? context.expectedForce);
  const raw = clamp01((proofContradicted && assertive ? 0.72 : 0) + contradictionPressure * (hasCaveat ? 0.18 : 0.54));
  return { raw, reasonIds: [raw > 0 ? "energy.contradiction.pressure" : "energy.contradiction.clear"], trace: toJsonValue({ proofContradicted, assertive, hasCaveat, contradictionPressure }) };
}

function repetitionCost(candidate: SurfaceEnergyCandidate, context: SurfaceEnergyContext, stats: SurfaceStats): TermScore {
  void candidate;
  void context;
  const counts = countValues(stats.surfaceUnits);
  const repeated = [...counts.values()].filter(count => count > 1).reduce((sumValue, count) => sumValue + count - 1, 0);
  const sentenceCounts = countValues(stats.sentences);
  const repeatedSentences = [...sentenceCounts.values()].filter(count => count > 1).reduce((sumValue, count) => sumValue + count - 1, 0);
  const raw = clamp01(repeated / Math.max(3, stats.surfaceUnits.length) * 0.68 + repeatedSentences / Math.max(1, stats.sentences.length) * 0.32);
  return { raw, reasonIds: [repeated || repeatedSentences ? "energy.repetition.detected" : "energy.repetition.clear"], trace: toJsonValue({ repeatedSurfaceUnits: repeated, repeatedSentences, surfaceUnitCount: stats.surfaceUnits.length }) };
}

function fragmentCost(candidate: SurfaceEnergyCandidate, context: SurfaceEnergyContext, stats: SurfaceStats): TermScore {
  void candidate;
  void context;
  if (!stats.normalized) return { raw: 1, reasonIds: ["energy.fragment.empty"], trace: toJsonValue({ reason: "surface.empty" }) };
  const shortSurfaceUnits = stats.surfaceUnits.filter(surfaceUnit => surfaceUnit.length <= 1).length;
  const averageSurfaceUnitLength = stats.surfaceUnits.length ? sum(stats.surfaceUnits.map(surfaceUnit => surfaceUnit.length)) / stats.surfaceUnits.length : 0;
  const punctuationRatio = stats.charCount ? stats.punctuationCount / stats.charCount : 0;
  const veryShortSentenceRatio = stats.sentences.length ? stats.sentences.filter(sentence => surfaceUnitsFrom(sentence).length <= 1).length / stats.sentences.length : 0;
  const diversity = uniqueCount(stats.surfaceUnits) / Math.max(1, stats.surfaceUnits.length);
  const raw = clamp01(shortSurfaceUnits / Math.max(1, stats.surfaceUnits.length) * 0.22 + (averageSurfaceUnitLength < 2.4 ? 0.22 : 0) + punctuationRatio * 0.8 + veryShortSentenceRatio * 0.25 + (diversity < 0.32 ? 0.25 : 0));
  return { raw, reasonIds: [raw > 0.5 ? "energy.fragment.high" : "energy.fragment.low"], trace: toJsonValue({ shortSurfaceUnits, averageSurfaceUnitLength, punctuationRatio, veryShortSentenceRatio, diversity }) };
}

function caveatLoss(candidate: SurfaceEnergyCandidate, context: SurfaceEnergyContext, stats: SurfaceStats): TermScore {
  void candidate;
  const caveats = requiredCaveatsFor(context);
  if (!caveats.length) return { raw: 0, reasonIds: ["energy.caveat.none_required"], trace: toJsonValue({ requiredCaveats: 0 }) };
  const missing = caveats.filter(caveat => !containsSurface(stats.normalized, caveat));
  return { raw: clamp01(missing.length / caveats.length), reasonIds: [missing.length ? "energy.caveat.missing" : "energy.caveat.covered"], trace: toJsonValue({ missing, requiredCaveats: caveats.length }) };
}

function correctionViolation(candidate: SurfaceEnergyCandidate, context: SurfaceEnergyContext, stats: SurfaceStats): TermScore {
  const termRewrites = context.correction?.termRewrites ?? [];
  const forbidden = forbiddenSurfaceHits(candidate, context, stats);
  let misses = 0;
  for (const item of termRewrites) {
    const patternSeen = item.pattern ? containsSurface(stats.normalized, item.pattern) : false;
    const replacementSeen = item.replacement ? containsSurface(stats.normalized, item.replacement) : false;
    if (patternSeen && !replacementSeen) misses++;
  }
  const raw = clamp01(misses / Math.max(1, termRewrites.length) * 0.7 + forbidden.length * 0.25);
  return { raw, reasonIds: [misses || forbidden.length ? "energy.correction.violation" : "energy.correction.aligned"], trace: toJsonValue({ termRewrites: termRewrites.length, misses, forbidden }) };
}

function styleVectorDistance(candidate: SurfaceEnergyCandidate, context: SurfaceEnergyContext, stats: SurfaceStats): TermScore {
  void candidate;
  const target = context.correction?.styleVector ?? context.styleVector;
  if (!target?.length) return { raw: 0.08, reasonIds: ["energy.style.no_vector"], trace: toJsonValue({ target: null }) };
  const observed = observedStyleVector(stats);
  const raw = vectorDistance(observed, target.slice(0, observed.length));
  return { raw, reasonIds: [raw < 0.24 ? "energy.style.close" : "energy.style.distant"], trace: toJsonValue({ observed, target: target.slice(0, observed.length) }) };
}

function detailProfileDistance(candidate: SurfaceEnergyCandidate, context: SurfaceEnergyContext, stats: SurfaceStats): TermScore {
  void candidate;
  const policy = context.detailProfile;
  const targetSurfaceUnits = policy?.baseSurfaceUnitTarget ?? surfaceUnitTargetFromSurfacePlan(context.surfacePlan);
  const targetDensity = policy?.density ?? context.surfacePlan.style.density;
  const surfaceDensity = clamp01(stats.surfaceUnitCount / Math.max(1, targetSurfaceUnits));
  const extentDistance = Math.abs(stats.surfaceUnitCount - targetSurfaceUnits) / Math.max(1, targetSurfaceUnits);
  const densityDistance = Math.abs(surfaceDensity - targetDensity);
  const raw = clamp01(extentDistance * 0.62 + densityDistance * 0.38);
  return { raw, reasonIds: [raw < 0.28 ? "energy.detail.close" : "energy.detail.distant"], trace: toJsonValue({ surfaceUnitCount: stats.surfaceUnitCount, targetSurfaceUnits, surfaceDensity, targetDensity }) };
}

function boundaryInstability(candidate: SurfaceEnergyCandidate, context: SurfaceEnergyContext, stats: SurfaceStats): TermScore {
  const decisions = candidate.boundaryDecisions ?? [];
  const repeatedPenalty = sum(decisions.map(item => clamp01(item.repeatedBoundaryPenalty ?? 0)));
  const repeatedBoundaries = [...countValues(stats.boundaryTexts).values()].filter(count => count > 1).reduce((sumValue, count) => sumValue + count - 1, 0);
  const profile = context.boundaryProfile ?? context.surfacePlan.boundaryProfile;
  const unsupportedBoundaries = stats.boundaryTexts.filter(text => !profile.sentenceForms.includes(text) && !profile.inlineForms.includes(text)).length;
  const raw = clamp01(repeatedPenalty * 0.7 + repeatedBoundaries / Math.max(1, stats.boundaryTexts.length) * 0.24 + unsupportedBoundaries / Math.max(1, stats.boundaryTexts.length) * 0.2);
  return { raw, reasonIds: [raw > 0 ? "energy.boundary.instability" : "energy.boundary.stable"], trace: toJsonValue({ repeatedPenalty, repeatedBoundaries, unsupportedBoundaries, boundaryCount: stats.boundaryTexts.length }) };
}

function languagePriorSupport(candidate: SurfaceEnergyCandidate, context: SurfaceEnergyContext, stats: SurfaceStats, hardViolations: readonly SurfaceEnergyHardViolation[], proofRaw: number): TermScore {
  if (hardViolations.length) return { raw: 0, reasonIds: ["energy.language.gated_by_hard_surface_violation"], trace: toJsonValue({ gated: true, hardViolations: hardViolations.map(item => item.id), proofRaw }) };
  const activation = clamp01(candidate.languageActivation ?? context.languagePrior?.activation ?? 0);
  const fit = clamp01(candidate.languageFit ?? context.languagePrior?.fit ?? activation);
  const imported = uniqueCount([...(candidate.importedPieceIds ?? []), ...(context.languagePrior?.importedPieceIds ?? [])]);
  const surfaces = context.languagePrior?.surfaces ?? [];
  const surfaceOverlap = surfaces.length ? surfaces.filter(surface => containsSurface(stats.normalized, surface)).length / surfaces.length : 0;
  const raw = clamp01(activation * 0.42 + fit * 0.22 + Math.min(1, imported / 8) * 0.18 + surfaceOverlap * 0.18);
  return { raw, reasonIds: [raw > 0 ? "energy.language.prior_support" : "energy.language.no_prior_support"], trace: toJsonValue({ activation, fit, imported, surfaceOverlap }) };
}

function actionability(candidate: SurfaceEnergyCandidate, context: SurfaceEnergyContext, stats: SurfaceStats): TermScore {
  void candidate;
  const fieldActionability = clamp01(context.fieldSummary?.actionability ?? context.field?.alphaTrace.surfaces.actionability ?? 0);
  const instructionMass = context.surfacePlan.orderedPoints.filter(point => point.role === "instruction" || point.role === "conclusion").length / Math.max(1, context.surfacePlan.orderedPoints.length);
  const contentEnough = stats.surfaceUnitCount >= Math.min(8, surfaceUnitTargetFromSurfacePlan(context.surfacePlan) * 0.35) ? 0.3 : 0;
  const raw = clamp01(fieldActionability * 0.48 + instructionMass * 0.22 + contentEnough);
  return { raw, reasonIds: [raw > 0 ? "energy.action.surface" : "energy.action.none"], trace: toJsonValue({ fieldActionability, instructionMass, contentEnough }) };
}

function compressionFit(candidate: SurfaceEnergyCandidate, context: SurfaceEnergyContext, stats: SurfaceStats): TermScore {
  void candidate;
  const surfaceMassTarget = surfaceUnitTargetFromSurfacePlan(context.surfacePlan);
  const density = clamp01(context.detailProfile?.density ?? context.surfacePlan.style.density);
  const targetSurfaceUnits = density < 0.4 ? Math.max(4, Math.round(surfaceMassTarget * (0.24 + density * 0.34))) : surfaceMassTarget;
  const surfaceUnitDistance = Math.abs(stats.surfaceUnitCount - targetSurfaceUnits) / Math.max(1, targetSurfaceUnits);
  const excessSurfaceMass = stats.surfaceUnitCount > surfaceMassTarget ? (stats.surfaceUnitCount - surfaceMassTarget) / Math.max(1, surfaceMassTarget) : 0;
  const raw = clamp01(1 - surfaceUnitDistance - excessSurfaceMass * 0.35);
  return { raw, reasonIds: [raw > 0.6 ? "energy.compression.fit" : "energy.compression.mismatch"], trace: toJsonValue({ surfaceUnitCount: stats.surfaceUnitCount, surfaceMassTarget, density, targetSurfaceUnits, surfaceUnitDistance, excessSurfaceMass }) };
}

interface TermScore {
  raw: number;
  reasonIds: string[];
  trace: JsonValue;
}

function component(id: string, lambda: number, score: TermScore, polarity: "loss" | "support" = "loss"): SurfaceEnergyComponent {
  return {
    id,
    lambda,
    raw: clamp01(score.raw),
    contribution: Number((lambda * clamp01(score.raw)).toFixed(8)),
    polarity,
    reasonIds: score.reasonIds,
    trace: score.trace
  };
}

function surfaceStats(candidate: SurfaceEnergyCandidate): SurfaceStats {
  const normalized = normalizeSurface(candidate.text);
  const surfaceUnits = surfaceUnitsFrom(normalized);
  const sentences = sentenceList(candidate.text);
  const boundaryTexts = candidate.boundaryDecisions?.map(item => item.text).filter(Boolean) ?? boundaryTextsFrom(candidate.text);
  return {
    normalized,
    surfaceUnits,
    sentences,
    surfaceUnitCount: surfaceUnits.length,
    charCount: [...candidate.text].length,
    punctuationCount: [...candidate.text].filter(isBoundaryLike).length,
    boundaryTexts
  };
}

function requiredTerms(context: SurfaceEnergyContext): Array<{ text: string; weight: number }> {
  const terms = context.surfacePlan.requiredTerms.map(term => ({ text: term.text, weight: term.weight }));
  for (const entity of context.requiredEntities ?? []) terms.push({ text: entity, weight: 0.86 });
  for (const number of requiredNumberSurfaces(context)) terms.push({ text: number, weight: 0.96 });
  for (const caveat of requiredCaveatsFor(context)) terms.push({ text: caveat, weight: 0.92 });
  return dedupeTerms(terms.filter(term => term.text.trim()));
}

function outputFeatureSurface(feature: SurfaceOutputFeature): string | undefined {
  if ("surface" in feature && typeof feature.surface === "string") return feature.surface.trim() || undefined;
  return undefined;
}

function outputFeatureHard(feature: SurfaceOutputFeature): boolean {
  if ("dimension" in feature) return feature.status === "explicit" && feature.confidence >= 0.85;
  return feature.hard === true;
}

function outputFeatureWeight(feature: SurfaceOutputFeature): number {
  if ("dimension" in feature) return Math.max(0.05, clamp01(feature.value) * clamp01(feature.confidence));
  return feature.hard ? 1 : 0.65;
}

function surfaceFormatStats(text: string): { lineCount: number; listMarkerCount: number; codeFenceCount: number } {
  const lines = text.split(/\r?\n/u);
  const listMarkerCount = lines.filter(line => /^\s*(?:[-*+] |\d+[.)] )/u.test(line)).length;
  const codeFenceCount = (text.match(/```/gu) ?? []).length;
  return { lineCount: Math.max(1, lines.length), listMarkerCount, codeFenceCount };
}

function requiredNumberSurfaces(context: SurfaceEnergyContext): string[] {
  return uniqueStrings([...(context.requiredNumbers ?? [])]);
}

function requiredEntitiesFor(context: SurfaceEnergyContext): string[] {
  return uniqueStrings([...(context.requiredEntities ?? [])]);
}

function requiredCaveatsFor(context: SurfaceEnergyContext): string[] {
  const caveats = [...(context.requiredCaveats ?? []), ...context.surfacePlan.caveatBindings.map(item => item.reason)].filter(Boolean);
  return uniqueStrings(caveats);
}

function forbiddenSurfaceHits(candidate: SurfaceEnergyCandidate, context: SurfaceEnergyContext, stats: SurfaceStats): string[] {
  const hits = new Set(candidate.forbiddenSurfaceHits ?? []);
  for (const item of context.forbiddenSurfaces ?? []) {
    if (item.text && containsSurface(stats.normalized, item.text)) hits.add(item.id);
  }
  return [...hits].sort();
}

function compatibleForce(expected: OutputForce, observed: OutputForce): boolean {
  if (expected === "bounded" && (observed === "underdetermined" || observed === "observed")) return true;
  if (expected === "observed" && observed === "bounded") return true;
  if (expected === "entailed" && observed === "observed") return true;
  return false;
}

function isAssertiveForce(force: OutputForce | undefined): boolean {
  return force === "entailed" || force === "observed";
}

function observedStyleVector(stats: SurfaceStats): number[] {
  const sentenceCount = Math.max(1, stats.sentences.length);
  const density = clamp01(stats.surfaceUnitCount / Math.max(1, sentenceCount * 18));
  const sequence = clamp01(sentenceCount / 7);
  const boundaryMass = clamp01(stats.boundaryTexts.length / Math.max(1, sentenceCount * 2));
  return [density, sequence, boundaryMass];
}

function surfaceUnitTargetFromSurfacePlan(plan: SurfacePlan): number {
  const audit = plan.audit && typeof plan.audit === "object" && !Array.isArray(plan.audit) ? plan.audit as Record<string, JsonValue> : {};
  const detail = audit.detailPolicy && typeof audit.detailPolicy === "object" && !Array.isArray(audit.detailPolicy) ? audit.detailPolicy as Record<string, JsonValue> : {};
  const surfaceUnitTarget = detail.baseSurfaceUnitTarget;
  if (typeof surfaceUnitTarget === "number" && Number.isFinite(surfaceUnitTarget) && surfaceUnitTarget > 0) return surfaceUnitTarget;
  if (plan.detailProfileId.endsWith(".0")) return 18;
  if (plan.detailProfileId.endsWith(".2")) return 34;
  if (plan.detailProfileId.endsWith(".3")) return 28;
  return 24;
}

function dedupeTerms(terms: readonly { text: string; weight: number }[]): Array<{ text: string; weight: number }> {
  const out = new Map<string, { text: string; weight: number }>();
  for (const term of terms) {
    const key = normalizeSurface(term.text);
    const existing = out.get(key);
    if (!existing || term.weight > existing.weight) out.set(key, { text: term.text, weight: clamp01(term.weight) });
  }
  return [...out.values()];
}

function sentenceList(text: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const char of text) {
    current += char;
    if (char === "." || char === "!" || char === "?" || char === "\n" || char === "。" || char === "؟" || char === "।") {
      const clean = normalizeSurface(current);
      if (clean) out.push(clean);
      current = "";
    }
  }
  const clean = normalizeSurface(current);
  if (clean) out.push(clean);
  return out;
}

function boundaryTextsFrom(text: string): string[] {
  const out: string[] = [];
  for (const char of text) if (isBoundaryLike(char)) out.push(char);
  return out;
}

function surfaceUnitsFrom(text: string): string[] {
  const surfaceUnits: string[] = [];
  let current = "";
  for (const char of normalizeSurface(text)) {
    if (isSurfaceUnitChar(char)) {
      current += char;
      continue;
    }
    if (current) {
      surfaceUnits.push(current);
      current = "";
    }
  }
  if (current) surfaceUnits.push(current);
  return surfaceUnits;
}

function normalizeSurface(text: string): string {
  let out = "";
  let pendingSpace = false;
  for (const char of text.normalize("NFKC").toLocaleLowerCase()) {
    if (isWhitespace(char)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) out += " ";
    pendingSpace = false;
    out += char;
  }
  return out.trim();
}

function containsSurface(normalizedText: string, surface: string): boolean {
  const normalizedSurface = normalizeSurface(surface);
  return Boolean(normalizedSurface) && normalizedText.includes(normalizedSurface);
}

function isSurfaceUnitChar(char: string): boolean {
  const cp = char.codePointAt(0) ?? 0;
  if (cp >= 48 && cp <= 57) return true;
  if (cp >= 65 && cp <= 90) return true;
  if (cp >= 97 && cp <= 122) return true;
  if (char === "_" || char === "-") return true;
  return cp > 127 && !isWhitespace(char) && !isBoundaryLike(char);
}

function isNumericSurfaceUnit(surfaceUnit: string): boolean {
  let seen = false;
  for (const char of surfaceUnit) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp >= 48 && cp <= 57) {
      seen = true;
      continue;
    }
    if (char === "." || char === "," || char === "_" || char === "-") continue;
    return false;
  }
  return seen;
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f" || char === "\v";
}

function isBoundaryLike(char: string): boolean {
  return char === "." || char === "," || char === ";" || char === ":" || char === "!" || char === "?" || char === "\n" || char === "。" || char === "،" || char === "؟" || char === "।";
}

function vectorDistance(left: readonly number[], right: readonly number[]): number {
  const length = Math.max(left.length, right.length, 1);
  let total = 0;
  for (let i = 0; i < length; i++) total += Math.abs(clamp01(left[i] ?? 0) - clamp01(right[i] ?? 0.5));
  return clamp01(total / length);
}

function countValues(values: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const value of values) out.set(value, (out.get(value) ?? 0) + 1);
  return out;
}

function inventionMetadata(construct: ConstructGraph | undefined): Record<string, JsonValue> | undefined {
  if (!construct) return undefined;
  const row = construct.nodes
    .map(node => ({ node, metadata: recordValue(node.metadata) }))
    .find(item => item.node.kind === "construct:invention" || item.metadata.schema === "scce.invention_construct.v1");
  return row?.metadata;
}

function inventionTraceRows(construct: ConstructGraph | undefined, key: string): Array<Record<string, JsonValue>> {
  const trace = recordValue(inventionMetadata(construct)?.trace);
  const value = trace[key];
  return Array.isArray(value) ? value.map(recordValue).filter(row => Object.keys(row).length > 0) : [];
}

function recordValue(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

function stringValue(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberValue(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positiveNumber(value: JsonValue | undefined, fallback: number): number {
  const number = numberValue(value, fallback);
  return number > 0 ? number : fallback;
}

function uniqueCount(values: readonly string[]): number {
  return new Set(values).size;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function meanOr(values: readonly number[], fallback: number): number {
  return values.length ? sum(values) / values.length : fallback;
}

function hashText(text: string): string {
  let h1 = 2166136261;
  let h2 = 16777619;
  for (let i = 0; i < text.length; i++) {
    const cp = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ cp, 16777619);
    h2 = Math.imul(h2 + cp, 1099511627);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
}
