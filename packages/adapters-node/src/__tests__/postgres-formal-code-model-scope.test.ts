// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { codeSurfaceTokens, toJsonValue, trainKneserNey, type InformationLabel, type JsonValue } from "@scce/kernel";
import { clearResidentNgramModelJson, createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";

const label: InformationLabel = { tenantId: "tenant.fixture", principals: ["principal.fixture"], compartments: [], exportClass: "internal", mergePolicy: "isolated" };
const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { clearResidentNgramModelJson(); for (const adapter of adapters.splice(0)) await adapter.close(); });

interface Row { id: string; stream_id: string; language_hint: string; max_order: number; discount: string; updated_at: Date; information_label: InformationLabel;
  model_json: JsonValue; mass: number; bytes: number; accessible: boolean }
function row(id: string, formalLanguage: string | undefined, mass: number, metadata: Record<string, JsonValue> = {}, streamId = `opaque:${id}`): Row {
  const model_json = toJsonValue({ sourceSystem: "oss_code", ...(formalLanguage ? { formalLanguage } : {}), ...metadata, model: { order: 2, totalUnigramCount: mass } });
  return { id, stream_id: streamId, language_hint: "script:Latin;direction:ltr", max_order: 2, discount: "0.75", updated_at: new Date(1), information_label: label,
    model_json, mass, bytes: Buffer.byteLength(JSON.stringify(model_json)), accessible: true };
}

function fixture(rows: Row[]) {
  const adapter = createPostgresStorageAdapter({ url: "postgres://fixture:fixture@127.0.0.1/fixture", schema: "fixture", informationAccess: {
    tenantId: "tenant.fixture", principalId: "principal.fixture", compartments: [], maximumExportClass: "restricted", explicitMergeAuthority: true
  } });
  adapters.push(adapter);
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const blobs: string[][] = [];
  const object = (value: JsonValue) => value as Record<string, JsonValue>;
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    calls.push({ sql, params });
    const source = rows.filter(item => item.accessible && object(item.model_json).sourceSystem === "oss_code");
    if(sql.includes("AS source_identity_json")) return source.filter(item => {
      const formal = object(item.model_json).formalLanguage;
      return typeof formal !== "string" || !formal.trim();
    }).map(item => ({ id: item.id, stream_id: item.stream_id, source_identity_json: {
      formalLanguage: object(item.model_json).formalLanguage ?? null, relativePath: object(item.model_json).relativePath ?? null, streamUri: object(item.model_json).streamUri ?? null
    } })) as T[];
    if(sql.includes("model.model_json") && sql.includes(" AS json_bytes")) {
      expect(sql).toContain("CASE WHEN model.model_json->'_scceJoinProgramStorage'->>'schema'='scce.durable_join_program.byte_ledger.v1'");
      expect(sql).toContain("jsonb_typeof(model.model_json->'_scceJoinProgramStorage'->'decodedJsonbBytes')='number'");
      expect(sql).toContain("THEN (model.model_json->'_scceJoinProgramStorage'->>'decodedJsonbBytes')::numeric ELSE octet_length(model.model_json::text) END");
      const ids = params[0] as string[];
      blobs.push([...ids]);
      return source.filter(item => ids.includes(item.id)).map(item => ({ id: item.id, updated_at: item.updated_at, model_json: item.model_json, json_bytes: String(item.bytes) })) as T[];
    }
    const formalParam = /model\.model_json->>'formalLanguage'=\$(\d+)/u.exec(sql);
    const legacyParam = /model\.id=ANY\(\$(\d+)::text\[\]\)/u.exec(sql);
    const language = formalParam ? params[Number(formalParam[1]) - 1] : undefined;
    const legacyIds = legacyParam ? params[Number(legacyParam[1]) - 1] as string[] : [];
    const ordered = source.filter(item => !formalParam || object(item.model_json).formalLanguage === language || legacyIds.includes(item.id))
      .sort((a, b) => b.mass - a.mass || a.id.localeCompare(b.id)).slice(0, Number(params.at(-1)));
    if(sql.includes("pg_column_size(model.model_json) AS stored_bytes")) return ordered.map(item => ({ ...item, stored_bytes: String(item.bytes) })) as T[];
    if(sql.startsWith("SELECT * FROM")) return ordered as T[];
    throw Error(`unexpected mocked query: ${sql}`);
  };
  return { adapter, calls, blobs };
}

