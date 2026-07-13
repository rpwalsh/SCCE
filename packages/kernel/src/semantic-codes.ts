export const SEMANTIC_SOURCE = {
  CLAIM: "scce.src.001",
  EVIDENCE: "scce.src.002",
  GRAPH: "scce.src.003"
} as const;

export const SEMANTIC_MODALITY = {
  DERIVED: "scce.mod.001",
  POSSIBLE: "scce.mod.002",
  REQUIRED: "scce.mod.003",
  OBSERVED: "scce.mod.004",
  ASSERTED: "scce.mod.005"
} as const;

export const SEMANTIC_ROLE = {
  ENTITY: "scce.role.001",
  QUANTITY: "scce.role.002",
  SPAN: "scce.role.003"
} as const;

export const SEMANTIC_CONSTRAINT = {
  QUANTITY: "scce.constraint.001",
  TEMPORAL: "scce.constraint.002",
  MODALITY: "scce.constraint.003"
} as const;

export const SEMANTIC_SUBJECT = {
  TIME: "scce.subject.001",
  UTTERANCE: "scce.subject.002"
} as const;

export const SEMANTIC_OPERATOR = {
  EQ: "scce.op.001",
  NEQ: "scce.op.002",
  LT: "scce.op.003",
  LTE: "scce.op.004",
  GT: "scce.op.005",
  GTE: "scce.op.006",
  OVERLAPS: "scce.op.007",
  CONTAINS: "scce.op.008",
  BEFORE: "scce.op.009",
  AFTER: "scce.op.010",
  COMPATIBLE: "scce.op.011"
} as const;

export const SEMANTIC_TEMPORAL_GRANULARITY = {
  INSTANT: "scce.tg.001",
  DAY: "scce.tg.002",
  MONTH: "scce.tg.003",
  YEAR: "scce.tg.004",
  UNKNOWN: "scce.tg.999"
} as const;

export const SEMANTIC_VERDICT = {
  CONTRADICTED: "scce.verdict.001",
  ENTAILED: "scce.verdict.002",
  PARTIAL: "scce.verdict.003",
  UNDERDETERMINED: "scce.verdict.004"
} as const;

export const PROOF_RULE = {
  DIRECT: "scce.rule.001",
  CONSTRAINT: "scce.rule.002",
  OBLIGATION: "scce.rule.003",
  CONTRADICTION: "scce.rule.004",
  ALPHA: "scce.rule.005"
} as const;

export const PROOF_OBLIGATION_KIND = {
  PREDICATE: "scce.obligation.001",
  ROLE: "scce.obligation.002",
  CONSTRAINT: "scce.obligation.003",
  SOURCE: "scce.obligation.004"
} as const;

export const PROOF_COUNTEREXAMPLE_REASON = {
  POLARITY: "scce.counterexample.001",
  CONSTRAINT: "scce.counterexample.002",
  ALPHA_INCOMPATIBLE: "scce.counterexample.003"
} as const;

export const PROOF_GRAPH_KIND = {
  CLAIM_ATOM: "scce.pg.kind.001",
  EVIDENCE_ATOM: "scce.pg.kind.002",
  GRAPH_ATOM: "scce.pg.kind.003",
  OBLIGATION: "scce.pg.kind.004",
  COUNTEREXAMPLE: "scce.pg.kind.005",
  PROOF_STEP: "scce.pg.kind.006"
} as const;

export const PROOF_GRAPH_RELATION = {
  PREMISE: "scce.pg.rel.001",
  SUPPORTS: "scce.pg.rel.002",
  SCREENS: "scce.pg.rel.003",
  CONTRADICTS: "scce.pg.rel.004"
} as const;

