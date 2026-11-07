// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createPostgresStorageAdapter } from "../postgres.js";
import type { EvidenceQuery, SourceVersionId } from "@scce/kernel";

describe("owned source context sampling", () => {
  it("samples before the row limit while preserving source, promotion and access predicates", async () => {
    const storage = createPostgresStorageAdapter({ url: "postgres://unused:unused@127.0.0.1:1/unused", schema: "context_sample",
      informationAccess: { tenantId: "sample.tenant", principalId: "sample.owner", compartments: [], maximumExportClass: "restricted" } });
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    storage.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => { calls.push({ sql, params }); return []; };
    try {
      await storage.evidence.searchEvidence({ sourceVersionId: "source.owned" as SourceVersionId, status: "promoted", sourceSampleSeed: "stable-seed", limit: 1 });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.sql).toMatch(/source_version_id=\$1/u);
      expect(calls[0]!.sql).toContain("promoted");
      expect(calls[0]!.sql).toContain("information_label");
      expect(calls[0]!.sql).toMatch(/ORDER BY md5\(ev\.id \|\| \$\d+\) ASC, ev\.id ASC LIMIT \$\d+/u);
      expect(calls[0]!.params).toEqual(expect.arrayContaining(["source.owned", "stable-seed", 1]));
      for (const query of [
        { sourceSampleSeed: "seed" },
        { sourceSampleSeed: "seed", sourceVersionId: "source.owned", text: "query" },
        { sourceSampleSeed: "seed", sourceVersionId: "source.owned", features: ["sym:query"] }
      ]) await expect(storage.evidence.searchEvidence(query as EvidenceQuery)).rejects.toThrow("requires an exact source version");
      expect(calls).toHaveLength(1);
    } finally { await storage.close(); }
  });
});
