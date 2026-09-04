// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { JsonValue } from "./types.js";

export const RUNTIME_DEADLINE_SCHEMA = "scce.runtime_deadline.v1" as const;
export const RUNTIME_DEADLINE_DECISION_SCHEMA = "scce.runtime_deadline_decision.v1" as const;
export const DEFAULT_RUNTIME_RESPONSE_RESERVE_MS = 1_000;
/**
 * The production server (`packages/server/src/routes.ts`'s
 * `productionTurnDeadlineMetadata`) authors the real per-request deadline
 * under `metadata.runtime.initialResponseDeadline` with this schema, not
 * under `runtime.deadline`/`RUNTIME_DEADLINE_SCHEMA` -- confirmed the only
 * production writer of this metadata, and `runtime.deadline` is deliberately
 * treated as untrusted client input and stripped
 * (`turn-session-projection.test.ts` asserts `runtime` never carries a
 * `deadline` property after server processing). Plan item L7 found every
 * real `/api/turn` request was silently running with no deadline object at
 * all -- `executableRuntimeDeadlineFromMetadata` only ever recognized the
 * `runtime.deadline` shape, so it returned `undefined` for every production
 * request and all 16 `deadlineCheckpoint` call sites in
 * `production-turn-runtime.ts` were unconditionally admitted. Recognizing
 * this shape too (kept as a plain literal, not a cross-package import, since
 * `runtime-deadline.ts` is kernel-side and must not depend on the server
 * package) is what actually makes those checkpoints load-bearing in
 * production; `runtime.deadline` stays supported for direct kernel callers
 * (already covered by `runtime-deadline.test.ts`).
 */
export const PRODUCTION_INITIAL_VISIBLE_RESPONSE_SCHEMA = "scce.initial_visible_response.v1" as const;

export interface RuntimeDeadlineMetadata {
  readonly schema: typeof RUNTIME_DEADLINE_SCHEMA;
  readonly clock: "node.performance.v1";
  readonly budgetMs: number;
  readonly responseReserveMs: number;
  readonly startedMonotonicMs: number;
  readonly deadlineMonotonicMs: number;
  readonly computeDeadlineMonotonicMs: number;
  readonly propagatedAtMonotonicMs?: number;
  readonly remainingMs?: number;
}

export interface RuntimeDeadlineDecision {
  readonly schema: typeof RUNTIME_DEADLINE_DECISION_SCHEMA;
  readonly phase: string;
  readonly allowed: boolean;
  readonly observedAtMonotonicMs: number;
  readonly requiredMs: number;
  readonly remainingMs: number;
  readonly computeRemainingMs: number;
  readonly reason: "admitted" | "compute_reserve_exhausted" | "response_deadline_elapsed";
}

export interface ExecutableRuntimeDeadline {
  readonly metadata: RuntimeDeadlineMetadata;
  checkpoint(phase: string, requiredMs?: number): RuntimeDeadlineDecision;
  remainingMs(): number;
  computeRemainingMs(): number;
}

/**
 * Turns server-authored monotonic deadline metadata into an executable kernel
 * guard. The server removes request-authored deadline data before attaching
 * this record, so the kernel never extends its own budget from owner input.
 */
export function executableRuntimeDeadlineFromMetadata(
  metadata: JsonValue | undefined,
  now: () => number = () => performance.now()
): ExecutableRuntimeDeadline | undefined {
  const parsed = runtimeDeadlineMetadataFromJson(metadata);
  if (!parsed) return undefined;
  return {
    metadata: parsed,
    checkpoint(phase, requiredMs = 0) {
      const observedAtMonotonicMs = now();
      const boundedRequiredMs = Math.max(0, finiteNumber(requiredMs));
      const remainingMs = Math.max(0, parsed.deadlineMonotonicMs - observedAtMonotonicMs);
      const computeRemainingMs = Math.max(0, parsed.computeDeadlineMonotonicMs - observedAtMonotonicMs);
      const responseElapsed = observedAtMonotonicMs >= parsed.deadlineMonotonicMs;
      const allowed = !responseElapsed && boundedRequiredMs <= computeRemainingMs;
      return {
        schema: RUNTIME_DEADLINE_DECISION_SCHEMA,
        phase,
        allowed,
        observedAtMonotonicMs,
        requiredMs: boundedRequiredMs,
        remainingMs,
        computeRemainingMs,
        reason: responseElapsed
          ? "response_deadline_elapsed"
          : allowed
            ? "admitted"
            : "compute_reserve_exhausted"
      };
    },
    remainingMs() {
      return Math.max(0, parsed.deadlineMonotonicMs - now());
    },
    computeRemainingMs() {
      return Math.max(0, parsed.computeDeadlineMonotonicMs - now());
    }
  };
}

export function runtimeDeadlineMetadataFromJson(
  metadata: JsonValue | undefined
): RuntimeDeadlineMetadata | undefined {
  const root = jsonRecord(metadata);
  const runtime = jsonRecord(root.runtime);
  const directRow = jsonRecord(runtime.deadline);
  const productionRow = jsonRecord(runtime.initialResponseDeadline);
  const row = directRow.schema === RUNTIME_DEADLINE_SCHEMA ? directRow : productionRow;
  const validSchema = row === directRow
    ? row.schema === RUNTIME_DEADLINE_SCHEMA
    : row.schema === PRODUCTION_INITIAL_VISIBLE_RESPONSE_SCHEMA;
  if (
    !validSchema
    || row.clock !== "node.performance.v1"
  ) return undefined;
  const budgetMs = positiveFinite(row.budgetMs);
  const startedMonotonicMs = finiteOptional(row.startedMonotonicMs);
  const deadlineMonotonicMs = finiteOptional(row.deadlineMonotonicMs);
  if (
    budgetMs === undefined
    || startedMonotonicMs === undefined
    || deadlineMonotonicMs === undefined
    || deadlineMonotonicMs <= startedMonotonicMs
    || Math.abs((deadlineMonotonicMs - startedMonotonicMs) - budgetMs) > 1
  ) return undefined;
  const requestedReserve = nonNegativeFinite(row.responseReserveMs)
    ?? DEFAULT_RUNTIME_RESPONSE_RESERVE_MS;
  const responseReserveMs = Math.min(Math.max(0, requestedReserve), Math.max(0, budgetMs - 1));
  const maximumComputeDeadline = deadlineMonotonicMs - responseReserveMs;
  const requestedComputeDeadline = finiteOptional(row.computeDeadlineMonotonicMs);
  const computeDeadlineMonotonicMs = Math.min(
    maximumComputeDeadline,
    requestedComputeDeadline ?? maximumComputeDeadline
  );
  if (computeDeadlineMonotonicMs <= startedMonotonicMs) return undefined;
  const propagatedAtMonotonicMs = finiteOptional(row.propagatedAtMonotonicMs);
  const remainingMs = nonNegativeFinite(row.remainingMs);
  return {
    schema: RUNTIME_DEADLINE_SCHEMA,
    clock: "node.performance.v1",
    budgetMs,
    responseReserveMs,
    startedMonotonicMs,
    deadlineMonotonicMs,
    computeDeadlineMonotonicMs,
    ...(propagatedAtMonotonicMs === undefined ? {} : { propagatedAtMonotonicMs }),
    ...(remainingMs === undefined ? {} : { remainingMs })
  };
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}

function finiteOptional(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveFinite(value: JsonValue | undefined): number | undefined {
  const parsed = finiteOptional(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function nonNegativeFinite(value: JsonValue | undefined): number | undefined {
  const parsed = finiteOptional(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function finiteNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
