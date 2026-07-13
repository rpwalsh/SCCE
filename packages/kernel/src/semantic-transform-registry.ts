import type { JsonValue } from "./types.js";
import { clamp01, toJsonValue, weightedJaccard } from "./primitives.js";
import type { SemanticAtom, SemanticConstraint, SemanticRoleBinding } from "./semantic-proof-types.js";
import { SEMANTIC_MODALITY, SEMANTIC_OPERATOR } from "./semantic-codes.js";

export type SemanticTransformKind = string;

const T = {
  PRED_EQV: "tr:001",
  ROLE_MAP: "tr:002",
  Q_SUB: "tr:003",
  T_SCOPE: "tr:004",
  POL_INV: "tr:005",
  MOD_WEAK: "tr:006",
  C_PROJECT: "tr:007"
} as const;

export interface SemanticTransformRule {
  id: string;
  kind: SemanticTransformKind;
  labelKey: string;
  preconditions: string[];
  truthPreservation: number;
  supportWeight: number;
  contradictionWeight: number;
}

export interface SemanticTransformMatch {
  ruleId: string;
  kind: SemanticTransformKind;
  supportBoost: number;
  contradictionBoost: number;
  obligations: string[];
  explanation: string;
  audit: JsonValue;
}

export interface SemanticTransformEvaluation {
  supportBoost: number;
  contradictionBoost: number;
  transformIds: string[];
  obligations: string[];
  matches: SemanticTransformMatch[];
  audit: JsonValue;
}

const RULES: SemanticTransformRule[] = [
  {
    id: T.PRED_EQV,
    kind: T.PRED_EQV,
    labelKey: "scce.transform.001",
    preconditions: ["pc:001", "pc:002"],
    truthPreservation: 0.5,
    supportWeight: 0.08,
    contradictionWeight: 0
  },
  {
    id: T.ROLE_MAP,
    kind: T.ROLE_MAP,
    labelKey: "scce.transform.002",
    preconditions: ["pc:003", "pc:004"],
    truthPreservation: 0.5,
    supportWeight: 0.09,
    contradictionWeight: 0
  },
  {
    id: T.Q_SUB,
    kind: T.Q_SUB,
    labelKey: "scce.transform.003",
    preconditions: ["pc:005"],
    truthPreservation: 1,
    supportWeight: 0.1,
    contradictionWeight: 0.16
  },
  {
    id: T.T_SCOPE,
    kind: T.T_SCOPE,
    labelKey: "scce.transform.004",
    preconditions: ["pc:006"],
    truthPreservation: 0.5,
    supportWeight: 0.07,
    contradictionWeight: 0.12
  },
  {
    id: T.POL_INV,
    kind: T.POL_INV,
    labelKey: "scce.transform.005",
    preconditions: ["pc:007", "pc:008"],
    truthPreservation: 0,
    supportWeight: 0,
    contradictionWeight: 0.22
  },
  {
    id: T.MOD_WEAK,
    kind: T.MOD_WEAK,
    labelKey: "scce.transform.006",
    preconditions: ["pc:009"],
    truthPreservation: 0.5,
    supportWeight: 0.05,
    contradictionWeight: 0.06
  },
  {
    id: T.C_PROJECT,
    kind: T.C_PROJECT,
    labelKey: "scce.transform.007",
    preconditions: ["pc:010"],
    truthPreservation: 0.5,
    supportWeight: 0.06,
    contradictionWeight: 0.1
  }
];

export function semanticTransformRules(): readonly SemanticTransformRule[] {
  return RULES;
}

