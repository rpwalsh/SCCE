export type ScoreKind =
  | "feature"
  | "guard"
  | "fallback"
  | "estimator"
  | "calibrated_probability"
  | "algebraic_invariant"
  | "provisional_heuristic";

export interface ScoreTrace {
  id: string;
  kind: ScoreKind;
  value: number;
  range: readonly [number, number];
  meaning: string;
  inputs: readonly string[];
  provenance: readonly string[];
  calibrated: boolean;
  calibrationId?: string;
  failureModes: readonly string[];
}

export interface ScoreTraceInput {
  kind: ScoreKind;
  value: number;
  range: readonly [number, number];
  meaning: string;
  inputs: readonly string[];
  provenance: readonly string[];
  calibrated?: boolean;
  calibrationId?: string;
  failureModes?: readonly string[];
  idSeed?: string;
}

export function createScoreTrace(input: ScoreTraceInput): ScoreTrace {
  const trace: ScoreTrace = {
    id: scoreTraceId(input.kind, input.idSeed ?? `${input.meaning}|${input.inputs.join("|")}|${input.provenance.join("|")}`),
    kind: input.kind,
    value: input.value,
    range: input.range,
    meaning: input.meaning,
    inputs: input.inputs,
    provenance: input.provenance,
    calibrated: input.calibrated ?? false,
    calibrationId: input.calibrationId,
    failureModes: input.failureModes ?? []
  };
  validateScoreTrace(trace);
  return trace;
}

export function validateScoreTrace(trace: ScoreTrace): void {
  const [min, max] = trace.range;
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
    throw new Error(`Invalid ScoreTrace range for ${trace.id}: [${min}, ${max}]`);
  }
  if (!Number.isFinite(trace.value) || trace.value < min || trace.value > max) {
    throw new Error(`ScoreTrace value out of range for ${trace.id}: ${trace.value}`);
  }
  if (trace.kind === "calibrated_probability") {
    if (!trace.calibrated) throw new Error(`calibrated_probability must set calibrated=true (${trace.id})`);
    if (!trace.calibrationId) throw new Error(`calibrated_probability must include calibrationId (${trace.id})`);
  }
  if (trace.kind === "provisional_heuristic" && trace.failureModes.length === 0) {
    throw new Error(`provisional_heuristic must include failure modes (${trace.id})`);
  }
}

export function featureScore(input: Omit<ScoreTraceInput, "kind">): ScoreTrace {
  return createScoreTrace({ ...input, kind: "feature", calibrated: false, failureModes: input.failureModes ?? [] });
}

export function guardScore(input: Omit<ScoreTraceInput, "kind">): ScoreTrace {
  return createScoreTrace({ ...input, kind: "guard", calibrated: false, failureModes: input.failureModes ?? [] });
}

export function fallbackScore(input: Omit<ScoreTraceInput, "kind">): ScoreTrace {
  return createScoreTrace({ ...input, kind: "fallback", calibrated: false, failureModes: input.failureModes ?? [] });
}

export function estimatorScore(input: Omit<ScoreTraceInput, "kind">): ScoreTrace {
  return createScoreTrace({ ...input, kind: "estimator", calibrated: false, failureModes: input.failureModes ?? [] });
}

export function calibratedScore(input: Omit<ScoreTraceInput, "kind" | "calibrated">): ScoreTrace {
  return createScoreTrace({ ...input, kind: "calibrated_probability", calibrated: true });
}

export function invariantScore(input: Omit<ScoreTraceInput, "kind">): ScoreTrace {
  return createScoreTrace({ ...input, kind: "algebraic_invariant", calibrated: false, failureModes: input.failureModes ?? [] });
}

export function provisionalHeuristicScore(input: Omit<ScoreTraceInput, "kind">): ScoreTrace {
  return createScoreTrace({ ...input, kind: "provisional_heuristic", calibrated: false });
}

export function scoreTraceId(kind: ScoreKind, seed: string): string {
  return `score:${kind}:${hash32(seed).toString(16)}`;
}

function hash32(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}