describe("formal source identity before ngram model budgets", () => {
  it.each([undefined, 1])("does not let 97 high-mass foreign models consume a minority language's count or byte budget (%s)", async maxTotalJsonBytes => {
    const correct = row("minority-go", "go", 1);
    const foreign = Array.from({ length: 97 }, (_, index) => row(`foreign-${index}`, "typescript", 1000));
    const { adapter, calls, blobs } = fixture([...foreign, correct]);
    const result = await adapter.languageMemory.listNgramModels({ sourceSystem: "oss_code", formalLanguage: "go", limit: 96,
      ...(maxTotalJsonBytes === undefined ? {} : { maxTotalJsonBytes }) });
    expect(result.map(record => record.id)).toEqual([correct.id]);
    expect(calls[0]!.sql).toContain("AS source_identity_json");
    expect(calls[0]!.sql).not.toContain("LIMIT");
    expect(calls[0]!.sql).not.toContain("SELECT model.model_json");
    const ranked = calls.find(call => call.sql.startsWith("SELECT * FROM") || call.sql.includes("pg_column_size(model.model_json) AS stored_bytes"))!;
    expect(ranked.sql.indexOf("model.model_json->>'formalLanguage'=")).toBeLessThan(ranked.sql.indexOf("ORDER BY"));
    expect(ranked.params).toContain("go");
    expect(ranked.sql).toContain("model.information_label");
    if(maxTotalJsonBytes !== undefined) expect(blobs).toEqual([[correct.id]]);
  });

  it("classifies legacy path ownership with the shared typed classifier and preserves declaration precedence and access scope", async () => {
    const legacy = row("legacy-go", undefined, 10, { relativePath: "src/legacy.go" });
    const chunk = row("chunk-go", undefined, 9, {}, "oss_code:src/chunk.go#training-chunk-000002");
    const noOwner = row("no-owner", undefined, 1000);
    const misleading = row("declared-typescript", "typescript", 2000, { relativePath: "src/misleading.go" });
    const pathPrecedence = row("path-typescript", undefined, 1000, { relativePath: "src/real.ts", streamUri: "oss_code:src/misleading.go" });
    const denied = { ...row("private-go", undefined, 5000, { relativePath: "private/source.go" }), accessible: false };
    const { adapter, calls } = fixture([legacy, chunk, noOwner, misleading, pathPrecedence, denied]);
    expect((await adapter.languageMemory.listNgramModels({ sourceSystem: "oss_code", formalLanguage: "go", limit: 96 })).map(record => record.id)).toEqual([legacy.id, chunk.id]);
    expect(calls[0]!.sql).toContain("model.information_label");
    expect(calls[0]!.sql).toContain("model.source_system");
    const ranked = calls.at(-1)!;
    expect(ranked.sql).toContain("model.id=ANY(");
    expect(ranked.params).toContainEqual(["chunk-go", "legacy-go"]);
    expect(ranked.sql).not.toContain("language_hint=");
  });

  it("keeps the learned proposer connected to the same pre-budget formal-language storage contract", async () => {
    const source = "package example\nfunc total(value float64) float64 { return value + value }\n";
    const model = trainKneserNey(codeSurfaceTokens(source), { order: 5 });
    const correct = row("go-model", "go", model.totalUnigramCount);
    correct.model_json = toJsonValue({ sourceSystem: "oss_code", formalLanguage: "go", sourceOrigin: "test-authored-training-reference", model });
    const { adapter } = fixture([...Array.from({ length: 97 }, (_, index) => row(`foreign-${index}`, "typescript", 10000)), correct]);
    const { createLearnedCodeProposer } = await import("../learned-code-proposer.js");
    expect(await createLearnedCodeProposer({ storage: { languageMemory: adapter.languageMemory } as never }).availableModelCount("go")).toBe(1);
  });
});
