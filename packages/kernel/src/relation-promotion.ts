// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify, createHasher, toJsonValue } from "./primitives.js";
import type { StructuredSemanticCandidate } from "./structured-semantic-candidate.js";
import type { SemanticCandidateChannel } from "./structured-semantic-candidate.js";
import type { Hasher, JsonValue } from "./types.js";

export const RELATION_PROMOTION_MODEL_SCHEMA = "scce.relation_promotion_model.v2" as const;

export type RelationPromotionControlKind = "shuffled_relations" | "duplicate_only" | "random_repetition";

export interface RelationPromotionControlResult {
  kind: RelationPromotionControlKind;
  gainNats: number;
  recoveryGain: number;
  independentSourceCount: number;
  promoted: boolean;
}

export interface RelationPromotionDecision {
  relationSeedId: string;
  channel: SemanticCandidateChannel;
  promoted: boolean;
  candidateCount: number;
  independentSourceCount: number;
  fitSourceFamilyIds: string[];
  holdoutSourceFamilyIds: string[];
  descriptionLength: {
    baselineHeldoutNats: number;
    relationHeldoutNats: number;
    relationModelNats: number;
    promotedDescriptionNats: number;
    gainNats: number;
  };
  recovery: {
    baselineProbability: number;
    relationProbability: number;
    gain: number;
  };
  controls: RelationPromotionControlResult[];
  reasons: string[];
}

export interface RelationPromotionModel {
  schema: typeof RELATION_PROMOTION_MODEL_SCHEMA;
  id: string;
  candidateIds: string[];
  fitSourceFamilyIds: string[];
  holdoutSourceFamilyIds: string[];
  decisions: RelationPromotionDecision[];
  audit: JsonValue;
}

export interface RelationObservation {
  candidateId: string;
  relationSeedId: string;
  channel: SemanticCandidateChannel;
  sourceId: string;
  sourceFamilyId: string;
  signature: string;
}

interface Evaluation {
  gainNats: number;
  baselineHeldoutNats: number;
  relationHeldoutNats: number;
  relationModelNats: number;
  baselineRecoveryProbability: number;
  relationRecoveryProbability: number;
  recoveryGain: number;
  independentSourceCount: number;
}

const DIRICHLET_ALPHA = 0.5;
const MIN_INDEPENDENT_SOURCES = 4;
const MIN_FIT_SOURCES = 2;

/**
 * Compiles reusable relation identities from source-structured candidates.
 *
 * The data code is a Dirichlet-smoothed categorical code over canonical
 * participant/qualifier signatures. The null model uses the corpus-wide
 * signature distribution; M ⊕ r uses the relation-conditioned distribution.
 * The relation code is an explicit BIC-style two-part model code. Candidate
 * frequency within one source is collapsed before fitting, so duplication
 * cannot create independent evidence.
 */
