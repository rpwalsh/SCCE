import { describe, expect, it, vi } from "vitest";
import type { BrainLifecycleRecord, BrainLifecycleState } from "@scce/kernel";
import { createPostgresStorageAdapter } from "../postgres.js";

interface LifecycleRow {
  import_run_id: string;
  brain_version: string;
  root_path: string;
  state: BrainLifecycleState;
  manifest_json: BrainLifecycleRecord["manifest"];
  validation_json: BrainLifecycleRecord["validation"] | null;
  reason: string | null;
  revision: number;
  created_at: Date;
  updated_at: Date;
}

describe("Postgres brain lifecycle invariants", () => {
  it("rejects generic transitions into or out of ACTIVE before issuing SQL", async () => {
    const storage = createPostgresStorageAdapter({ url: "postgres://localhost/yopp-lifecycle-test", schema: "lifecycle_test" });
    const query = vi.fn();
    Object.defineProperty(storage, "query", { value: query });
    try {
      await expect(storage.brainImports.transitionLifecycle({
        importRunId: "ready-run",
        expectedState: "READY",
        toState: "ACTIVE",
        updatedAt: 10
      })).rejects.toThrow("requires activateReady");
      await expect(storage.brainImports.transitionLifecycle({
        importRunId: "active-run",
        expectedState: "ACTIVE",
        toState: "READY",
        updatedAt: 11
      })).rejects.toThrow("requires activateReady");
      expect(query).not.toHaveBeenCalled();
    } finally {
      await storage.close();
    }
  });

  it("demotes every marker and orphan ACTIVE row before activating READY", async () => {
    const storage = createPostgresStorageAdapter({ url: "postgres://localhost/yopp-lifecycle-test", schema: "lifecycle_test" });
    const rows = new Map<string, LifecycleRow>([
      ["marker-active", lifecycleRow("marker-active", "brain-marker", "ACTIVE", 1)],
      ["orphan-active", lifecycleRow("orphan-active", "brain-orphan", "ACTIVE", 2)],
      ["ready-target", lifecycleRow("ready-target", "brain-target", "READY", 3)]
    ]);
    let marker: unknown;
    const fakeClient = {
      query: async (sql: string, params: unknown[] = []) => {
        const normalized = sql.replace(/\s+/gu, " ").trim();
        if (normalized.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
        if (normalized.startsWith("SELECT *") && normalized.includes("WHERE import_run_id=$1 FOR UPDATE")) {
          const row = rows.get(String(params[0]));
          return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        }
        if (normalized.startsWith("UPDATE") && normalized.includes("WHERE state='ACTIVE' AND import_run_id<>$1")) {
          let rowCount = 0;
          for (const row of rows.values()) {
            if (row.state !== "ACTIVE" || row.import_run_id === params[0]) continue;
            row.state = "READY";
            row.reason = String(params[1]);
            row.revision += 1;
            row.updated_at = new Date(Number(params[2]));
            rowCount += 1;
          }
          return { rows: [], rowCount };
        }
        if (normalized.startsWith("UPDATE") && normalized.includes("WHERE import_run_id=$1 AND state='READY'")) {
          const row = rows.get(String(params[0]));
          if (!row || row.state !== "READY") return { rows: [], rowCount: 0 };
          row.state = "ACTIVE";
          row.reason = null;
          row.revision += 1;
          row.updated_at = new Date(Number(params[1]));
          return { rows: [], rowCount: 1 };
        }
        if (normalized.startsWith("SELECT import_run_id") && normalized.includes("WHERE state='ACTIVE' FOR UPDATE")) {
          const active = [...rows.values()].filter(row => row.state === "ACTIVE").map(row => ({ import_run_id: row.import_run_id }));
          return { rows: active, rowCount: active.length };
        }
        if (normalized.startsWith("INSERT INTO") && normalized.includes("model_state")) {
          marker = JSON.parse(String(params[0]));
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`unexpected lifecycle SQL: ${normalized}`);
      }
    };
    Object.defineProperty(storage, "tx", {
      value: async (operation: (client: typeof fakeClient) => Promise<unknown>) => operation(fakeClient)
    });

    try {
      const activated = await storage.brainImports.activateReady({
        brainVersion: "brain-target",
        importRunId: "ready-target",
        updatedAt: 10
      });

      expect(activated).toEqual({ activeBrainVersion: "brain-target", activeImportRunIds: ["ready-target"] });
      expect([...rows.values()].filter(row => row.state === "ACTIVE").map(row => row.import_run_id)).toEqual(["ready-target"]);
      expect(rows.get("marker-active")?.state).toBe("READY");
      expect(rows.get("orphan-active")?.state).toBe("READY");
      expect(marker).toEqual({ activeBrainVersion: "brain-target", activeImportRunIds: ["ready-target"], updatedAt: 10 });
    } finally {
      await storage.close();
    }
  });
});

function lifecycleRow(importRunId: string, brainVersion: string, state: BrainLifecycleState, updatedAt: number): LifecycleRow {
  return {
    import_run_id: importRunId,
    brain_version: brainVersion,
    root_path: `/brains/${importRunId}`,
    state,
    manifest_json: {
      schema: "scce.brainManifestContract.v1",
      importRunId,
      brainVersion,
      rootPath: `/brains/${importRunId}`,
      manifestHash: "a".repeat(64),
      sourceSchema: "test",
      runtimeContractVersion: 1,
      content: { graphShardCount: 0, languageShardCount: 0, ngramStateCount: 0, priorSectionCount: 0 },
      metadata: {},
      createdAt: 0
    },
    validation_json: null,
    reason: null,
    revision: 0,
    created_at: new Date(0),
    updated_at: new Date(updatedAt)
  };
}
