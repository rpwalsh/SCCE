import { canonicalStringify, createHasher, toJsonValue } from "./primitives.js";
import type { RelationPromotionModel } from "./relation-promotion.js";
import type { StructuredSemanticCandidate } from "./structured-semantic-candidate.js";
import type { Hasher, JsonValue } from "./types.js";

export const OPAQUE_ROLE_MODEL_SCHEMA = "scce.opaque_role_model.v1" as const;

export interface OpaqueRoleCluster {
  id: string;
  relationSeedId: string;
  featureProbabilities: Array<{ feature: string; probability: number }>;
  fitOccurrenceIds: string[];
  independentSourceCount: number;
}

export interface OpaqueRoleAssignment {
  occurrenceId: string;
  candidateId: string;
  provisionalPortId: string;
  roleId: string;
  posterior: Array<{ roleId: string; probability: number }>;
}

export interface OpaqueRoleRelationSelection {
  relationSeedId: string;
  selectedClusterCount: number;
  baselineDescriptionNats: number;
  selectedDescriptionNats: number;
  mdlGainNats: number;
  fitSourceIds: string[];
  holdoutSourceIds: string[];
}

export interface OpaqueRoleModel {
  schema: typeof OPAQUE_ROLE_MODEL_SCHEMA;
  id: string;
  promotionModelId: string;
  clusters: OpaqueRoleCluster[];
  assignments: OpaqueRoleAssignment[];
  selections: OpaqueRoleRelationSelection[];
  audit: JsonValue;
}

interface RoleOccurrence {
  id: string;
  candidateId: string;
  provisionalPortId: string;
  relationSeedId: string;
  sourceId: string;
  features: string[];
}

interface FittedCandidate {
  k: number;
  medoids: RoleOccurrence[];
  groups: RoleOccurrence[][];
  heldoutDataNats: number;
  modelNats: number;
  descriptionNats: number;
  collapsed: boolean;
}

const FEATURE_ALPHA = 0.5;
const MIN_SOURCES_PER_ROLE = 2;

