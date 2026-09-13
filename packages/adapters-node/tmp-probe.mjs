import { readFileSync } from "node:fs";
import pg from "pg";

const root = "C:/Users/react/fuggit/.claude/worktrees/agent-a1a2b74f2a8fc73a8";
const local = JSON.parse(readFileSync(`${root}/scce.config.local.json`, "utf8"));
const schema = local.database?.schema ?? "scce3_runtime";
const client = new pg.Client({ connectionString: local.database.url });
await client.connect();
const q = `"${schema}"`;
const show = async (label, sql) => {
  try {
    const result = await client.query(sql);
    console.log(label, JSON.stringify(result.rows.slice(0, 8)).slice(0, 800));
  } catch (error) {
    console.log(label, "ERROR", error.message.slice(0, 140));
  }
};
await show("verdicts", `SELECT verdict, count(*)::int AS n, avg(coalesce(array_length(evidence_ids,1),0))::numeric(8,2) AS avg_ev FROM ${q}.semantic_proofs GROUP BY 1 ORDER BY 2 DESC`);
await show("proof_graph_keys", `SELECT DISTINCT jsonb_object_keys(proof_graph_json) AS k FROM ${q}.semantic_proofs LIMIT 20`);
await show("proof_graph_sample", `SELECT left(proof_graph_json::text, 500) AS sample FROM ${q}.semantic_proofs WHERE proof_graph_json IS NOT NULL LIMIT 1`);
await show("alpha_trace_keys", `SELECT DISTINCT jsonb_object_keys(trace_json) AS k FROM ${q}.alpha_traces LIMIT 20`);
await show("alpha_trace_sample", `SELECT left(trace_json::text, 500) AS sample FROM ${q}.alpha_traces LIMIT 1`);
await client.end();
