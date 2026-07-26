import { canonicalStringify, createHasher, toJsonValue } from "./primitives.js";
import type { Hasher, JsonValue } from "./types.js";

export const BRAIN_REPLAY_MANIFEST_SCHEMA = "scce.brain_replay_manifest.v1" as const;

export interface BrainReplayManifest {
  schema: typeof BRAIN_REPLAY_MANIFEST_SCHEMA;
  id: string;
  byteHash: string;
  canonicalBytes: string;
  componentIds: string[];
}

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
  replayManifest?: BrainReplayManifest;
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
  if (manifest.replayManifest) {
    try {
      verifyBrainReplayManifest(manifest.replayManifest);
      checks.push({ id: "manifest.replay", passed: true, severity: "error", message: "brain replay manifest bytes and identity are valid" });
    } catch (error) {
      checks.push({
        id: "manifest.replay",
        passed: false,
        severity: "error",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return checks;
}

export function compileBrainReplayManifest(input: {
  sourceSchema: string;
  sourceManifestHash: string;
  componentIds: readonly string[];
  content: BrainManifestContract["content"];
  configuration?: JsonValue;
  hasher?: Hasher;
}): BrainReplayManifest {
  const hasher = input.hasher ?? createHasher();
  const canonical = {
    schema: BRAIN_REPLAY_MANIFEST_SCHEMA,
    sourceSchema: input.sourceSchema,
    sourceManifestHash: input.sourceManifestHash,
    componentIds: [...new Set(input.componentIds.map(String))].sort(),
    content: toJsonValue(input.content),
    configuration: toJsonValue(input.configuration ?? {})
  };
  const canonicalBytes = canonicalStringify(canonical);
  const byteHash = hasher.digestHex(canonicalBytes);
  return {
    schema: BRAIN_REPLAY_MANIFEST_SCHEMA,
    id: `brain_replay.${byteHash.slice(0, 48)}`,
    byteHash,
    canonicalBytes,
    componentIds: canonical.componentIds
  };
}

export function verifyBrainReplayManifest(
  replay: BrainReplayManifest,
  hasher: Hasher = createHasher()
): void {
  if (replay.schema !== BRAIN_REPLAY_MANIFEST_SCHEMA) {
    throw new Error("unsupported brain replay manifest schema");
  }
  const byteHash = hasher.digestHex(replay.canonicalBytes);
  if (replay.byteHash !== byteHash) throw new Error("brain replay manifest hash mismatch");
  if (replay.id !== `brain_replay.${byteHash.slice(0, 48)}`) {
    throw new Error("brain replay manifest identity mismatch");
  }
  const decoded = JSON.parse(replay.canonicalBytes) as { componentIds?: unknown };
  if (!Array.isArray(decoded.componentIds)
    || canonicalStringify(decoded.componentIds) !== canonicalStringify(replay.componentIds)) {
    throw new Error("brain replay manifest component material mismatch");
  }
}

export function assertBrainManifestReplayForActivation(
  manifest: BrainManifestContract,
  hasher: Hasher = createHasher()
): void {
  if (!manifest.replayManifest) {
    throw new Error("production brain activation requires a replay manifest");
  }
  verifyBrainReplayManifest(manifest.replayManifest, hasher);
}

export function validationDisposition(checks: readonly BrainValidationCheck[]): BrainValidationReport["disposition"] {
  return checks.some(check => check.severity === "error" && !check.passed) ? "FAILED" : "PASSED";
}
