// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { PostgresStorageAdapter } from "../postgres.js";

it("counts each source version once across full and compact representations without hiding inaccessible-owner alternatives", async () => {
  const adapter = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema: "signature_owned", informationAccess: {
    tenantId: "fixture", principalId: "operator", compartments: [], maximumExportClass: "restricted"
  } });
  const full = [{ id: "full.1", version: "version.1", accessible: true, pooled: false },
    { id: "full.2", version: "version.2", accessible: false, pooled: false }, { id: "pool.4", version: "version.4", accessible: true, pooled: true }];
  const compact = [1, 2, 3, 4].map(index => ({ id: `compact.${index}`, version: `version.${index}` }));
  let captured = "";
  adapter.query = async <T>(sql: string): Promise<T[]> => {
    captured = sql;
    const hasPreference = sql.includes("preferred_full.source_version_id=ps.source_version_id")
      && sql.includes("preferred_full.profile_json->'pooledSourceBinding' IS NULL") && sql.includes("preferred_full.information_label");
    const selected = [...full.filter(row => row.accessible && !row.pooled), ...compact.filter(row => !hasPreference
      || !full.some(candidate => candidate.version === row.version && candidate.accessible && !candidate.pooled))];
    return selected.map(row => ({ id: row.id, source_version_id: row.version, source_uri: `fixture://${row.version}`, namespace: "corpus:wikipedia",
      model_source_system: "wikipedia", scripts: [{ script: "script:Latn", mass: 1 }], direction: "ltr", top: [["shared", 1]] })) as T[];
  };
  try {
    const rows = await adapter.languageIdentities.listProfileSignatures({ limit: 100 });
    expect(rows.map(row => row.id)).toEqual(["full.1", "compact.2", "compact.3", "compact.4"]);
    expect(rows.map(row => row.sourceVersionId)).toEqual(["version.1", "version.2", "version.3", "version.4"]);
    expect(captured).toContain("newer_version.source_id=sv.source_id");
    expect(captured).toContain("JOIN"); expect(captured).toContain("sv.id = src.source_version_id");
  } finally { await adapter.close(); }
});
