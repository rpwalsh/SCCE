import { createHash, verify as verifyCryptographicSignature } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  canonicalStringify,
  createAuditEngine,
  governanceObservation,
  toJsonValue,
  type EventLedgerGovernanceObservation,
  type GovernanceControlObservation,
  type GovernanceObservation,
  type GovernanceProbe,
  type JsonValue,
  type KillSwitchGovernanceObservation,
  type LeaseGovernanceObservation,
  type PendingMutationGovernanceObservation,
  type PolicyIntegrityGovernanceObservation,
  type PolicyProfile,
  type RollbackGovernanceObservation,
  type ScceEvent
} from "@scce/kernel";
import type { ApprovalSession } from "./approval-session.js";
import type { PostgresStorageAdapter } from "./postgres.js";

const KILL_SWITCH_KEY = "SCCE_GOVERNANCE_KILL_SWITCH";
const KILL_SWITCH_FILE_KEY = "SCCE_GOVERNANCE_KILL_SWITCH_FILE";
const ROLLBACK_MANIFEST_KEY = "SCCE_GOVERNANCE_ROLLBACK_MANIFEST";
const LEASE_REGISTRY_KEY = "SCCE_GOVERNANCE_LEASE_REGISTRY";
const POLICY_FINGERPRINT_KEY = "SCCE_GOVERNANCE_POLICY_FINGERPRINT";
const POLICY_SIGNATURE_KEY = "SCCE_GOVERNANCE_POLICY_SIGNATURE";
const POLICY_PUBLIC_KEY = "SCCE_GOVERNANCE_POLICY_PUBLIC_KEY";

type GovernanceEnvironment = Readonly<Record<string, string | undefined>>;

export interface NodePostgresGovernanceProbeOptions {
  storage: Pick<PostgresStorageAdapter, "query" | "table">;
  approvals: Pick<ApprovalSession, "snapshot">;
  workspaceRoot: string;
  environment?: GovernanceEnvironment;
}

export interface PostgresGovernanceEventRow {
  id: string;
  episode_id: string;
  type_id: string;
  t: string | number;
  payload_json: JsonValue;
  parents: string[];
  hash: string;
  ledger_hash: string;
}

interface ManifestRead {
  configuredPath?: string;
  value?: JsonValue;
  error?: string;
}

export function createNodePostgresGovernanceProbe(
  options: NodePostgresGovernanceProbeOptions
): GovernanceProbe {
  const environment: GovernanceEnvironment = Object.freeze({
    ...(options.environment ?? process.env)
  });
  const workspaceRoot = path.resolve(options.workspaceRoot);
  return {
    async observe(input): Promise<GovernanceObservation> {
      const [eventLedger, rollback, killSwitch, leases] = await Promise.all([
        observeEventLedger(options.storage),
        observeRollback(workspaceRoot, environment),
        observeKillSwitch(workspaceRoot, environment),
        observeLeases(workspaceRoot, environment, input.now)
      ]);
      return governanceObservation(input.now, {
        eventLedger,
        rollback,
        killSwitch,
        leases,
        pendingMutations: observePendingMutations(options.approvals),
        policyIntegrity: observePolicyIntegrity(input.policy, environment)
      });
    }
  };
}

