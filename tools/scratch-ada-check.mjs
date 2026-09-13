import { readFileSync } from "node:fs";
if (!process.env.SCCE_DATABASE_URL) {
  process.env.SCCE_DATABASE_URL = JSON.parse(readFileSync("scce.config.local.json", "utf8")).database.url;
}
const { default: pg } = await import("../node_modules/.pnpm/pg@8.22.0/node_modules/pg/lib/index.js");
const client = new pg.Client({ connectionString: process.env.SCCE_DATABASE_URL });
await client.connect();
await client.query("set statement_timeout to '60s'");
const rows = await client.query(
  `select text_content from scce3_runtime.evidence_spans where provenance_json->>'title' = 'Ada Lovelace' and status='promoted' order by char_start limit 15`
);
for (const row of rows.rows) console.log("---\n" + String(row.text_content).slice(0, 250));
await client.end();