export function compileOpaqueRoleModel(input: {
  candidates: readonly StructuredSemanticCandidate[];
  promotionModel: RelationPromotionModel;
  hasher?: Hasher;
  maxRolesPerRelation?: number;
}): OpaqueRoleModel {
  const hasher = input.hasher ?? createHasher();
  const promotedSeeds = new Set(input.promotionModel.decisions
    .filter(decision => decision.promoted)
    .map(decision => decision.relationSeedId));
  const occurrences = roleOccurrences(input.candidates
    .filter(candidate => promotedSeeds.has(candidate.relationSeedId)));
  const clusters: OpaqueRoleCluster[] = [];
  const selections: OpaqueRoleRelationSelection[] = [];
  const selectedByRelation = new Map<string, OpaqueRoleCluster[]>();
  for (const relationSeedId of [...new Set(occurrences.map(row => row.relationSeedId))].sort()) {
    const relationOccurrences = occurrences.filter(row => row.relationSeedId === relationSeedId);
    const sourceIds = [...new Set(relationOccurrences.map(row => row.sourceId))].sort();
    const split = sourceSplit(sourceIds, hasher, relationSeedId);
    const fit = relationOccurrences.filter(row => split.fit.has(row.sourceId));
    const holdout = relationOccurrences.filter(row => split.holdout.has(row.sourceId));
    const uniqueFeatureSignatures = new Set(fit.map(row => canonicalStringify(row.features))).size;
    const maxK = Math.max(1, Math.min(
      input.maxRolesPerRelation ?? 12,
      uniqueFeatureSignatures,
      Math.floor(new Set(fit.map(row => row.sourceId)).size / MIN_SOURCES_PER_ROLE)
    ));
    const candidates = Array.from({ length: maxK }, (_, index) =>
      fitCandidate({ fit, holdout, k: index + 1 }));
    const baseline = candidates[0] ?? emptyFit();
    const selected = candidates
      .filter(candidate => !candidate.collapsed)
      .sort((left, right) =>
        left.descriptionNats - right.descriptionNats || left.k - right.k)[0] ?? baseline;
    const relationClusters = selected.groups.map((group, index) => {
      const probabilities = featureProbabilities(group);
      const identityMaterial = {
        relationSeedId,
        probabilities: probabilities.filter(row => row.probability >= 0.5)
      };
      return {
        id: `role.${hasher.digestHex(canonicalStringify(identityMaterial)).slice(0, 32)}`,
        relationSeedId,
        featureProbabilities: probabilities,
        fitOccurrenceIds: group.map(row => row.id).sort(),
        independentSourceCount: new Set(group.map(row => row.sourceId)).size
      };
    });
    clusters.push(...relationClusters);
    selectedByRelation.set(relationSeedId, relationClusters);
    selections.push({
      relationSeedId,
      selectedClusterCount: relationClusters.length,
      baselineDescriptionNats: baseline.descriptionNats,
      selectedDescriptionNats: selected.descriptionNats,
      mdlGainNats: quantize(baseline.descriptionNats - selected.descriptionNats),
      fitSourceIds: [...split.fit].sort(),
      holdoutSourceIds: [...split.holdout].sort()
    });
  }
  const assignments = occurrences.map(occurrence => {
    const relationClusters = selectedByRelation.get(occurrence.relationSeedId) ?? [];
    const scores = relationClusters.map(cluster => ({
      roleId: cluster.id,
      logWeight: roleLogLikelihood(occurrence.features, cluster.featureProbabilities)
        + Math.log(Math.max(1e-12, cluster.fitOccurrenceIds.length))
    }));
    const logZ = logSumExp(scores.map(row => row.logWeight));
    const posterior = scores.map(row => ({
      roleId: row.roleId,
      probability: quantize(Math.exp(row.logWeight - logZ))
    })).sort((left, right) =>
      right.probability - left.probability || left.roleId.localeCompare(right.roleId));
    return {
      occurrenceId: occurrence.id,
      candidateId: occurrence.candidateId,
      provisionalPortId: occurrence.provisionalPortId,
      roleId: posterior[0]?.roleId ?? `role.unresolved.${hasher.digestHex(occurrence.id).slice(0, 24)}`,
      posterior
    };
  });
  const canonical = {
    schema: OPAQUE_ROLE_MODEL_SCHEMA,
    promotionModelId: input.promotionModel.id,
    clusters,
    assignments,
    selections
  };
  return {
    ...canonical,
    id: `opaque_role_model.${hasher.digestHex(canonicalStringify(canonical)).slice(0, 40)}`,
    audit: toJsonValue({
      learner: "kernel.opaque_role_induction.source_disjoint_mdl.v1",
      positionalIdentityUsed: false,
      runtimeLanguageLabelsUsed: false,
      featureFamilies: [
        "surface_distribution",
        "graph_neighborhood",
        "substitution_behavior",
        "transformation_behavior",
        "discourse_behavior"
      ],
      occurrenceCount: occurrences.length,
      relationCount: selections.length,
      clusterCount: clusters.length
    })
  };
}

export function opaqueRoleId(
  model: OpaqueRoleModel | undefined,
  candidateId: string,
  provisionalPortId: string
): string | undefined {
  return model?.assignments.find(assignment =>
    assignment.candidateId === candidateId
    && assignment.provisionalPortId === provisionalPortId)?.roleId;
}