export function compileRelationPromotionModel(input: {
  candidates: readonly StructuredSemanticCandidate[];
  priorObservations?: readonly RelationObservation[];
  hasher?: Hasher;
}): RelationPromotionModel {
  const hasher = input.hasher ?? createHasher();
  // A relation earns its identity across independent sources, and sources arrive one ingestion at a time. Scoring
  // only the batch in hand meant a corpus of thousands of documents was judged four documents at a time, and no
  // relation ever reached the independence the gate asks for. Prior runs' observations are the same sufficient
  // statistics, deduplicated the same way, so carrying them forward changes what is known, not how it is judged.
  const observations = mergeRelationObservations(
    relationObservations(input.candidates),
    input.priorObservations ?? []
  );
  const relationSeedIds = [...new Set(observations.map(row => row.relationSeedId))].sort();
  const sourceFamilyIds = [...new Set(observations.map(row => row.sourceFamilyId))].sort();
  const split = sourceDisjointSplit(sourceFamilyIds, hasher);
  const fit = observations.filter(row => split.fit.has(row.sourceFamilyId));
  const holdout = observations.filter(row => split.holdout.has(row.sourceFamilyId));
  // Everything a decision needs about its channel is the same for every relation in that channel, and there are a
  // handful of channels against thousands of relations. Deriving it inside the loop meant six full scans of the
  // observation set per relation: measured on 16 corpus documents, 1,285 relations over 2,068 observations took
  // 22s, and the cost grew with the square of the corpus, which put a corpus-scale promotion pass out of reach for
  // the one channel that produces thousands of relations. Same arithmetic, computed once per channel.
  const channelScope = channelScopes(observations, fit, holdout, hasher);
  const channelOf = new Map<string, SemanticCandidateChannel>();
  for (const row of observations) if (!channelOf.has(row.relationSeedId)) channelOf.set(row.relationSeedId, row.channel);
  const decisions = relationSeedIds.map(relationSeedId => {
    const channel = channelOf.get(relationSeedId)!;
    const scope = channelScope.get(channel)!;
    const actual = evaluateRelation(relationSeedId, scope.actual, scope.holdoutBySeed);
    const sourceCount = scope.observationSourceFamilies.get(relationSeedId)?.size ?? 0;
    const fitSourceFamilyIds = scope.fitSourceFamilies.get(relationSeedId) ?? [];
    const holdoutSourceFamilyIds = scope.holdoutSourceFamilies.get(relationSeedId) ?? [];
    const controls = controlResults(relationSeedId, scope);
    const reasons: string[] = [];
    if (sourceCount < MIN_INDEPENDENT_SOURCES) reasons.push("insufficient_independent_sources");
    if (fitSourceFamilyIds.length < MIN_FIT_SOURCES) reasons.push("insufficient_fit_source_families");
    if (!holdoutSourceFamilyIds.length) reasons.push("missing_source_family_disjoint_holdout");
    if (!(actual.gainNats > 0)) reasons.push("nonpositive_heldout_description_length_gain");
    if (!(actual.recoveryGain > 0)) reasons.push("no_heldout_recovery_improvement");
    if (controls.some(control => control.promoted)) reasons.push("negative_control_induced_relation");
    const promoted = reasons.length === 0;
    return {
      relationSeedId,
      channel,
      promoted,
      candidateCount: observations.filter(row => row.relationSeedId === relationSeedId).length,
      independentSourceCount: sourceCount,
      fitSourceFamilyIds,
      holdoutSourceFamilyIds,
      descriptionLength: {
        baselineHeldoutNats: actual.baselineHeldoutNats,
        relationHeldoutNats: actual.relationHeldoutNats,
        relationModelNats: actual.relationModelNats,
        promotedDescriptionNats: quantize(actual.relationHeldoutNats + actual.relationModelNats),
        gainNats: actual.gainNats
      },
      recovery: {
        baselineProbability: actual.baselineRecoveryProbability,
        relationProbability: actual.relationRecoveryProbability,
        gain: actual.recoveryGain
      },
      controls,
      reasons
    };
  });
  const canonical = {
    schema: RELATION_PROMOTION_MODEL_SCHEMA,
    candidateIds: [...new Set(input.candidates.map(candidate => candidate.id))].sort(),
    fitSourceFamilyIds: [...split.fit].sort(),
    holdoutSourceFamilyIds: [...split.holdout].sort(),
    decisions
  };
  return {
    ...canonical,
    id: `relation_promotion.${hasher.digestHex(canonicalStringify(canonical)).slice(0, 40)}`,
    audit: toJsonValue({
      compiler: "kernel.relation_promotion.heldout_description_length.v2",
      code: {
        null: "dirichlet_smoothed_corpus_signature_code",
        promoted: "dirichlet_smoothed_relation_signature_code",
        model: "bic_two_part_relation_code",
        dirichletAlpha: DIRICHLET_ALPHA
      },
      sourceFamilyDisjoint: true,
      channelSeparatedEvaluation: true,
      candidateCountsByChannel: Object.fromEntries(
        ([
          "source_declared_structured",
          "anchor_derived",
          "cross_document_induced",
          "weak_free_surface"
        ] as const).map(channel => [
          channel,
          input.candidates.filter(candidate => candidate.channel === channel).length
        ])
      ),
      occurrenceCollapsedWithinSourceFamily: true,
      minimumIndependentSources: MIN_INDEPENDENT_SOURCES,
      minimumFitSources: MIN_FIT_SOURCES,
      candidateCount: input.candidates.length,
      independentObservationCount: observations.length,
      promotedRelationCount: decisions.filter(decision => decision.promoted).length,
      rejectedRelationCount: decisions.filter(decision => !decision.promoted).length
    })
  };
}