export function verifyPostgresEventLedgerRows(
  rows: readonly PostgresGovernanceEventRow[]
): EventLedgerGovernanceObservation {
  const events = rows.map(row => ({
    id: row.id,
    episodeId: row.episode_id,
    typeId: row.type_id,
    t: Number(row.t),
    payload: row.payload_json,
    parents: row.parents,
    hash: row.hash
  })) as unknown as ScceEvent[];
  const eventChain = createAuditEngine().verifyEventChain(events);
  const brokenLedgerHashes: Array<{ eventId: string; expected: string; observed: string }> = [];
  let previousLedgerHash = "";
  for (const row of rows) {
    const expected = sha256(`${previousLedgerHash}\u001f${row.hash}`);
    if (row.ledger_hash !== expected) {
      brokenLedgerHashes.push({ eventId: row.id, expected, observed: row.ledger_hash });
    }
    previousLedgerHash = row.ledger_hash;
  }
  const passed = rows.length > 0 && eventChain.ok && brokenLedgerHashes.length === 0;
  return {
    available: true,
    passed,
    reason: rows.length === 0
      ? "event_ledger_empty"
      : !eventChain.ok
        ? "event_hash_chain_invalid"
        : brokenLedgerHashes.length > 0
          ? "postgres_ledger_hash_chain_invalid"
          : "verified",
    events: rows.length,
    latestLedgerHash: rows.at(-1)?.ledger_hash,
    evidence: toJsonValue({
      events: rows.length,
      eventChain,
      brokenLedgerHashes: brokenLedgerHashes.slice(0, 32),
      ordering: "t_ascending_id_ascending"
    })
  };
}

async function observeEventLedger(
  storage: Pick<PostgresStorageAdapter, "query" | "table">
): Promise<EventLedgerGovernanceObservation> {
  try {
    const rows = await storage.query<PostgresGovernanceEventRow>(
      `SELECT id, episode_id, type_id, t, payload_json, parents, hash, ledger_hash
         FROM ${storage.table("events")}
        ORDER BY t ASC, id ASC`
    );
    return verifyPostgresEventLedgerRows(rows);
  } catch (error) {
    return {
      ...unavailableControl("event_ledger_probe_failed", error),
      events: 0
    };
  }
}

