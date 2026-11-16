// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFile } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTEXTUAL_QA_CONSTRUCTION_RECIPE, LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA, LEXICAL_SENSE_SCHEMA, LEXICAL_SENSE_RECIPE,
  type InformationLabel, type JsonValue } from "@scce/kernel";
import { createPostgresStorageAdapter } from "../postgres.js";

const label: InformationLabel = { tenantId: "tenant.fixture", principals: ["principal.fixture"], compartments: [], exportClass: "restricted", mergePolicy: "isolated" };
const access = { tenantId: label.tenantId, principalId: "principal.fixture", compartments: [], maximumExportClass: "restricted" as const };
const adapters: ReturnType<typeof createPostgresStorageAdapter>[] = [];
afterAll(async () => { await Promise.all(adapters.map(adapter => adapter.close())); });
function fixture() {
  const adapter = createPostgresStorageAdapter({ url: "postgres://unused:unused@127.0.0.1/unused", schema: "fixture", informationAccess: access });
  adapters.push(adapter);
  return adapter;
}
async function getterQuery() {
  const adapter = fixture(), calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = { profileId: "profile", sourceId: "source" as never, sourceVersionId: "version" as never, sourceSystem: "workspace",
    patternSchema: LEXICAL_SENSE_SCHEMA, componentRecipe: LEXICAL_SENSE_RECIPE, informationLabel: label };
  const manifest = { schema: "scce.language_pattern_active_projection.v1", ...query, patternIds: ["pattern"], sourceDependencies: [{ evidenceIds: ["a", "b", "a"] }] };
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    calls.push({ sql, params }); return (sql.includes("storage_meta") ? [{ value_json: manifest }] : [{ id: "pattern" }]) as T[];
  };
  expect(await adapter.languageMemory.getLanguagePatternProjection!(query)).toBeDefined();
  expect(await adapter.languageMemory.getLanguagePatternProjection!({ ...query, informationLabel: { ...label, tenantId: "denied" } })).toBeUndefined();
  return calls.find(call => call.sql.startsWith("WITH selected_pattern"))!;
}
async function listingQuery(schema: string) {
  const adapter = fixture(), calls: string[] = [];
  adapter.query = async <T>(sql: string): Promise<T[]> => { calls.push(sql); return []; };
  await adapter.languageMemory.listLanguagePatterns({ patternSchemas: [schema], profileId: "profile", sourceSystem: schema === LEXICAL_SENSE_SCHEMA ? "workspace" : "dialogue", limit: 512 });
  return calls.find(sql => sql.includes("candidate_pool AS MATERIALIZED"))!;
}
function closingParenthesis(sql: string, open: number): number {
  let depth = 0, quoted = false;
  for (let index = open; index < sql.length; index++) {
    if (sql[index] === "'") { if (quoted && sql[index + 1] === "'") { index++; continue; } quoted = !quoted; }
    if (quoted) continue;
    if (sql[index] === "(") depth++;
    if (sql[index] === ")" && --depth === 0) return index;
  }
  throw Error("unclosed generated projection CTE");
}
function membershipSql(sql: string, qa: boolean) {
  const name = sql.match(/(active_projection_ids_\d+)_headers AS MATERIALIZED/u)![1]!;
  const start = sql.indexOf(`${name}_headers AS MATERIALIZED`), open = sql.indexOf("(", start), headerEnd = closingParenthesis(sql, open);
  const finalStart = sql.indexOf(`${name} AS MATERIALIZED`, headerEnd), end = closingParenthesis(sql, sql.indexOf("(", finalStart));
  const header = `SELECT * FROM jsonb_to_recordset($1::jsonb) AS header(projection_key text,profile_id text,source_system text,pattern_schema text,projection_recipe text,source_version_id text,pattern_ids jsonb,source_dependencies jsonb)`;
  const production = `${name}_headers AS MATERIALIZED (${header})${sql.slice(headerEnd + 1, end + 1)}`.replaceAll('"fixture"."language_patterns"', "pattern_rows");
  const rows = `pattern_rows AS MATERIALIZED (SELECT * FROM jsonb_to_recordset($2::jsonb) AS pattern(id text,profile_id text,source_system text,pattern_schema text,component_recipe text,owned_source_version_id text,pattern_kind text,evidence_ids text[],information_label jsonb))`;
  const selected = `SELECT DISTINCT pattern_id FROM ${qa ? `${name}_eligible` : name} ORDER BY pattern_id`;
  const legacy = `SELECT DISTINCT pattern.id AS pattern_id FROM ${name}_headers header
    CROSS JOIN LATERAL jsonb_array_elements_text(header.pattern_ids) member(pattern_id)
    JOIN pattern_rows pattern ON pattern.id=member.pattern_id AND pattern.profile_id=header.profile_id AND pattern.source_system=header.source_system
      AND pattern.pattern_schema=header.pattern_schema AND pattern.component_recipe=header.projection_recipe AND pattern.owned_source_version_id=header.source_version_id
    WHERE pattern.pattern_kind='semantic_role' AND COALESCE(array_length(pattern.evidence_ids,1),0)>0
      AND pattern.evidence_ids <@ ARRAY(SELECT DISTINCT requested.evidence_id FROM jsonb_array_elements(header.source_dependencies) dependency(value)
        CROSS JOIN LATERAL jsonb_array_elements_text(dependency.value->'evidenceIds') requested(evidence_id)) ORDER BY pattern_id`;
  return { next: `WITH ${rows},${production} ${selected}`, legacy: `WITH ${rows},${name}_headers AS MATERIALIZED (${header}) ${legacy}` };
}
interface ExplainNode { "Node Type": string; "Join Type"?: string; "Subplan Name"?: string; "CTE Name"?: string; "Actual Loops"?: number; "Actual Rows"?: number; "Function Name"?: string; Plans?: ExplainNode[]; }
function explainNodes(node: ExplainNode): ExplainNode[] { return [node, ...(node.Plans ?? []).flatMap(explainNodes)]; }
function checkFullMembershipPlan(explain: unknown) {
  const root = (explain as Array<{ Plan: ExplainNode }>)[0]!.Plan, nodes = explainNodes(root);
  const membership = nodes.find(node => node["Subplan Name"]?.endsWith("_membership"))!;
  expect(membership).toBeDefined();
  expect(membership["Join Type"]).toBe("Full");
  expect(["Hash Join", "Merge Join"]).toContain(membership["Node Type"]);
  const membershipNodes = explainNodes(membership);
  expect(membershipNodes.some(node => node["Node Type"] === "Nested Loop")).toBe(false);
  expect(membershipNodes.filter(node => node["CTE Name"]?.endsWith("_dependencies") || node["CTE Name"] === "allowed_evidence")).toHaveLength(1);
  expect(membershipNodes.filter(node => node["CTE Name"]?.endsWith("_requested") || node["CTE Name"] === "requested_evidence")).toHaveLength(1);
  return membership["Node Type"];
}