export function evaluateSemanticTransforms(input: {
  claim: SemanticAtom;
  evidence: SemanticAtom;
  predicateScore: number;
  roleScore: number;
  constraintScore: number;
  polarityScore: number;
}): SemanticTransformEvaluation {
  const matches: SemanticTransformMatch[] = [];
  const push = (rule: SemanticTransformRule, support: number, contradiction: number, explanation: string, obligations: string[] = [], audit: JsonValue = {}) => {
    const supportBoost = clamp01(support * rule.supportWeight);
    const contradictionBoost = clamp01(contradiction * rule.contradictionWeight);
    if (supportBoost <= 0 && contradictionBoost <= 0 && obligations.length === 0) return;
    matches.push({
      ruleId: rule.id,
      kind: rule.kind,
      supportBoost,
      contradictionBoost,
      obligations,
      explanation,
      audit
    });
  };

  const predicateRule = rule(T.PRED_EQV);
  const predicateFeatureOverlap = weightedJaccard(input.claim.predicateFeatures, input.evidence.predicateFeatures);
  if (predicateRule && input.polarityScore > 0 && predicateFeatureOverlap > 0.28) {
    push(predicateRule, predicateFeatureOverlap, 0, "ex:001", [], toJsonValue({ predicateFeatureOverlap }));
  }

  const roleRule = rule(T.ROLE_MAP);
  const roleFit = typedRoleFit(input.claim.roles, input.evidence.roles);
  if (roleRule && roleFit.score > 0.32) {
    push(roleRule, roleFit.score, 0, "ex:002", roleFit.unmapped.map(item => `obl:role:${item}`), toJsonValue(roleFit));
  }

  const quantityRule = rule(T.Q_SUB);
  const quantity = quantityCompatibility(input.claim.constraints, input.evidence.constraints);
  if (quantityRule && quantity.comparable) {
    push(quantityRule, quantity.support, quantity.contradiction, "ex:003", quantity.obligations, toJsonValue(quantity));
  }

  const temporalRule = rule(T.T_SCOPE);
  const temporal = temporalCompatibility(input.claim.constraints, input.evidence.constraints);
  if (temporalRule && temporal.comparable) {
    push(temporalRule, temporal.support, temporal.contradiction, "ex:004", temporal.obligations, toJsonValue(temporal));
  }

  const polarityRule = rule(T.POL_INV);
  if (polarityRule && input.polarityScore === 0 && input.predicateScore > 0.44 && input.roleScore > 0.34) {
    push(polarityRule, 0, clamp01(input.predicateScore * input.roleScore), "ex:005");
  }

  const modalityRule = rule(T.MOD_WEAK);
  const modality = modalityCompatibility(input.claim.modality, input.evidence.modality);
  if (modalityRule && modality.comparable) {
    push(modalityRule, modality.support, modality.contradiction, "ex:006", modality.obligations, toJsonValue(modality));
  }

  const projectionRule = rule(T.C_PROJECT);
  if (projectionRule && input.constraintScore > 0.35 && roleFit.score > 0.25) {
    push(projectionRule, input.constraintScore * roleFit.score, 0, "ex:007", roleFit.unmapped.map(item => `obl:cmap:${item}`));
  }

  const supportBoost = clamp01(matches.reduce((sum, item) => sum + item.supportBoost, 0));
  const contradictionBoost = clamp01(matches.reduce((sum, item) => sum + item.contradictionBoost, 0));
  const transformIds = matches.map(item => item.ruleId);
  const obligations = [...new Set(matches.flatMap(item => item.obligations))];
  return {
    supportBoost,
    contradictionBoost,
    transformIds,
    obligations,
    matches,
    audit: toJsonValue({
      supportBoost,
      contradictionBoost,
      transformIds,
      obligations,
      matches: matches.map(item => ({ ruleId: item.ruleId, kind: item.kind, supportBoost: item.supportBoost, contradictionBoost: item.contradictionBoost, explanation: item.explanation }))
    })
  };
}

function rule(kind: SemanticTransformKind): SemanticTransformRule | undefined {
  return RULES.find(item => item.kind === kind);
}

function typedRoleFit(left: readonly SemanticRoleBinding[], right: readonly SemanticRoleBinding[]): { score: number; mapped: Array<{ left: string; right: string; score: number }>; unmapped: string[] } {
  if (!left.length || !right.length) return { score: 0, mapped: [], unmapped: left.map(item => item.name) };
  const mapped: Array<{ left: string; right: string; score: number }> = [];
  const unmapped: string[] = [];
  const used = new Set<number>();
  for (const l of left) {
    let bestIndex = -1;
    let bestScore = 0;
    for (let i = 0; i < right.length; i++) {
      if (used.has(i)) continue;
      const r = right[i]!;
      const type = l.type === r.type ? 0.36 : 0;
      const name = l.name === r.name ? 0.2 : 0;
      const value = l.normalized === r.normalized ? 0.28 : 0;
      const features = weightedJaccard(l.features, r.features) * 0.16;
      const score = clamp01(type + name + value + features);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0 && bestScore > 0.18) {
      used.add(bestIndex);
      mapped.push({ left: l.name, right: right[bestIndex]!.name, score: bestScore });
    } else {
      unmapped.push(l.name);
    }
  }
  return { score: mapped.length ? mean(mapped.map(item => item.score)) : 0, mapped, unmapped };
}

