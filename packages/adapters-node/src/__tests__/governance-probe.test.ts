import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  canonicalStringify,
  createClock,
  createEventFactory,
  createHasher,
  createIdFactory,
  type EpisodeId
} from "@scce/kernel";
import { createApprovalSession } from "../approval-session.js";
import {
  createNodePostgresGovernanceProbe,
  verifyPostgresEventLedgerRows,
  type PostgresGovernanceEventRow
} from "../governance-probe.js";

describe("node postgres governance probe", () => {
  it("fails unavailable controls closed and verifies a complete observed control set", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "scce-governance-"));
    try {
      const rows = ledgerRows();
      const storage = {
        table: () => '"events"',
        query: async <T>(): Promise<T[]> => rows as T[]
      };
      const approvals = createApprovalSession();
      const absent = await createNodePostgresGovernanceProbe({
        storage: storage as never,
        approvals,
        workspaceRoot: root,
        environment: {}
      }).observe({ policy: DEFAULT_POLICY, now: 2_000 });

      expect(absent.ready).toBe(false);
      expect(absent.eventLedger).toMatchObject({ available: true, passed: true, events: 2 });
      expect(absent.rollback).toMatchObject({ available: false, passed: false });
      expect(absent.killSwitch).toMatchObject({ available: false, passed: false, state: "unavailable" });
      expect(absent.leases).toMatchObject({ available: false, passed: false, enumerable: false });
      expect(absent.pendingMutations).toMatchObject({ available: true, passed: true, enumerable: true });
      expect(absent.policyIntegrity).toMatchObject({ available: false, passed: false });

      const artifactContent = "rollback capability artifact";
      const artifactPath = path.join(root, "rollback.artifact");
      await writeFile(artifactPath, artifactContent, "utf8");
      await writeFile(path.join(root, "rollback.json"), JSON.stringify({
        capabilities: { restoreExisting: true, removeCreated: true },
        artifacts: [{ path: "rollback.artifact", sha256: sha256(artifactContent) }]
      }), "utf8");
      await writeFile(path.join(root, "leases.json"), JSON.stringify({
        authorities: [
          { scope: "connector", revocable: true, revocationAuthorityId: "connector-revoker" },
          { scope: "executor", revocable: true, revocationAuthorityId: "executor-revoker" }
        ],
        leases: []
      }), "utf8");
      await writeFile(path.join(root, "kill-switch.state"), "armed", "utf8");
      const policyText = canonicalStringify(DEFAULT_POLICY);
      const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const signature = sign("sha256", Buffer.from(policyText, "utf8"), keys.privateKey).toString("base64");
      const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
      const observed = await createNodePostgresGovernanceProbe({
        storage: storage as never,
        approvals,
        workspaceRoot: root,
        environment: {
          SCCE_GOVERNANCE_KILL_SWITCH_FILE: "kill-switch.state",
          SCCE_GOVERNANCE_ROLLBACK_MANIFEST: "rollback.json",
          SCCE_GOVERNANCE_LEASE_REGISTRY: "leases.json",
          SCCE_GOVERNANCE_POLICY_FINGERPRINT: sha256(policyText),
          SCCE_GOVERNANCE_POLICY_SIGNATURE: signature,
          SCCE_GOVERNANCE_POLICY_PUBLIC_KEY: publicKey
        }
      }).observe({ policy: DEFAULT_POLICY, now: 2_000 });

      expect(observed.ready).toBe(true);
      expect(observed.failures).toEqual([]);
      expect(observed.rollback).toMatchObject({ artifactsChecked: 1, artifactsReady: 1, passed: true });
      expect(observed.killSwitch).toMatchObject({ independentlyConfigured: true, state: "armed", passed: true });
      expect(observed.leases).toMatchObject({
        enumerable: true,
        connectorAuthorityReady: true,
        executorAuthorityReady: true,
        passed: true
      });
      expect(observed.policyIntegrity).toMatchObject({
        fingerprintValid: true,
        signatureValid: true,
        passed: true
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects tampering in the independent postgres ledger hash chain", () => {
    const rows = ledgerRows();
    const tampered = rows.map((row, index) => index === 1 ? { ...row, ledger_hash: "tampered" } : row);

    expect(verifyPostgresEventLedgerRows(rows)).toMatchObject({ passed: true, reason: "verified" });
    expect(verifyPostgresEventLedgerRows(tampered)).toMatchObject({
      passed: false,
      reason: "postgres_ledger_hash_chain_invalid"
    });
  });
});

function ledgerRows(): PostgresGovernanceEventRow[] {
  const hasher = createHasher();
  const clock = createClock({ fixedTime: 1_000, stepMs: 1 });
  const idFactory = createIdFactory({
    clock,
    hasher,
    namespace: "governance-probe-test",
    runSeed: "fixed",
    deterministicReplay: true
  });
  const events = createEventFactory({ clock, hasher, idFactory });
  const episodeId = "episode.governance" as EpisodeId;
  const first = events.create({ episodeId, typeId: "EpisodeOpened", payload: { test: 1 } });
  const second = events.create({ episodeId, typeId: "SelfModelProjected", payload: { test: 2 }, parents: [first] });
  let ledgerHash = "";
  return [first, second].map(event => {
    ledgerHash = sha256(`${ledgerHash}\u001f${event.hash}`);
    return {
      id: String(event.id),
      episode_id: String(event.episodeId),
      type_id: String(event.typeId),
      t: event.t,
      payload_json: event.payload,
      parents: event.parents.map(String),
      hash: event.hash,
      ledger_hash: ledgerHash
    };
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
