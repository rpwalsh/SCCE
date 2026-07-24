import pg from "pg";
import { anchorFeatureSet } from "../../kernel/dist/primitives.js";

const databaseUrl = process.env.SCCE_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("SCCE_DATABASE_URL is required");

const schema = process.env.SCCE_POSTGRES_SCHEMA?.trim() || "scce3_runtime";
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) throw new Error("SCCE_POSTGRES_SCHEMA must be a safe PostgreSQL identifier");

const batchSize = boundedInteger(process.env.SCCE_EVIDENCE_ANCHOR_BATCH_SIZE, 250, 25, 1000);
const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

let cursor = "";
let scanned = 0;
let updated = 0;

try {
  while (true) {
    const result = await client.query(
      `SELECT id, text_preview, features
       FROM ${schema}.evidence_spans
       WHERE id > $1
       ORDER BY id
       LIMIT $2`,
      [cursor, batchSize]
    );
    if (!result.rows.length) break;
    const payload = result.rows.map(row => {
      const anchors = anchorFeatureSet(String(row.text_preview ?? ""), 256);
      const existing = new Set((row.features ?? []).map(String));
      return {
        id: String(row.id),
        anchors,
        missingAnchors: anchors.filter(feature => !existing.has(feature))
      };
    });
    const featureUpdates = payload.filter(row => row.missingAnchors.length);
    if (featureUpdates.length) {
      await client.query(
        `UPDATE ${schema}.evidence_spans AS evidence
         SET features = ARRAY(
           SELECT DISTINCT feature
           FROM unnest(
              evidence.features || ARRAY(
               SELECT jsonb_array_elements_text(item.missing_anchors)
             )
           ) AS merged(feature)
           ORDER BY feature
         )
         FROM jsonb_to_recordset($1::jsonb) AS item(id text, missing_anchors jsonb)
         WHERE evidence.id = item.id`,
        [JSON.stringify(featureUpdates.map(row => ({ id: row.id, missing_anchors: row.missingAnchors })))]
      );
    }
    await client.query(
      `INSERT INTO ${schema}.evidence_anchor_index AS anchor_index(evidence_id,features)
       SELECT item.id,
              ARRAY(
                SELECT anchor
                FROM jsonb_array_elements_text(item.anchors) AS anchor
                ORDER BY anchor
              )
       FROM jsonb_to_recordset($1::jsonb) AS item(id text, anchors jsonb)
       WHERE jsonb_array_length(item.anchors)>0
       ON CONFLICT(evidence_id) DO UPDATE SET
         features=ARRAY(
           SELECT DISTINCT anchor
           FROM unnest(anchor_index.features || EXCLUDED.features) AS anchor
           ORDER BY anchor
         )`,
      [JSON.stringify(payload)]
    );
    cursor = String(result.rows.at(-1).id);
    scanned += result.rows.length;
    updated += featureUpdates.length;
    if (scanned % 1000 < batchSize) {
      process.stdout.write(`evidence-anchor backfill scanned=${scanned} updated=${updated} cursor=${cursor}\n`);
    }
  }
  await client.query(`VACUUM (ANALYZE) ${schema}.evidence_anchor_index`);
} finally {
  await client.end();
}

process.stdout.write(`evidence-anchor backfill complete scanned=${scanned} updated=${updated}\n`);

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}