function quantityCompatibility(left: readonly SemanticConstraint[], right: readonly SemanticConstraint[]): { comparable: boolean; support: number; contradiction: number; obligations: string[] } {
  const lq = left.filter(isNumericConstraint);
  const rq = right.filter(isNumericConstraint);
  if (!lq.length || !rq.length) return { comparable: false, support: 0, contradiction: 0, obligations: [] };
  let support = 0;
  let contradiction = 0;
  const obligations: string[] = [];
  for (const claim of lq) {
    const best = rq.map(evidence => compareNumericConstraint(claim, evidence)).sort((a, b) => b.support - a.support)[0];
    if (!best) continue;
    support = Math.max(support, best.support);
    contradiction = Math.max(contradiction, best.contradiction);
    if (best.support < 0.45) obligations.push(`obl:q:${claim.subject}`);
  }
  return { comparable: true, support, contradiction, obligations };
}

function temporalCompatibility(left: readonly SemanticConstraint[], right: readonly SemanticConstraint[]): { comparable: boolean; support: number; contradiction: number; obligations: string[] } {
  const lt = left.filter(isTemporalConstraint);
  const rt = right.filter(isTemporalConstraint);
  if (!lt.length || !rt.length) return { comparable: false, support: 0, contradiction: 0, obligations: [] };
  const obligations: string[] = [];
  let support = 0;
  let contradiction = 0;
  for (const claim of lt) {
    const best = rt.map(evidence => compareTemporalConstraint(claim, evidence)).sort((a, b) => b.support - a.support)[0];
    if (!best) continue;
    support = Math.max(support, best.support);
    contradiction = Math.max(contradiction, best.contradiction);
    if (best.support < 0.35) obligations.push(`obl:t:${claim.subject}`);
  }
  return { comparable: true, support, contradiction, obligations };
}

function isNumericConstraint(item: SemanticConstraint): boolean {
  return numericValue(item.value) !== undefined;
}

function isTemporalConstraint(item: SemanticConstraint): boolean {
  return temporalNumber(item.value) !== undefined;
}

function modalityCompatibility(claim: SemanticAtom["modality"], evidence: SemanticAtom["modality"]): { comparable: boolean; support: number; contradiction: number; obligations: string[] } {
  const rank: Record<SemanticAtom["modality"], number> = {
    [SEMANTIC_MODALITY.POSSIBLE]: 1,
    [SEMANTIC_MODALITY.DERIVED]: 2,
    [SEMANTIC_MODALITY.OBSERVED]: 3,
    [SEMANTIC_MODALITY.ASSERTED]: 4,
    [SEMANTIC_MODALITY.REQUIRED]: 5
  };
  const c = rank[claim];
  const e = rank[evidence];
  if (!c || !e) return { comparable: false, support: 0, contradiction: 0, obligations: [] };
  if (e >= c) return { comparable: true, support: 1, contradiction: 0, obligations: [] };
  return { comparable: true, support: e / c, contradiction: clamp01((c - e) / 5), obligations: [`obl:mod:${claim}:${evidence}`] };
}

function compareNumericConstraint(left: SemanticConstraint, right: SemanticConstraint): { support: number; contradiction: number } {
  const l = numericValue(left.value);
  const r = numericValue(right.value);
  if (l === undefined || r === undefined) return { support: 0.2, contradiction: 0 };
  const distance = Math.abs(l - r);
  const scale = Math.max(1, Math.abs(l), Math.abs(r));
  const closeness = clamp01(1 - distance / scale);
  if (left.operator === SEMANTIC_OPERATOR.EQ) return { support: closeness, contradiction: closeness < 0.4 ? 0.5 : 0 };
  if (left.operator === SEMANTIC_OPERATOR.LT || left.operator === SEMANTIC_OPERATOR.LTE) return { support: r <= l ? 0.85 : 0.25, contradiction: r > l ? 0.45 : 0 };
  if (left.operator === SEMANTIC_OPERATOR.GT || left.operator === SEMANTIC_OPERATOR.GTE) return { support: r >= l ? 0.85 : 0.25, contradiction: r < l ? 0.45 : 0 };
  return { support: closeness, contradiction: 0 };
}

function compareTemporalConstraint(left: SemanticConstraint, right: SemanticConstraint): { support: number; contradiction: number } {
  const l = temporalNumber(left.value);
  const r = temporalNumber(right.value);
  if (l === undefined || r === undefined) return { support: 0.2, contradiction: 0 };
  const distance = Math.abs(l - r);
  const days = distance / 86400000;
  const support = clamp01(1 - days / 365);
  return { support, contradiction: support < 0.25 ? 0.35 : 0 };
}

function numericValue(value: JsonValue): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = Number(value.replace(/[^0-9.+-]/gu, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, JsonValue>;
    return numericValue(record.value ?? record.lower ?? record.upper ?? null);
  }
  return undefined;
}

function temporalNumber(value: JsonValue): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : undefined;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, JsonValue>;
    return temporalNumber(record.instant ?? record.lower ?? record.upper ?? null);
  }
  return undefined;
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}