export function relationPromotionDecision(
  model: RelationPromotionModel | undefined,
  relationSeedId: string
): RelationPromotionDecision | undefined {
  return model?.decisions.find(decision => decision.relationSeedId === relationSeedId);
}

/** Observations from prior runs join this run's, deduplicated on the identity that makes a source independent. Pure. */
export function mergeRelationObservations(
  current: readonly RelationObservation[],
  prior: readonly RelationObservation[]
): RelationObservation[] {
  const unique = new Map<string, RelationObservation>();
  for (const row of [...prior, ...current]) {
    unique.set(canonicalStringify({
      relationSeedId: row.relationSeedId,
      channel: row.channel,
      sourceFamilyId: row.sourceFamilyId,
      signature: row.signature
    }), row);
  }
  return [...unique.values()].sort((left, right) =>
    left.sourceFamilyId.localeCompare(right.sourceFamilyId)
    || left.sourceId.localeCompare(right.sourceId)
    || left.relationSeedId.localeCompare(right.relationSeedId)
    || left.signature.localeCompare(right.signature)
    || left.candidateId.localeCompare(right.candidateId));
}

/** This run's candidates as promotion observations, for the store that carries them to the next run. Pure. */
export function relationObservationsFromCandidates(
  candidates: readonly StructuredSemanticCandidate[]
): RelationObservation[] {
  return relationObservations(candidates);
}

function relationObservations(candidates: readonly StructuredSemanticCandidate[]): RelationObservation[] {
  const unique = new Map<string, RelationObservation>();
  for (const candidate of candidates) {
    if (!candidate.id || !candidate.relationSeedId || !candidate.sourceId) continue;
    const signature = candidateSignature(candidate);
    const sourceFamilyId = sourceFamilyFor(candidate);
    const key = canonicalStringify({
      relationSeedId: candidate.relationSeedId,
      channel: candidate.channel,
      sourceFamilyId,
      signature
    });
    unique.set(key, {
      candidateId: candidate.id,
      relationSeedId: candidate.relationSeedId,
      channel: candidate.channel,
      sourceId: String(candidate.sourceId),
      sourceFamilyId,
      signature
    });
  }
  return [...unique.values()].sort((left, right) =>
    left.sourceFamilyId.localeCompare(right.sourceFamilyId)
    || left.sourceId.localeCompare(right.sourceId)
    || left.relationSeedId.localeCompare(right.relationSeedId)
    || left.signature.localeCompare(right.signature)
    || left.candidateId.localeCompare(right.candidateId));
}

function candidateSignature(candidate: StructuredSemanticCandidate): string {
  return canonicalStringify({
    arity: candidate.participants.length,
    ports: candidate.participants.map((participant, index) => ({
      position: index,
      valueKind: participant.valueKind
    })),
    qualifierShape: jsonShape(candidate.qualifiers)
  });
}

function jsonShape(value: JsonValue): JsonValue {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.map(jsonShape);
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, jsonShape(value[key]!)]));
  }
  return typeof value;
}

function sourceDisjointSplit(sourceIds: readonly string[], hasher: Hasher): {
  fit: Set<string>;
  holdout: Set<string>;
} {
  if (sourceIds.length < MIN_INDEPENDENT_SOURCES) {
    return { fit: new Set(sourceIds), holdout: new Set() };
  }
  const ranked = sourceIds.map(sourceId => ({
    sourceId,
    rank: hasher.digestHex(`relation-promotion-holdout\u001f${sourceId}`)
  })).sort((left, right) => left.rank.localeCompare(right.rank) || left.sourceId.localeCompare(right.sourceId));
  const holdoutCount = Math.max(1, Math.floor(sourceIds.length / 4));
  const holdout = new Set(ranked.slice(0, holdoutCount).map(row => row.sourceId));
  return {
    fit: new Set(sourceIds.filter(sourceId => !holdout.has(sourceId))),
    holdout
  };
}

/**
 * One relation's held-out description length and recovery, read off a fit set that was prepared once.
 *
 * Everything here except the target's own rows is shared by every relation judged against the same fit: the
 * background signature counts, each relation's prior, and the normalising denominator the recovery posterior
 * divides by. Deriving them per relation is what made the pass grow with the square of the corpus.
 */