async function observeRollback(
  workspaceRoot: string,
  environment: GovernanceEnvironment
): Promise<RollbackGovernanceObservation> {
  const manifest = await readManifest(environment[ROLLBACK_MANIFEST_KEY], workspaceRoot);
  if (!manifest.configuredPath) {
    return {
      ...unavailableControl("rollback_manifest_unconfigured"),
      artifactsChecked: 0,
      artifactsReady: 0
    };
  }
  if (manifest.error || !isJsonRecord(manifest.value)) {
    return {
      available: true,
      passed: false,
      reason: "rollback_manifest_invalid",
      artifactsChecked: 0,
      artifactsReady: 0,
      evidence: toJsonValue({ manifest: manifest.configuredPath, error: manifest.error ?? "manifest must be an object" })
    };
  }
  const value = manifest.value;
  const capabilities = isJsonRecord(value.capabilities) ? value.capabilities : {};
  const artifacts = Array.isArray(value.artifacts) ? value.artifacts : [];
  const checks = await Promise.all(artifacts.map(async artifact => {
    if (!isJsonRecord(artifact) || typeof artifact.path !== "string" || typeof artifact.sha256 !== "string") {
      return { path: null, ready: false, reason: "invalid_artifact_record" };
    }
    const target = path.resolve(workspaceRoot, artifact.path);
    if (!insideRoot(workspaceRoot, target)) {
      return { path: artifact.path, ready: false, reason: "artifact_outside_workspace" };
    }
    try {
      const content = await readFile(target);
      const observed = sha256(content);
      const expected = artifact.sha256.toLowerCase();
      return {
        path: artifact.path,
        ready: /^[0-9a-f]{64}$/u.test(expected) && observed === expected,
        reason: observed === expected ? "verified" : "artifact_hash_mismatch"
      };
    } catch (error) {
      return {
        path: artifact.path,
        ready: false,
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  }));
  const artifactsReady = checks.filter(check => check.ready).length;
  const capabilityReady = capabilities.restoreExisting === true && capabilities.removeCreated === true;
  const passed = capabilityReady && checks.length > 0 && artifactsReady === checks.length;
  return {
    available: true,
    passed,
    reason: passed ? "verified" : "rollback_artifacts_not_ready",
    artifactsChecked: checks.length,
    artifactsReady,
    evidence: toJsonValue({
      manifest: manifest.configuredPath,
      capabilityReady,
      capabilities,
      artifacts: checks
    })
  };
}

async function observeKillSwitch(
  workspaceRoot: string,
  environment: GovernanceEnvironment
): Promise<KillSwitchGovernanceObservation> {
  const controlFile = environment[KILL_SWITCH_FILE_KEY]?.trim();
  let configured = environment[KILL_SWITCH_KEY]?.trim().toLowerCase();
  let source: JsonValue = {
    source: "deployment_environment_snapshot",
    key: KILL_SWITCH_KEY,
    mutableDuringProbeLifetime: false
  };
  if (controlFile) {
    const absolute = path.resolve(workspaceRoot, controlFile);
    try {
      configured = (await readFile(absolute, "utf8")).trim().toLowerCase();
      source = {
        source: "deployment_control_file",
        key: KILL_SWITCH_FILE_KEY,
        path: absolute,
        readAtProbeTime: true
      };
    } catch (error) {
      return {
        available: false,
        passed: false,
        reason: "kill_switch_control_file_unavailable",
        state: "unavailable",
        independentlyConfigured: true,
        evidence: toJsonValue({
          ...(source as Record<string, JsonValue>),
          path: absolute,
          error: error instanceof Error ? error.message : String(error)
        })
      };
    }
  }
  if (!configured) {
    return {
      ...unavailableControl("kill_switch_unconfigured"),
      state: "unavailable",
      independentlyConfigured: false
    };
  }
  const state: KillSwitchGovernanceObservation["state"] = configured === "armed"
    ? "armed"
    : configured === "triggered"
      ? "triggered"
      : "invalid";
  return {
    available: true,
    passed: state === "armed",
    reason: state === "armed" ? "armed" : state === "triggered" ? "kill_switch_triggered" : "kill_switch_state_invalid",
    state,
    independentlyConfigured: true,
    evidence: toJsonValue({ ...(source as Record<string, JsonValue>), state })
  };
}

async function observeLeases(
  workspaceRoot: string,
  environment: GovernanceEnvironment,
  now: number
): Promise<LeaseGovernanceObservation> {
  const manifest = await readManifest(environment[LEASE_REGISTRY_KEY], workspaceRoot);
  if (!manifest.configuredPath) {
    return {
      ...unavailableControl("lease_registry_unconfigured"),
      enumerable: false,
      activeLeases: 0,
      connectorAuthorityReady: false,
      executorAuthorityReady: false,
      revocableActiveLeases: 0
    };
  }
  if (manifest.error || !isJsonRecord(manifest.value)) {
    return {
      available: true,
      passed: false,
      reason: "lease_registry_invalid",
      enumerable: false,
      activeLeases: 0,
      connectorAuthorityReady: false,
      executorAuthorityReady: false,
      revocableActiveLeases: 0,
      evidence: toJsonValue({ registry: manifest.configuredPath, error: manifest.error ?? "registry must be an object" })
    };
  }
  const authorities = Array.isArray(manifest.value.authorities) ? manifest.value.authorities : [];
  const leases = Array.isArray(manifest.value.leases) ? manifest.value.leases : [];
  const authorityReady = (scope: string) => authorities.some(authority =>
    isJsonRecord(authority)
    && authority.scope === scope
    && authority.revocable === true
    && typeof authority.revocationAuthorityId === "string"
    && authority.revocationAuthorityId.length > 0);
  const active = leases.filter(lease => isJsonRecord(lease) && lease.status === "active");
  const revocable = active.filter(lease =>
    isJsonRecord(lease)
    && lease.revocable === true
    && typeof lease.revocationId === "string"
    && lease.revocationId.length > 0
    && typeof lease.expiresAt === "number"
    && lease.expiresAt > now);
  const connectorAuthorityReady = authorityReady("connector");
  const executorAuthorityReady = authorityReady("executor");
  const passed = connectorAuthorityReady
    && executorAuthorityReady
    && revocable.length === active.length;
  return {
    available: true,
    passed,
    reason: passed ? "verified" : "lease_revocation_not_ready",
    enumerable: true,
    activeLeases: active.length,
    connectorAuthorityReady,
    executorAuthorityReady,
    revocableActiveLeases: revocable.length,
    evidence: toJsonValue({
      registry: manifest.configuredPath,
      authorities: authorities.length,
      leases: leases.length,
      activeLeaseIds: active.flatMap(lease =>
        isJsonRecord(lease) && typeof lease.id === "string" ? [lease.id] : [])
    })
  };
}

function observePendingMutations(
  approvals: Pick<ApprovalSession, "snapshot">
): PendingMutationGovernanceObservation {
  try {
    const snapshot = approvals.snapshot();
    const mutationIds = snapshot.pending.map(record => record.planId);
    const unique = new Set(mutationIds);
    const passed = unique.size === mutationIds.length;
    return {
      available: true,
      passed,
      reason: passed ? "enumerated" : "pending_mutation_ids_not_unique",
      enumerable: true,
      pending: mutationIds.length,
      mutationIds,
      evidence: toJsonValue({
        pending: mutationIds.length,
        approved: snapshot.approved.length,
        operatorGrant: snapshot.operatorGrant
      })
    };
  } catch (error) {
    return {
      ...unavailableControl("pending_mutation_probe_failed", error),
      enumerable: false,
      pending: 0,
      mutationIds: []
    };
  }
}

function observePolicyIntegrity(
  policy: PolicyProfile,
  environment: GovernanceEnvironment
): PolicyIntegrityGovernanceObservation {
  const canonical = canonicalStringify(policy);
  const fingerprint = sha256(canonical);
  const expectedFingerprint = environment[POLICY_FINGERPRINT_KEY]?.trim().toLowerCase();
  const signature = environment[POLICY_SIGNATURE_KEY]?.trim();
  const publicKey = environment[POLICY_PUBLIC_KEY]?.replace(/\\n/gu, "\n").trim();
  const configured = Boolean(expectedFingerprint && signature && publicKey);
  const fingerprintValid = Boolean(
    expectedFingerprint
    && /^[0-9a-f]{64}$/u.test(expectedFingerprint)
    && expectedFingerprint === fingerprint
  );
  let signatureValid = false;
  if (signature && publicKey) {
    try {
      signatureValid = verifyCryptographicSignature(
        "sha256",
        Buffer.from(canonical, "utf8"),
        publicKey,
        Buffer.from(signature, "base64")
      );
    } catch {
      signatureValid = false;
    }
  }
  const passed = configured && fingerprintValid && signatureValid;
  return {
    available: configured,
    passed,
    reason: !configured
      ? "policy_integrity_material_unconfigured"
      : passed
        ? "verified"
        : "policy_integrity_invalid",
    fingerprint,
    expectedFingerprint,
    fingerprintValid,
    signatureValid,
    evidence: toJsonValue({
      fingerprint,
      expectedFingerprint: expectedFingerprint ?? null,
      fingerprintValid,
      signatureConfigured: Boolean(signature),
      publicKeyConfigured: Boolean(publicKey),
      signatureValid
    })
  };
}

async function readManifest(
  configuredPath: string | undefined,
  workspaceRoot: string
): Promise<ManifestRead> {
  if (!configuredPath?.trim()) return {};
  const absolute = path.resolve(workspaceRoot, configuredPath.trim());
  try {
    return {
      configuredPath: absolute,
      value: JSON.parse(await readFile(absolute, "utf8")) as JsonValue
    };
  } catch (error) {
    return {
      configuredPath: absolute,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function unavailableControl(reason: string, error?: unknown): GovernanceControlObservation {
  return {
    available: false,
    passed: false,
    reason,
    evidence: toJsonValue({
      observed: false,
      error: error instanceof Error ? error.message : error === undefined ? null : String(error)
    })
  };
}

function isJsonRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function insideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
