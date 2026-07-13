import type { JsonValue } from "./types.js";

/** Durable states for one immutable brain import run. */
export const BRAIN_LIFECYCLE_STATES = [
  "CREATED",
  "IMPORTING",
  "VALIDATING",
  "READY",
  "ACTIVE",
  "STOPPED",
  "FAILED",
  "QUARANTINED",
  "INCOMPATIBLE"
] as const;

export type BrainLifecycleState = (typeof BRAIN_LIFECYCLE_STATES)[number];

/**
 * The transitions are deliberately closed. ACTIVE -> READY is the atomic
 * replacement path: a still-valid previous brain becomes an inactive rollback
 * candidate when a new READY brain is activated.
 */
const BRAIN_LIFECYCLE_TRANSITIONS: Readonly<Record<BrainLifecycleState, readonly BrainLifecycleState[]>> = {
  CREATED: ["IMPORTING", "FAILED", "QUARANTINED", "INCOMPATIBLE"],
  IMPORTING: ["VALIDATING", "STOPPED", "FAILED", "QUARANTINED", "INCOMPATIBLE"],
  VALIDATING: ["READY", "FAILED", "QUARANTINED", "INCOMPATIBLE"],
  READY: ["ACTIVE", "QUARANTINED", "INCOMPATIBLE"],
  ACTIVE: ["READY", "STOPPED", "QUARANTINED", "INCOMPATIBLE"],
  STOPPED: ["IMPORTING", "QUARANTINED", "INCOMPATIBLE"],
  FAILED: ["IMPORTING", "QUARANTINED", "INCOMPATIBLE"],
  QUARANTINED: ["VALIDATING", "INCOMPATIBLE"],
  INCOMPATIBLE: []
};

export interface BrainManifestContract {
  schema: "scce.brainManifestContract.v1";
  importRunId: string;
  brainVersion: string;
  rootPath: string;
  manifestHash: string;
  sourceId?: string;
  sourceSchema: string;
  runtimeContractVersion: 1;
  content: {
    graphShardCount: number;
    languageShardCount: number;
    ngramStateCount: number;
    priorSectionCount: number;
  };
  metadata: JsonValue;
  createdAt: number;
}

export interface BrainValidationCheck {
  id: string;
  passed: boolean;
  severity: "error" | "warning";
  message: string;
  details?: JsonValue;
}

export interface BrainValidationReport {
  schema: "scce.brainValidationReport.v1";
  importRunId: string;
  brainVersion: string;
  manifestHash: string;
  validatorVersion: string;
  disposition: "PASSED" | "FAILED" | "QUARANTINED" | "INCOMPATIBLE";
  checks: BrainValidationCheck[];
  validatedAt: number;
}

export interface BrainLifecycleRecord {
  importRunId: string;
  brainVersion: string;
  rootPath: string;
  state: BrainLifecycleState;
  manifest: BrainManifestContract;
  validation?: BrainValidationReport;
  reason?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface BrainLifecycleTransition {
  importRunId: string;
  expectedState: BrainLifecycleState;
  toState: BrainLifecycleState;
  updatedAt: number;
  reason?: string;
  validation?: BrainValidationReport;
}

export function isBrainLifecycleState(value: unknown): value is BrainLifecycleState {
  return typeof value === "string" && (BRAIN_LIFECYCLE_STATES as readonly string[]).includes(value);
}

export function canTransitionBrainLifecycle(from: BrainLifecycleState, to: BrainLifecycleState): boolean {
  return BRAIN_LIFECYCLE_TRANSITIONS[from].includes(to);
}

export function assertBrainLifecycleTransition(from: BrainLifecycleState, to: BrainLifecycleState): void {
  if (!canTransitionBrainLifecycle(from, to)) throw new Error(`invalid brain lifecycle transition ${from} -> ${to}`);
}

/**
 * Generic compare-and-set transitions may advance an import toward READY, but
 * ACTIVE is owned by the storage adapter's atomic activation transaction. This
 * prevents callers from bypassing marker replacement and single-ACTIVE repair.
 */
export function assertGenericBrainLifecycleTransition(from: BrainLifecycleState, to: BrainLifecycleState): void {
  if (from === "ACTIVE" || to === "ACTIVE") {
    throw new Error(`brain lifecycle ACTIVE transition ${from} -> ${to} requires activateReady`);
  }
  assertBrainLifecycleTransition(from, to);
}

export function validateBrainManifestContract(manifest: BrainManifestContract): BrainValidationCheck[] {
  const checks: BrainValidationCheck[] = [
    { id: "manifest.schema", passed: manifest.schema === "scce.brainManifestContract.v1", severity: "error", message: "manifest contract schema is supported" },
    { id: "manifest.runtime_contract", passed: manifest.runtimeContractVersion === 1, severity: "error", message: "runtime contract version is compatible" },
    { id: "manifest.import_run", passed: manifest.importRunId.length > 0, severity: "error", message: "import run identity is present" },
    { id: "manifest.brain_version", passed: manifest.brainVersion.length > 0, severity: "error", message: "brain version identity is present" },
    { id: "manifest.hash", passed: /^[a-f0-9]{64}$/iu.test(manifest.manifestHash), severity: "error", message: "manifest has a SHA-256 identity" },
    { id: "manifest.root", passed: manifest.rootPath.length > 0, severity: "error", message: "manifest root path is present" }
  ];
  for (const [key, count] of Object.entries(manifest.content)) {
    checks.push({ id: `manifest.content.${key}`, passed: Number.isSafeInteger(count) && count >= 0, severity: "error", message: `${key} is a non-negative safe integer` });
  }
  return checks;
}

export function validationDisposition(checks: readonly BrainValidationCheck[]): BrainValidationReport["disposition"] {
  return checks.some(check => check.severity === "error" && !check.passed) ? "FAILED" : "PASSED";
}