function evaluateRelation(
  relationSeedId: string,
  scope: FitScope,
  holdoutBySeed: ReadonlyMap<string, RelationObservation[]>
): Evaluation {
  const targetFit = scope.fitBySeed.get(relationSeedId) ?? [];
  const targetHoldout = holdoutBySeed.get(relationSeedId) ?? [];
  const relationCounts = countsBySignature(targetFit);
  const alphabetSize = scope.signatureAlphabet.length;
  const baselineHeldoutNats = negativeLogLikelihood(targetHoldout, scope.backgroundCounts, alphabetSize);
  const relationHeldoutNats = negativeLogLikelihood(targetHoldout, relationCounts, alphabetSize);
  const relationModelNats = modelCodeNats(relationCounts, targetFit.length, alphabetSize);
  const recovery = recoveryProbabilities(scope, relationSeedId, targetHoldout);
  return {
    gainNats: quantize(baselineHeldoutNats - relationHeldoutNats - relationModelNats),
    baselineHeldoutNats,
    relationHeldoutNats,
    relationModelNats,
    baselineRecoveryProbability: recovery.baseline,
    relationRecoveryProbability: recovery.relation,
    recoveryGain: quantize(recovery.relation - recovery.baseline),
    independentSourceCount: new Set(targetFit.map(row => row.sourceFamilyId)).size
  };
}
/**
 * The three negative controls, judged against fit sets prepared once per channel plus one built per relation.
 *
 * Relabelling the fit, and re-signing it from source family alone, produce the same two sets for every relation in
 * a channel. Only the duplicate control depends on which relation is being judged, because it is that relation's
 * own first observation repeated -- the control that asks whether repetition inside one source can pass for
 * corroboration across several.
 */
function controlResults(relationSeedId: string, scope: ChannelScope): RelationPromotionControlResult[] {
  const first = scope.firstObservation.get(relationSeedId);
  // The same observation repeated. Nothing this control evaluates reads candidateId -- it reads the relation, the
  // signature and the source family, which are identical across the copies by construction -- so the copies share
  // one row rather than allocating one object each, which was an allocation per relation pair over the channel.
  const duplicate: RelationObservation[] = first
    ? new Array<RelationObservation>(Math.max(MIN_INDEPENDENT_SOURCES, scope.fit.length)).fill(first)
    : [];
  return [
    control("shuffled_relations", evaluateRelation(relationSeedId, scope.shuffled, scope.holdoutBySeed)),
    control("duplicate_only", evaluateRelation(
      relationSeedId,
      fitScope(duplicate, scope.relationSeedIds, scope.signatureAlphabet),
      scope.holdoutBySeed
    )),
    control("random_repetition", evaluateRelation(
      relationSeedId,
      scope.randomRepetition,
      scope.randomRepetitionHoldoutBySeed
    ))
  ];
}
function randomRepetitionSignature(sourceId: string, hasher: Hasher): string {
  const digest = hasher.digestHex(`relation-promotion-random-repetition\u001f${sourceId}`);
  return `random_control_signature.${Number.parseInt(digest.slice(0, 8), 16) % 3}`;
}

function relabel(
  observations: readonly RelationObservation[],
  relationSeedIds: readonly string[],
  select: (row: RelationObservation) => string
): RelationObservation[] {
  if (relationSeedIds.length < 2) return [];
  return observations.map(row => ({ ...row, relationSeedId: select(row) }));
}

function control(kind: RelationPromotionControlKind, evaluation: Evaluation): RelationPromotionControlResult {
  const promoted = evaluation.independentSourceCount >= MIN_INDEPENDENT_SOURCES
    && evaluation.gainNats > 0
    && evaluation.recoveryGain > 0;
  return {
    kind,
    gainNats: evaluation.gainNats,
    recoveryGain: evaluation.recoveryGain,
    independentSourceCount: evaluation.independentSourceCount,
    promoted
  };
}

