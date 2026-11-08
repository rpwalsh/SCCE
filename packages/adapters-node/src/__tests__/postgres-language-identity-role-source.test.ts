import { describe, expect, it } from "vitest";
import { PostgresStorageAdapter } from "../postgres.js";

describe("postgres language identity role source projection", () => {
  it("prefers source namespace metadata and reads the model source only when durable source metadata is missing", async () => {
    const adapter = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema: "identity_role_source", informationAccess: {
      tenantId: "tenant.fixture", principalId: "principal.fixture", compartments: [], maximumExportClass: "restricted"
    } });
    let sql = "";
    (adapter.pool as unknown as { query: (text: string, params?: readonly unknown[]) => Promise<{ rows: unknown[] }> }).query = async text => {
      sql = text;
      return { rows: [
        { id: "known", source_version_id: "source.known", source_uri: "file:///known.ts", namespace: "corpus:oss_code", model_source_system: "oss_docs", scripts: [], direction: "ltr", top: [] },
        { id: "fallback", source_version_id: "source.fallback", source_uri: "file:///fallback.ts", namespace: null, model_source_system: "oss_code", scripts: [], direction: "ltr", top: [] }
      ] };
    };

    const rows = await adapter.languageIdentities.listProfileSignatures({ limit: 2 });

    expect(rows.map(row => row.sourceSystem)).toEqual(["oss_code", "oss_code"]);
    expect(sql).toContain("m.model_json->>'profileId' = src.id");
    expect(sql).toContain("m.model_json->>'sourceSystem'");
    expect(sql).toContain("s.namespace IS NULL OR s.namespace NOT LIKE 'corpus:%'");
  });
});
