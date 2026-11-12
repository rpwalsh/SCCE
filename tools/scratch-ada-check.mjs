import { readFileSync } from "node:fs";
import { createCanonicalCorpusReader } from "./lib/canonical-corpus-read.mjs";
if (!process.env.SCCE_DATABASE_URL) {
  process.env.SCCE_DATABASE_URL = JSON.parse(readFileSync("scce.config.local.json", "utf8")).database.url;
}
const { default: pg } = await import("../node_modules/.pnpm/pg@8.22.0/node_modules/pg/lib/index.js");
const client = new pg.Client({ connectionString: process.env.SCCE_DATABASE_URL });
await client.connect();
await client.query("set statement_timeout to '60s'");
const corpus = createCanonicalCorpusReader(client, "scce3_runtime");
const rows = await client.query(
  `select content_hash,byte_start,byte_end,char_start,char_end from scce3_runtime.evidence_spans where provenance_json->>'title' = 'Ada Lovelace' and status='promoted' order by char_start limit 15`
);
for (const text of await corpus.evidenceTexts(rows.rows)) console.log("---\n" + text.slice(0, 250));
await client.end();