/**
 * Posterior mass the correct relation keeps on its own held-out rows, against the prior it would keep by chance.
 *
 * The weight vector this normalises over is the same for every relation judged against one fit set: only which
 * entry is read out as "correct" changes. It used to be rebuilt per relation and per held-out row, which is why a
 * corpus-scale pass was out of reach. The denominator is now derived once per distinct signature, summed over the
 * relations in their stored order so the floating-point result is bit-identical to the per-relation form.
 */
function recoveryProbabilities(
  scope: FitScope,
  targetRelationSeedId: string,
  holdout: readonly RelationObservation[]
): { baseline: number; relation: number } {
  if (!holdout.length || !scope.fit.length || !scope.relationSeedIds.length) {
    return { baseline: 0, relation: 0 };
  }
  const prior = relationPrior(scope, targetRelationSeedId);
  const counts = relationSignatureCounts(scope, targetRelationSeedId);
  const alphabetSize = scope.signatureAlphabet.length;
  let baseline = 0;
  let relation = 0;
  for (const row of holdout) {
    const denominator = recoveryDenominator(scope, row.signature);
    const joint = prior === undefined || counts === undefined
      ? 0
      : prior * probability(row.signature, counts, alphabetSize);
    baseline += prior ?? 0;
    relation += denominator > 0 ? joint / denominator : 0;
  }
  return {
    baseline: quantize(baseline / holdout.length),
    relation: quantize(relation / holdout.length)
  };
}

/** The recovery posterior's normaliser for one signature: every relation's prior times its likelihood. Memoised. */
function recoveryDenominator(scope: FitScope, signature: string): number {
  const cached = scope.denominatorBySignature.get(signature);
  if (cached !== undefined) return cached;
  const alphabetSize = scope.signatureAlphabet.length;
  let sum = 0;
  for (const relationSeedId of scope.relationSeedIds) {
    sum += relationPrior(scope, relationSeedId)!
      * probability(signature, relationSignatureCounts(scope, relationSeedId)!, alphabetSize);
  }
  scope.denominatorBySignature.set(signature, sum);
  return sum;
}
function countsBySignature(observations: readonly RelationObservation[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of observations) counts.set(row.signature, (counts.get(row.signature) ?? 0) + 1);
  return counts;
}

function negativeLogLikelihood(
  observations: readonly RelationObservation[],
  counts: ReadonlyMap<string, number>,
  alphabetSize: number
): number {
  return quantize(observations.reduce((sum, row) =>
    sum - Math.log(probability(row.signature, counts, alphabetSize)), 0));
}

function probability(signature: string, counts: ReadonlyMap<string, number>, alphabetSize: number): number {
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const width = Math.max(1, alphabetSize);
  return ((counts.get(signature) ?? 0) + DIRICHLET_ALPHA)
    / (total + DIRICHLET_ALPHA * width);
}

function modelCodeNats(counts: ReadonlyMap<string, number>, sampleCount: number, alphabetSize: number): number {
  if (sampleCount <= 0) return 0;
  void counts;
  const categoricalDegreesOfFreedom = Math.max(0, alphabetSize - 1);
  const identityCode = Math.log1p(Math.max(1, alphabetSize));
  const parameterCode = 0.5 * categoricalDegreesOfFreedom * Math.log(Math.max(2, sampleCount));
  return quantize(identityCode + parameterCode);
}

function uniqueSourceFamilies(observations: readonly RelationObservation[], relationSeedId: string): string[] {
  return [...new Set(observations
    .filter(row => row.relationSeedId === relationSeedId)
    .map(row => row.sourceFamilyId))].sort();
}

function sourceFamilyFor(candidate: StructuredSemanticCandidate): string {
  const dependencyGroups = [...new Set(
    candidate.provenance.sourceIndependence.dependencyGroupIds.map(String)
  )].sort();
  if (dependencyGroups.length === 1) return dependencyGroups[0]!;
  if (dependencyGroups.length > 1) {
    return `dependency_set:${canonicalStringify(dependencyGroups)}`;
  }
  return `source:${String(candidate.sourceId)}`;
}

