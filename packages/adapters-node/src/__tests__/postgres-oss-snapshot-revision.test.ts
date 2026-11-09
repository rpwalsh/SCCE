import { afterEach, expect, it, vi } from "vitest";
import { PostgresStorageAdapter } from "../postgres.js";
import type { IngestionCheckpoint } from "@scce/kernel";

const stores: PostgresStorageAdapter[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });
it("invalidates language memory for snapshot-only head changes through the canonical writer", async () => {
  const store = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema: "fixture" }); stores.push(store);
  const query = vi.spyOn(store, "query").mockResolvedValue([]);
  const mutation = vi.spyOn(store, "mutateLanguageMemory").mockResolvedValue(true);
  const checkpoint: IngestionCheckpoint = { id: `oss.contract.snapshot.${"a".repeat(64)}`, rootUri: "fixture://public", itemUri: "@source-owned-project-snapshot", phase: "stored", status: "complete", offsetBytes: 0, updatedAt: 1,
    metadata: { schema: "scce.oss_owned_contract_snapshot.v1", identity: "b".repeat(64), complete: true } };
  await store.ingestion.put(checkpoint);
  expect(mutation).toHaveBeenCalledTimes(1); expect(query).not.toHaveBeenCalled();
  const sql = mutation.mock.calls[0]![0];
  expect(sql).toContain("IS DISTINCT FROM"); expect(sql).toContain("metadata_json");
  expect(sql.slice(sql.indexOf("WHERE"))).not.toContain("updated_at");
  await store.ingestion.put({ ...checkpoint, id: "ordinary.progress" });
  expect(query).toHaveBeenCalledTimes(1); expect(mutation).toHaveBeenCalledTimes(1);
});
