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
  type ImmutabilityGovernanceObservation,
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
  storage: Pick<PostgresStorageAdapter, "query" | "table" | "schema">;
  approvals: Pick<ApprovalSession, "snapshot">;
  workspaceRoot: string;
  environment?: GovernanceEnvironment;
}

/**
 * Durable-across-restart position is intentionally not required here: this
 * checkpoint lives only in the probe's own closure, for the lifetime of one
 * running process. A restart naturally does one full scan to
 * re-establish it (see `observeEventLedger` below) -- correct and safe,
 * just not free. What this fixes is the real, confirmed cost problem: every
 * `.observe()` call within a long-running process previously re-read and
 * re-verified the *entire* event table from scratch (see
 * `packages/kernel/src/production-turn-runtime.ts`'s governance checkpoint
 * calling this every turn). A durably-persisted checkpoint (surviving
 * restarts too) is a further optimization, not required to fix the
 * confirmed O(total events)-per-call cost.
 */
interface EventLedgerCheckpointState {
  anchorEventId: string;
  anchorT: number;
  anchorHash: string;
  anchorLedgerHash: string;
  /** Total verified events at this checkpoint -- preserves the `events` field's original "total ledger size" meaning under incremental verification. */
  totalEvents: number;
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
  let ledgerCheckpoint: EventLedgerCheckpointState | undefined;
  return {
    async observe(input): Promise<GovernanceObservation> {
      const [eventLedger, rollback, killSwitch, leases, immutability] = await Promise.all([
        observeEventLedgerIncremental(),
        observeRollback(workspaceRoot, environment),
        observeKillSwitch(workspaceRoot, environment),
        observeLeases(workspaceRoot, environment, input.now),
        observeImmutabilityControls(options.storage)
      ]);
      return governanceObservation(input.now, {
        eventLedger,
        rollback,
        killSwitch,
        leases,
        pendingMutations: observePendingMutations(options.approvals),
        policyIntegrity: observePolicyIntegrity(input.policy, environment),
        immutability
      });
    }
  };

  /**
   * Bounded live verification (layer 1 of the three-layer design): on the
   * first call, or after any failure/tamper detection forces a reset, does
   * one full scan (same cost as before, but now a one-time cost per
   * process lifetime rather than per call). Every subsequent call verifies
   * only that the checkpoint anchor row is byte-for-byte unchanged, then
   * verifies just the suffix appended since -- the checkpoint's ledger
   * hash chain is a real cryptographic continuation, so an unchanged
   * anchor plus a verified suffix is exactly as strong a guarantee as a
   * full rescan would give, at O(new events) instead of O(all events)
   * cost. A mismatch at the anchor (mutation or deletion of ledger
   * history) or a broken suffix chain both fail closed and force a full
   * rescan on the next call.
   */
  async function observeEventLedgerIncremental(): Promise<EventLedgerGovernanceObservation> {
    try {
      if (!ledgerCheckpoint) return await fullyVerifyEventLedgerAndCheckpoint();

      const anchorRows = await options.storage.query<{ id: string; t: string | number; hash: string; ledger_hash: string }>(
        `SELECT id, t, hash, ledger_hash FROM ${options.storage.table("events")} WHERE id = $1`,
        [ledgerCheckpoint.anchorEventId]
      );
      const anchor = anchorRows[0];
      if (!anchor || anchor.hash !== ledgerCheckpoint.anchorHash || anchor.ledger_hash !== ledgerCheckpoint.anchorLedgerHash) {
        const expectedAnchorEventId = ledgerCheckpoint.anchorEventId;
        ledgerCheckpoint = undefined;
        return {
          available: true,
          passed: false,
          reason: "checkpoint_anchor_mutated_or_missing",
          events: 0,
          evidence: toJsonValue({
            mode: "incremental_suffix",
            expectedAnchorEventId,
            observedAnchor: anchor ?? null
          })
        };
      }

      const suffixRows = await options.storage.query<PostgresGovernanceEventRow>(
        `SELECT id, episode_id, type_id, t, payload_json, parents, hash, ledger_hash
           FROM ${options.storage.table("events")}
          WHERE (t, id) > ($2, $1)
          ORDER BY t ASC, id ASC`,
        [ledgerCheckpoint.anchorEventId, Number(anchor.t)]
      );

      const eventChain = createAuditEngine().verifyEventChain(suffixRows.map(rowToEvent));
      const brokenLedgerHashes: Array<{ eventId: string; expected: string; observed: string }> = [];
      let runningLedgerHash = ledgerCheckpoint.anchorLedgerHash;
      for (const row of suffixRows) {
        const expected = sha256(`${runningLedgerHash}${row.hash}`);
        if (row.ledger_hash !== expected) brokenLedgerHashes.push({ eventId: row.id, expected, observed: row.ledger_hash });
        runningLedgerHash = row.ledger_hash;
      }
      const passed = eventChain.ok && brokenLedgerHashes.length === 0;
      const totalEventsBefore = ledgerCheckpoint.totalEvents;
      if (passed) {
        if (suffixRows.length > 0) {
          const last = suffixRows[suffixRows.length - 1]!;
          ledgerCheckpoint = {
            anchorEventId: last.id,
            anchorT: Number(last.t),
            anchorHash: last.hash,
            anchorLedgerHash: last.ledger_hash,
            totalEvents: totalEventsBefore + suffixRows.length
          };
        }
      } else {
        ledgerCheckpoint = undefined;
      }
      return {
        available: true,
        passed,
        reason: passed
          ? "verified_incremental"
          : !eventChain.ok
            ? "event_hash_chain_invalid"
            : "postgres_ledger_hash_chain_invalid",
        events: totalEventsBefore + suffixRows.length,
        latestLedgerHash: suffixRows.at(-1)?.ledger_hash ?? anchor.ledger_hash,
        evidence: toJsonValue({
          mode: "incremental_suffix",
          anchorEventId: anchor.id,
          suffixEvents: suffixRows.length,
          eventChain,
          brokenLedgerHashes: brokenLedgerHashes.slice(0, 32)
        })
      };
    } catch (error) {
      ledgerCheckpoint = undefined;
      return {
        ...unavailableControl("event_ledger_probe_failed", error),
        events: 0
      };
    }
  }