function quantize(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

/** A fit set with everything derived from it that does not depend on which relation is being judged. */
interface FitScope {
  fit: readonly RelationObservation[];
  fitBySeed: Map<string, RelationObservation[]>;
  backgroundCounts: Map<string, number>;
  relationSeedIds: readonly string[];
  relationSeedIdSet: ReadonlySet<string>;
  signatureAlphabet: readonly string[];
  priorDenominator: number;
  signatureCountsCache: Map<string, Map<string, number>>;
  denominatorBySignature: Map<string, number>;
}

interface ChannelScope {
  observations: RelationObservation[];
  fit: RelationObservation[];
  holdout: RelationObservation[];
  relationSeedIds: string[];
  signatureAlphabet: string[];
  actual: FitScope;
  shuffled: FitScope;
  randomRepetition: FitScope;
  holdoutBySeed: Map<string, RelationObservation[]>;
  randomRepetitionHoldoutBySeed: Map<string, RelationObservation[]>;
  observationSourceFamilies: Map<string, Set<string>>;
  fitSourceFamilies: Map<string, string[]>;
  holdoutSourceFamilies: Map<string, string[]>;
  firstObservation: Map<string, RelationObservation>;
}

interface ChannelBucket {
  observations: RelationObservation[];
  fit: RelationObservation[];
  holdout: RelationObservation[];
}

/** A fit set prepared once: grouped by relation, with each relation's prior and its signature counts. Pure. */
/** Every relation observes the same empty fit set, so they share one. Read-only by construction. */
const NO_SIGNATURE_COUNTS: ReadonlyMap<string, number> = new Map();

function fitScope(
  fit: readonly RelationObservation[],
  relationSeedIds: readonly string[],
  signatureAlphabet: readonly string[]
): FitScope {
  // Only relations this fit set actually contains get an entry. The duplicate-only control builds one fit set per
  // relation, so materialising a prior and an empty count map for every relation in the channel each time was an
  // allocation per relation pair -- quadratic in relations, and the largest single cost of the pass once the
  // per-relation rescans were gone. A relation absent from the fit set has a known prior and no counts.
  const fitBySeed = new Map<string, RelationObservation[]>();
  for (const row of fit) {
    const bucket = fitBySeed.get(row.relationSeedId);
    if (bucket) bucket.push(row);
    else fitBySeed.set(row.relationSeedId, [row]);
  }
  return {
    fit,
    fitBySeed,
    backgroundCounts: countsBySignature(fit),
    relationSeedIds,
    relationSeedIdSet: new Set(relationSeedIds),
    signatureAlphabet,
    priorDenominator: fit.length + DIRICHLET_ALPHA * relationSeedIds.length,
    signatureCountsCache: new Map(),
    denominatorBySignature: new Map()
  };
}

/** A relation's Dirichlet prior under this fit set, or undefined when the fit set does not range over it. Pure. */
function relationPrior(scope: FitScope, relationSeedId: string): number | undefined {
  if (!scope.relationSeedIdSet.has(relationSeedId)) return undefined;
  return ((scope.fitBySeed.get(relationSeedId)?.length ?? 0) + DIRICHLET_ALPHA) / scope.priorDenominator;
}

/** A relation's signature counts under this fit set, memoised. */
function relationSignatureCounts(scope: FitScope, relationSeedId: string): ReadonlyMap<string, number> | undefined {
  if (!scope.relationSeedIdSet.has(relationSeedId)) return undefined;
  const examples = scope.fitBySeed.get(relationSeedId);
  if (!examples) return NO_SIGNATURE_COUNTS;
  const cached = scope.signatureCountsCache.get(relationSeedId);
  if (cached) return cached;
  const counts = countsBySignature(examples);
  scope.signatureCountsCache.set(relationSeedId, counts);
  return counts;
}

/** Rows grouped by the relation they were observed for, in their original order. Pure. */
function groupBySeed(rows: readonly RelationObservation[]): Map<string, RelationObservation[]> {
  const grouped = new Map<string, RelationObservation[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.relationSeedId);
    if (bucket) bucket.push(row);
    else grouped.set(row.relationSeedId, [row]);
  }
  return grouped;
}

/** Each relation's source families, unique and sorted, from one pass over the rows. Pure. */
function sourceFamiliesBySeed(rows: readonly RelationObservation[]): Map<string, string[]> {
  const sets = new Map<string, Set<string>>();
  for (const row of rows) {
    const bucket = sets.get(row.relationSeedId);
    if (bucket) bucket.add(row.sourceFamilyId);
    else sets.set(row.relationSeedId, new Set([row.sourceFamilyId]));
  }
  return new Map([...sets].map(([relationSeedId, families]) => [relationSeedId, [...families].sort()]));
}

