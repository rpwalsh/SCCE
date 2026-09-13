import { readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import pg from "./../packages/adapters-node/node_modules/pg/lib/index.js";

const cfg = JSON.parse(readFileSync("scce.config.local.json", "utf8"));
const url = cfg.database?.url ?? cfg.databaseUrl ?? process.env.SCCE_DATABASE_URL;
const client = new pg.Client({ connectionString: url });
await client.connect();
const sch = (await client.query("SELECT table_schema FROM information_schema.tables WHERE table_name = $1 AND table_schema IN (SELECT table_schema FROM information_schema.columns WHERE table_name=$1 AND column_name='source_title') ORDER BY table_schema LIMIT 1", ["evidence_spans"])).rows[0]?.table_schema;
await client.query(`SET search_path TO ${sch}, public`);
console.log("schema:", sch);

const { rows } = await client.query(
  `SELECT source_title, max(char_end) AS reach, count(*) AS spans
     FROM evidence_spans WHERE media_type IN ('text/x-source.ts','text/typescript')
    GROUP BY source_title`
);
await client.end();

// Repo files, keyed by the humanized title ingestion produces: basename minus extension, separators to spaces.
const files = execFileSync("git", ["ls-files", "*.ts", "*.tsx"], { encoding: "utf8" }).split("\n").filter(Boolean);
const byTitle = new Map();
for (const f of files) {
  const base = f.split("/").pop().replace(/\.tsx?$/, "");
  const title = base.replace(/[-_.]+/g, " ").trim();
  if (!byTitle.has(title)) byTitle.set(title, []);
  byTitle.get(title).push(f);
}

let matched = 0, truncated = 0, complete = 0, missingChars = 0, totalChars = 0;
const worst = [];
for (const r of rows) {
  const cand = byTitle.get(r.source_title);
  if (!cand) continue;
  const size = Math.max(...cand.map(f => { try { return statSync(f).size; } catch { return 0; } }));
  if (!size) continue;
  matched++; totalChars += size;
  const reach = Number(r.reach);
  const missing = Math.max(0, size - reach);
  missingChars += missing;
  if (missing > size * 0.05) { truncated++; worst.push({ title: r.source_title, size, reach, pct: reach / size }); }
  else complete++;
}
worst.sort((a, b) => a.pct - b.pct);
console.log(`ingested TS titles matched to repo files: ${matched}`);
console.log(`  complete (>=95% reached): ${complete}`);
console.log(`  truncated               : ${truncated}  (${(100 * truncated / matched).toFixed(1)}%)`);
console.log(`bytes in those files      : ${totalChars.toLocaleString()}`);
console.log(`bytes never ingested      : ${missingChars.toLocaleString()}  (${(100 * missingChars / totalChars).toFixed(1)}%)`);
console.log("\nworst 12 by fraction reached:");
for (const w of worst.slice(0, 12)) console.log(`  ${(100 * w.pct).toFixed(1).padStart(5)}%  ${String(w.reach).padStart(7)} / ${String(w.size).padStart(7)}  ${w.title}`);