  async function fullyVerifyEventLedgerAndCheckpoint(): Promise<EventLedgerGovernanceObservation> {
    const rows = await options.storage.query<PostgresGovernanceEventRow>(
      `SELECT id, episode_id, type_id, t, payload_json, parents, hash, ledger_hash
         FROM ${options.storage.table("events")}
        ORDER BY t ASC, id ASC`
    );
    const observation = verifyPostgresEventLedgerRows(rows);
    if (observation.passed && rows.length > 0) {
      const last = rows[rows.length - 1]!;
      ledgerCheckpoint = {
        anchorEventId: last.id,
        anchorT: Number(last.t),
        anchorHash: last.hash,
        anchorLedgerHash: last.ledger_hash,
        totalEvents: rows.length
      };
    }
    return { ...observation, evidence: toJsonValue({ mode: "full_scan", ...(observation.evidence as Record<string, JsonValue>) }) };
  }
}

/**
 * Layer 3 of the three-layer design: an explicit, on-demand full audit that
 * ignores any in-process checkpoint and recomputes the entire chain from
 * scratch -- the maintenance-command primitive. Exported separately from
 * the bounded per-call path above so a periodic job (or an operator) can
 * invoke exactly this, deliberately paying the full O(all events) cost to
 * get an unconditional answer.
 */
export async function fullyVerifyEventLedger(
  storage: Pick<PostgresStorageAdapter, "query" | "table">
): Promise<EventLedgerGovernanceObservation> {
  const rows = await storage.query<PostgresGovernanceEventRow>(
    `SELECT id, episode_id, type_id, t, payload_json, parents, hash, ledger_hash
       FROM ${storage.table("events")}
      ORDER BY t ASC, id ASC`
  );
  const observation = verifyPostgresEventLedgerRows(rows);
  return { ...observation, evidence: toJsonValue({ mode: "full_scan", ...(observation.evidence as Record<string, JsonValue>) }) };
}

function rowToEvent(row: PostgresGovernanceEventRow): ScceEvent {
  return {
    id: row.id,
    episodeId: row.episode_id,
    typeId: row.type_id,
    t: Number(row.t),
    payload: row.payload_json,
    parents: row.parents,
    hash: row.hash
  } as unknown as ScceEvent;
}

/**
 * Layer 2 of the three-layer design: observes whether the connected role
 * can actually mutate the event ledger, rather than assuming application
 * discipline is enough. This only *observes and reports* the current
 * privilege/trigger state via safe, read-only system-catalog queries -- it
 * does not provision a separate migration-only role or install triggers
 * itself, since that changes how the database must be deployed (a second
 * connection role/string) and is an operator decision, not something to
 * silently change here. See the handoff doc for the exact SQL an operator
 * should run to lock this down.
 */
async function observeImmutabilityControls(
  storage: Pick<PostgresStorageAdapter, "query" | "table" | "schema">
): Promise<ImmutabilityGovernanceObservation> {
  try {
    const table = storage.table("events");
    const privilegeRows = await storage.query<{ update_allowed: boolean; delete_allowed: boolean }>(
      `SELECT has_table_privilege(current_user, '${table}', 'UPDATE') AS update_allowed,
              has_table_privilege(current_user, '${table}', 'DELETE') AS delete_allowed`
    );
    const privilege = privilegeRows[0];
    const updateDenied = privilege ? !privilege.update_allowed : false;
    const deleteDenied = privilege ? !privilege.delete_allowed : false;
    const triggerRows = await storage.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = 'events' AND NOT t.tgisinternal AND t.tgenabled <> 'D'`,
      [storage.schema]
    );
    const protectiveTriggerPresent = Number(triggerRows[0]?.count ?? "0") > 0;
    const passed = updateDenied && deleteDenied;
    return {
      available: true,
      passed,
      reason: passed
        ? (protectiveTriggerPresent ? "verified" : "denied_by_privilege_no_protective_trigger")
        : "runtime_role_can_mutate_events",
      updateDenied,
      deleteDenied,
      protectiveTriggerPresent,
      evidence: toJsonValue({ table, updateDenied, deleteDenied, protectiveTriggerPresent })
    };
  } catch (error) {
    return {
      ...unavailableControl("immutability_probe_failed", error),
      updateDenied: false,
      deleteDenied: false,
      protectiveTriggerPresent: false
    };
  }
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