function roleOccurrences(candidates: readonly StructuredSemanticCandidate[]): RoleOccurrence[] {
  const out: RoleOccurrence[] = [];
  for (const candidate of candidates) {
    const neighborKinds = candidate.participants.map(port => port.valueKind).sort();
    const qualifierKeys = jsonKeys(candidate.qualifiers);
    const sameKindCounts = new Map<string, number>();
    for (const participant of candidate.participants) {
      sameKindCounts.set(participant.valueKind, (sameKindCounts.get(participant.valueKind) ?? 0) + 1);
    }
    for (const participant of candidate.participants) {
      const surfaceShape = valueShape(participant.value);
      const features = [
        `surface.kind:${participant.valueKind}`,
        `surface.shape:${surfaceShape}`,
        `graph.arity:${candidate.participants.length}`,
        ...neighborKinds.map(kind => `graph.neighbor:${kind}`),
        `substitution.kind_mass:${sameKindCounts.get(participant.valueKind) ?? 0}`,
        `transformation.family:${transformationFamily(participant.value)}`,
        `discourse.candidate:${candidate.kind}`,
        ...qualifierKeys.map(key => `discourse.qualifier:${key}`),
        `realization:${participant.realization}`
      ].sort();
      out.push({
        id: `${candidate.id}\u001f${participant.portId}`,
        candidateId: candidate.id,
        provisionalPortId: participant.portId,
        relationSeedId: candidate.relationSeedId,
        sourceId: String(candidate.sourceId),
        features
      });
    }
  }
  return out.sort((left, right) => left.id.localeCompare(right.id));
}

function fitCandidate(input: {
  fit: readonly RoleOccurrence[];
  holdout: readonly RoleOccurrence[];
  k: number;
}): FittedCandidate {
  if (!input.fit.length || input.k < 1) return emptyFit();
  let medoids = initialMedoids(input.fit, input.k);
  let groups: RoleOccurrence[][] = [];
  for (let iteration = 0; iteration < 16; iteration += 1) {
    groups = assignToMedoids(input.fit, medoids);
    if (groups.some(group => new Set(group.map(row => row.sourceId)).size < MIN_SOURCES_PER_ROLE)) {
      return { ...emptyFit(), k: input.k, collapsed: true };
    }
    const next = groups.map(group => medoid(group));
    if (next.every((row, index) => row.id === medoids[index]?.id)) break;
    medoids = next;
  }
  groups = assignToMedoids(input.fit, medoids);
  const models = groups.map(featureProbabilities);
  const priors = groups.map(group => group.length / input.fit.length);
  const heldoutDataNats = quantize(input.holdout.reduce((sum, occurrence) =>
    sum - logSumExp(models.map((model, index) =>
      Math.log(Math.max(1e-12, priors[index] ?? 0))
      + roleLogLikelihood(occurrence.features, model))), 0));
  const featureAlphabet = new Set(input.fit.flatMap(row => row.features)).size;
  const parameterCount = input.k * featureAlphabet + Math.max(0, input.k - 1);
  const modelNats = quantize(0.5 * parameterCount * Math.log(Math.max(2, input.fit.length)));
  return {
    k: input.k,
    medoids,
    groups,
    heldoutDataNats,
    modelNats,
    descriptionNats: quantize(heldoutDataNats + modelNats),
    collapsed: false
  };
}

function initialMedoids(rows: readonly RoleOccurrence[], k: number): RoleOccurrence[] {
  const unique = [...new Map(rows.map(row => [canonicalStringify(row.features), row])).values()];
  const medoids: RoleOccurrence[] = [unique[0]!];
  while (medoids.length < Math.min(k, unique.length)) {
    const next = unique
      .filter(row => !medoids.some(medoidRow => medoidRow.id === row.id))
      .map(row => ({
        row,
        distance: Math.min(...medoids.map(item => 1 - jaccard(row.features, item.features)))
      }))
      .sort((left, right) =>
        right.distance - left.distance || left.row.id.localeCompare(right.row.id))[0]?.row;
    if (!next) break;
    medoids.push(next);
  }
  return medoids;
}

function assignToMedoids(rows: readonly RoleOccurrence[], medoids: readonly RoleOccurrence[]): RoleOccurrence[][] {
  const groups = medoids.map(() => [] as RoleOccurrence[]);
  for (const row of rows) {
    const selected = medoids.map((candidate, index) => ({
      index,
      similarity: jaccard(row.features, candidate.features)
    })).sort((left, right) =>
      right.similarity - left.similarity || left.index - right.index)[0]?.index ?? 0;
    groups[selected]!.push(row);
  }
  return groups;
}