it("keeps exact scoped/ACL getter gates while checking one distinct evidence relation", async () => {
  const call = await getterQuery();
  expect(call.sql).toContain("allowed_evidence AS MATERIALIZED (SELECT DISTINCT evidence_id");
  expect(call.sql).toContain("pattern.profile_id=$2 AND pattern.owned_source_version_id=$3 AND pattern.source_system=$4");
  expect(call.sql).toContain("pattern.pattern_schema=$5 AND pattern.component_recipe=$6");
  expect(call.sql).toContain("pattern.pattern_kind='semantic_role'");
  expect(call.sql).toContain("COALESCE(array_length(pattern.evidence_ids,1),0)>0");
  expect(call.sql).toContain("pattern.information_label");
  expect(call.sql).not.toContain("evidence_ids <@");
  expect(call.sql).toContain("requested_evidence AS MATERIALIZED");
  expect(call.sql).toContain("FULL JOIN allowed_evidence allowed ON allowed.evidence_id=requested.evidence_id");
  expect(call.sql).toContain("GROUP BY id HAVING bool_and(allowed_id IS NOT NULL)");
  expect(call.params[6]).toEqual(["a", "b"]);
});
it.each([LEXICAL_SENSE_SCHEMA, LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA])("retains per-header membership for %s before row admission", async schema => {
  const sql = await listingQuery(schema);
  expect(sql).not.toContain("evidence_ids <@");
  expect(sql).toContain("active_projection.key AS projection_key");
  expect(sql).toContain("allowed.projection_key=requested.projection_key AND allowed.evidence_id=requested.evidence_id");
  expect(sql).toContain("HAVING bool_and(allowed_id IS NOT NULL)");
  expect(sql).toContain("_members AS MATERIALIZED");
  expect(sql).toContain("WHERE computation_member.id=member.pattern_id");
  expect(sql).toContain("OFFSET 0");
  expect(sql).toMatch(/auxiliary_owner\.source_id=active_projection\.value_json->>'sourceId'[\s\S]*?OFFSET 0\)/u);
  expect(sql.indexOf("_eligible AS MATERIALIZED")).toBeLessThan(sql.indexOf("candidate_pool AS MATERIALIZED"));
  if (schema === LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA) expect(sql).toContain("qa_header.pattern_id=pattern.id");
});