/**
 * The per-channel view every relation decision in that channel shares, built in one pass each.
 *
 * A decision needs six views of its channel, and three of the four control fit sets, and none of them depend on
 * which relation is being judged. Deriving them inside the decision loop rescanned the observation set for every
 * relation: measured on 16 corpus documents, 1,285 relations over 1,878 observations took 25s, and the cost grew
 * with the square of the corpus, which put a corpus-scale pass out of reach for the one channel that produces
 * relations in the thousands. Same arithmetic, computed once per channel.
 */
function channelScopes(
  observations: readonly RelationObservation[],
  fit: readonly RelationObservation[],
  holdout: readonly RelationObservation[],
  hasher: Hasher
): Map<SemanticCandidateChannel, ChannelScope> {
  const grouped = new Map<SemanticCandidateChannel, ChannelBucket>();
  const bucketFor = (channel: SemanticCandidateChannel): ChannelBucket => {
    const existing = grouped.get(channel);
    if (existing) return existing;
    const created: ChannelBucket = { observations: [], fit: [], holdout: [] };
    grouped.set(channel, created);
    return created;
  };
  for (const row of observations) bucketFor(row.channel).observations.push(row);
  for (const row of fit) bucketFor(row.channel).fit.push(row);
  for (const row of holdout) bucketFor(row.channel).holdout.push(row);

  const scopes = new Map<SemanticCandidateChannel, ChannelScope>();
  for (const [channel, bucket] of grouped) {
    const relationSeedIds = [...new Set(bucket.observations.map(row => row.relationSeedId))].sort();
    const signatureAlphabet = [...new Set(bucket.observations.map(row => row.signature))].sort();
    // indexOf per row is a scan of every relation for every observation, which is the shuffle control's own
    // quadratic. The position of each relation is fixed for the channel, so it is looked up once.
    const relationSeedIndex = new Map(relationSeedIds.map((id, index) => [id, index]));
    const shuffled = relabel(bucket.fit, relationSeedIds, row => {
      const current = relationSeedIndex.get(row.relationSeedId) ?? -1;
      return relationSeedIds[(current + 1) % Math.max(1, relationSeedIds.length)]!;
    });
    const randomRepetition = bucket.fit.map(row => ({
      ...row,
      signature: randomRepetitionSignature(row.sourceFamilyId, hasher)
    }));
    const randomRepetitionHoldout = bucket.holdout.map(row => ({
      ...row,
      signature: randomRepetitionSignature(row.sourceFamilyId, hasher)
    }));
    const randomRepetitionAlphabet = [...new Set([
      ...randomRepetition,
      ...randomRepetitionHoldout
    ].map(row => row.signature))].sort();
    const observationSourceFamilies = new Map<string, Set<string>>();
    const firstObservation = new Map<string, RelationObservation>();
    for (const row of bucket.observations) {
      const families = observationSourceFamilies.get(row.relationSeedId);
      if (families) families.add(row.sourceFamilyId);
      else observationSourceFamilies.set(row.relationSeedId, new Set([row.sourceFamilyId]));
      if (!firstObservation.has(row.relationSeedId)) firstObservation.set(row.relationSeedId, row);
    }
    scopes.set(channel, {
      observations: bucket.observations,
      fit: bucket.fit,
      holdout: bucket.holdout,
      relationSeedIds,
      signatureAlphabet,
      actual: fitScope(bucket.fit, relationSeedIds, signatureAlphabet),
      shuffled: fitScope(shuffled, relationSeedIds, signatureAlphabet),
      randomRepetition: fitScope(randomRepetition, relationSeedIds, randomRepetitionAlphabet),
      holdoutBySeed: groupBySeed(bucket.holdout),
      randomRepetitionHoldoutBySeed: groupBySeed(randomRepetitionHoldout),
      observationSourceFamilies,
      fitSourceFamilies: sourceFamiliesBySeed(bucket.fit),
      holdoutSourceFamilies: sourceFamiliesBySeed(bucket.holdout),
      firstObservation
    });
  }
  return scopes;
}
