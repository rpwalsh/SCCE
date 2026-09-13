import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import pg from "./../packages/adapters-node/node_modules/pg/lib/index.js";

const SYMBOLS = ["bestEvidenceSentences","codeRequestSignal","deriveClosedClassWords","replan","syncTaskResumptionSnapshotForTurn","createProgramPlanner"];
const KINDS = ["function ","const ","class ","interface ","type ","enum "];
const isWord = c => c !== undefined && /[A-Za-z0-9_$]/.test(c);

const cfg = JSON.parse(readFileSync("scce.config.local.json","utf8"));
const client = new pg.Client({ connectionString: cfg.database?.url ?? cfg.databaseUrl ?? process.env.SCCE_DATABASE_URL });
await client.connect();
await client.query("SET search_path TO scce3_runtime, public");

const files = execFileSync("git",["ls-files","*.ts","*.tsx"],{encoding:"utf8"}).split("\n").filter(Boolean);
const cache = new Map();
for (const f of files) { try { cache.set(f, readFileSync(f,"utf8")); } catch {} }

for (const sym of SYMBOLS) {
  const hits = [];
  for (const [f, s] of cache) {
    for (const kind of KINDS) {
      const needle = kind + sym;
      let i = s.indexOf(needle);
      while (i >= 0) {
        if (!isWord(s[i + needle.length])) { hits.push({ file: f, at: i }); i = -1; break; }
        i = s.indexOf(needle, i + 1);
      }
      if (hits.length && hits[hits.length-1].file === f) break;
    }
  }
  if (!hits.length) { console.log(`${sym}: NO DEFINITION FOUND IN REPO`); continue; }
  for (const h of hits) {
    const size = cache.get(h.file).length;
    const title = h.file.split("/").pop().replace(/.tsx?$/,"").replace(/[-_.]+/g," ").trim();
    const { rows } = await client.query(
      "SELECT max(char_end) AS reach, count(*) AS spans FROM evidence_spans WHERE source_title = $1 AND media_type IN ('text/x-source.ts','text/typescript')", [title]);
    const reach = Number(rows[0]?.reach ?? 0), spans = Number(rows[0]?.spans ?? 0);
    const verdict = spans === 0 ? "FILE NOT INGESTED" : (h.at < reach ? "REACHABLE" : "PAST INGESTED END");
    console.log(`${sym.padEnd(34)} ${h.file}`);
    console.log(`   def at ${String(h.at).padStart(7)} of ${String(size).padStart(7)} | title "${title}" reach ${String(reach).padStart(7)} (${spans} spans) -> ${verdict}`);
  }
}
await client.end();