const configPath = process.env.SCCE_MEMBERSHIP_READONLY_CONFIG;
describe.skipIf(!configPath)("read-only PostgreSQL production membership fragments", () => {
  let pool: Pool, client: PoolClient;
  beforeAll(async () => {
    const config = JSON.parse(await readFile(configPath!, "utf8")) as { database: { url: string; ssl?: boolean | { rejectUnauthorized?: boolean } } };
    pool = new Pool({ connectionString: config.database.url, ssl: config.database.ssl, max: 1 });
    client = await pool.connect(); await client.query("BEGIN READ ONLY"); await client.query("SET LOCAL statement_timeout='15s'");
    expect((await client.query("SHOW transaction_read_only")).rows[0]!.transaction_read_only).toBe("on");
  });
  afterAll(async () => { if (client) { await client.query("ROLLBACK"); client.release(); } if (pool) await pool.end(); });
  it("enforces real getter scope, evidence membership and row ACL through its production SQL", async () => {
    const call = await getterQuery(), param = call.params.length + 1;
    const prefix = `pattern_rows AS MATERIALIZED (SELECT * FROM jsonb_to_recordset($${param}::jsonb) AS pattern(id text,profile_id text,source_system text,pattern_schema text,component_recipe text,owned_source_version_id text,pattern_kind text,evidence_ids text[],information_label jsonb)),`;
    const sql = call.sql.replace("WITH selected_pattern", `WITH ${prefix}selected_pattern`).replaceAll('"fixture"."language_patterns"', "pattern_rows");
    for (const failure of ["none", "missing", "unrelated", "empty-allowed", "empty-member", "wrong-profile", "wrong-version", "wrong-system", "wrong-schema", "wrong-recipe", "wrong-kind", "denied-owner"]) {
      const params = structuredClone(call.params), pattern = { id: "pattern", profile_id: "profile", source_system: "workspace", pattern_schema: LEXICAL_SENSE_SCHEMA,
        component_recipe: LEXICAL_SENSE_RECIPE, owned_source_version_id: "version", pattern_kind: "semantic_role", evidence_ids: ["a", "a", "b"], information_label: label };
      if (failure === "missing") params[6] = ["a"];
      if (failure === "unrelated") pattern.evidence_ids = ["foreign"];
      if (failure === "empty-allowed") params[6] = [];
      if (failure === "empty-member") pattern.evidence_ids = [];
      if (failure === "wrong-profile") pattern.profile_id = "foreign";
      if (failure === "wrong-version") pattern.owned_source_version_id = "foreign";
      if (failure === "wrong-system") pattern.source_system = "foreign";
      if (failure === "wrong-schema") pattern.pattern_schema = "foreign" as typeof LEXICAL_SENSE_SCHEMA;
      if (failure === "wrong-recipe") pattern.component_recipe = "foreign" as typeof LEXICAL_SENSE_RECIPE;
      if (failure === "wrong-kind") pattern.pattern_kind = "foreign";
      if (failure === "denied-owner") pattern.information_label = { ...label, tenantId: "denied" };
      const rows = (await client.query(sql, [...params, JSON.stringify([pattern])])).rows;
      expect(rows.map(row => row.id), failure).toEqual(failure === "none" ? ["pattern"] : []);
    }
  });
  const cases = ["duplicates", "missing", "unrelated", "empty-allowed", "empty-member", "null-member", "wrong-owner", "wrong-profile", "wrong-system", "wrong-schema", "wrong-recipe", "wrong-kind", "split-headers", "wrong-inventory"];
  it.each([false, true])("matches exact legacy membership with a complete set join in production fragment (QA=%s)", async qa => {
    const schema = qa ? LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA : LEXICAL_SENSE_SCHEMA, recipe = qa ? CONTEXTUAL_QA_CONSTRUCTION_RECIPE : LEXICAL_SENSE_RECIPE;
    const sql = membershipSql(await listingQuery(schema), qa);
    for (const kind of cases) {
      const headers = [{ projection_key: "header-a", profile_id: "profile", source_system: qa ? "dialogue" : "workspace", pattern_schema: schema,
        projection_recipe: recipe, source_version_id: "version", pattern_ids: ["pattern"], source_dependencies: [{ evidenceIds: ["a", "a", "b"] }] }];
      const patterns = [{ id: "pattern", profile_id: "profile", source_system: headers[0]!.source_system, pattern_schema: schema, component_recipe: recipe,
        owned_source_version_id: "version", pattern_kind: "semantic_role", evidence_ids: ["a", "a", "b"] as Array<string | null>, information_label: label }];
      if (kind === "missing") headers[0]!.source_dependencies[0]!.evidenceIds = ["a"];
      if (kind === "unrelated") patterns[0]!.evidence_ids = ["foreign"];
      if (kind === "empty-allowed") headers[0]!.source_dependencies = [];
      if (kind === "empty-member") patterns[0]!.evidence_ids = [];
      if (kind === "null-member") patterns[0]!.evidence_ids = [null];
      if (kind === "wrong-owner") patterns[0]!.owned_source_version_id = "foreign";
      if (kind === "wrong-profile") patterns[0]!.profile_id = "foreign";
      if (kind === "wrong-system") patterns[0]!.source_system = "foreign";
      if (kind === "wrong-schema") patterns[0]!.pattern_schema = "foreign" as typeof schema;
      if (kind === "wrong-recipe") patterns[0]!.component_recipe = "foreign" as typeof recipe;
      if (kind === "wrong-kind") patterns[0]!.pattern_kind = "foreign";
      if (kind === "wrong-inventory") headers[0]!.pattern_ids = ["foreign"];
      if (kind === "split-headers") { headers[0]!.source_dependencies[0]!.evidenceIds = ["a"]; headers.push({ ...headers[0]!, projection_key: "header-b", source_dependencies: [{ evidenceIds: ["b"] }] }); }
      const params = [JSON.stringify(headers), JSON.stringify(patterns)];
      const before = (await client.query(sql.legacy, params)).rows, after = (await client.query(sql.next, params)).rows;
      expect(after, kind).toEqual(before);
      expect(after.map(row => row.pattern_id), kind).toEqual(kind === "duplicates" ? ["pattern"] : []);
    }
    const allowed = Array.from({ length: 4096 }, (_, index) => `evidence.${index}`);
    const headers = [{ projection_key: "large", profile_id: "profile", source_system: qa ? "dialogue" : "workspace", pattern_schema: schema,
      projection_recipe: recipe, source_version_id: "version", pattern_ids: Array.from({ length: 2048 }, (_, index) => `pattern.${index}`), source_dependencies: [{ evidenceIds: allowed }] }];
    const patterns = headers[0]!.pattern_ids.map((id, index) => ({ id, profile_id: "profile", source_system: headers[0]!.source_system, pattern_schema: schema,
      component_recipe: recipe, owned_source_version_id: "version", pattern_kind: "semantic_role", evidence_ids: [allowed[index]!, allowed[index + 1]!], information_label: label }));
    const params = [JSON.stringify(headers), JSON.stringify(patterns)];
    const nextStarted = performance.now(), nextRows = (await client.query(sql.next, params)).rows, nextMs = performance.now() - nextStarted;
    const legacyStarted = performance.now(), legacyRows = (await client.query(sql.legacy, params)).rows, legacyMs = performance.now() - legacyStarted;
    expect(nextRows).toEqual(legacyRows);
    const explain = (await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql.next}`, params)).rows[0]!["QUERY PLAN"] as JsonValue;
    checkFullMembershipPlan(explain);
    const expanded = explainNodes((explain as unknown as Array<{ Plan: ExplainNode }>)[0]!.Plan)
      .find(node => node["Subplan Name"]?.endsWith("_members"))!;
    expect(expanded["Actual Rows"]).toBe(patterns.length);
    expect(explainNodes(expanded).find(node => node["Function Name"] === "jsonb_array_elements_text")!["Actual Loops"]).toBe(headers.length);
    await client.query("SET LOCAL enable_hashjoin=off");
    const mergeExplain = (await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql.next}`, params)).rows[0]!["QUERY PLAN"];
    expect(checkFullMembershipPlan(mergeExplain)).toBe("Merge Join");
    await client.query("SET LOCAL enable_hashjoin=on");
    const prepared = `projection_membership_${qa ? "qa" : "lexical"}`;
    await client.query(`PREPARE ${prepared}(jsonb,jsonb) AS ${sql.next}`);
    await client.query("SET LOCAL plan_cache_mode=force_generic_plan");
    const literal = (value: string) => `'${value.replaceAll("'", "''")}'::jsonb`;
    const execute = `EXECUTE ${prepared}(${params.map(literal).join(",")})`;
    const genericExplain = (await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${execute}`)).rows[0]!["QUERY PLAN"];
    checkFullMembershipPlan(genericExplain);
    await client.query(`DEALLOCATE ${prepared}`);
    await client.query("SET LOCAL enable_hashjoin=off");
    await client.query(`PREPARE ${prepared}(jsonb,jsonb) AS ${sql.next}`);
    const genericMergeExplain = (await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${execute}`)).rows[0]!["QUERY PLAN"];
    expect(checkFullMembershipPlan(genericMergeExplain)).toBe("Merge Join");
    await client.query("SET LOCAL enable_hashjoin=on");
    await client.query("SET LOCAL plan_cache_mode=auto");
    await client.query(`DEALLOCATE ${prepared}`);
    console.info(JSON.stringify({ membershipComparison: qa ? "contextualQa" : "lexical", patterns: patterns.length, allowedEvidence: allowed.length,
      nextMs: Math.round(nextMs), legacyMs: Math.round(legacyMs), matchingIds: nextRows.length, fullSetJoin: true }));
  });
});