function medoid(rows: readonly RoleOccurrence[]): RoleOccurrence {
  return [...rows].sort((left, right) =>
    rows.reduce((sum, row) => sum + jaccard(right.features, row.features), 0)
    - rows.reduce((sum, row) => sum + jaccard(left.features, row.features), 0)
    || left.id.localeCompare(right.id))[0]!;
}

function featureProbabilities(rows: readonly RoleOccurrence[]): Array<{ feature: string; probability: number }> {
  const features = [...new Set(rows.flatMap(row => row.features))].sort();
  return features.map(feature => ({
    feature,
    probability: quantize((rows.filter(row => row.features.includes(feature)).length + FEATURE_ALPHA)
      / (rows.length + 2 * FEATURE_ALPHA))
  }));
}

function roleLogLikelihood(
  features: readonly string[],
  model: readonly { feature: string; probability: number }[]
): number {
  const active = new Set(features);
  return model.reduce((sum, row) => {
    const p = Math.max(1e-12, Math.min(1 - 1e-12, row.probability));
    return sum + Math.log(active.has(row.feature) ? p : 1 - p);
  }, 0);
}

function sourceSplit(sourceIds: readonly string[], hasher: Hasher, relationSeedId: string): {
  fit: Set<string>;
  holdout: Set<string>;
} {
  if (sourceIds.length < 4) return { fit: new Set(sourceIds), holdout: new Set() };
  const ranked = sourceIds.map(sourceId => ({
    sourceId,
    rank: hasher.digestHex(`opaque-role-holdout\u001f${relationSeedId}\u001f${sourceId}`)
  })).sort((left, right) => left.rank.localeCompare(right.rank) || left.sourceId.localeCompare(right.sourceId));
  const holdout = new Set(ranked.slice(0, Math.max(1, Math.floor(sourceIds.length / 4))).map(row => row.sourceId));
  return { fit: new Set(sourceIds.filter(sourceId => !holdout.has(sourceId))), holdout };
}

function valueShape(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value !== "string") return typeof value;
  return [...value.normalize("NFC")].slice(0, 64).map(symbol => {
    if (/\p{Letter}/u.test(symbol)) return "L";
    if (/\p{Number}/u.test(symbol)) return "N";
    if (/\p{Mark}/u.test(symbol)) return "M";
    if (/\p{Separator}/u.test(symbol)) return "S";
    if (/\p{Punctuation}/u.test(symbol)) return "P";
    return "X";
  }).join("").replace(/(.)\1{2,}/gu, "$1$1");
}

function transformationFamily(value: JsonValue): string {
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "real";
  if (typeof value === "boolean") return "boolean";
  if (value === null) return "unrealized";
  if (Array.isArray(value)) return "sequence";
  if (typeof value === "object") return "record";
  const normalized = value.normalize("NFC");
  if (normalized !== value) return "unicode_normalized";
  if (normalized.toLocaleLowerCase() !== normalized && normalized.toLocaleUpperCase() !== normalized) return "case_variable";
  return "surface_identity";
}

function jsonKeys(value: JsonValue, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).sort().flatMap(key => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [path, ...jsonKeys(value[key]!, path)];
  });
}

function jaccard(left: readonly string[], right: readonly string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  if (!a.size && !b.size) return 1;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / Math.max(1, a.size + b.size - intersection);
}

function logSumExp(values: readonly number[]): number {
  if (!values.length) return Number.NEGATIVE_INFINITY;
  const max = Math.max(...values);
  return max + Math.log(values.reduce((sum, value) => sum + Math.exp(value - max), 0));
}

function emptyFit(): FittedCandidate {
  return {
    k: 1,
    medoids: [],
    groups: [],
    heldoutDataNats: 0,
    modelNats: 0,
    descriptionNats: 0,
    collapsed: false
  };
}

function quantize(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}
