const fs = require("fs");
const path = require("path");
const { Pool } = require("../packages/adapters-node/node_modules/pg");

const config = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "scce.config.local.json"), "utf8"));
const trackedConfig = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "scce.config.json"), "utf8"));
const schema = trackedConfig.database.schema;
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) throw new Error("invalid schema");
const pool = new Pool({ connectionString: config.database.url });

(async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = 30000");
    const populations = await client.query(
      `SELECT lp.language_id, COUNT(*)::int AS profiles
       FROM ${schema}.language_profiles lp
       WHERE lp.language_id IS NOT NULL
       GROUP BY lp.language_id
       ORDER BY profiles DESC
       LIMIT 12`
    );
    const models = await client.query(
      `SELECT id, stream_id, language_hint, pg_column_size(model_json)::int AS stored_bytes
       FROM ${schema}.ngram_models
       ORDER BY updated_at DESC
       LIMIT 12`
    );
    const languageId = populations.rows[0]?.language_id;
    const compactTop = languageId ? await client.query(
      `SELECT item->>0 AS symbol, SUM((item->>1)::bigint)::bigint AS contexts
       FROM ${schema}.language_profiles lp
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(lp.profile_json->'kneserNey'->'topContinuation', '[]'::jsonb)) item
       WHERE lp.language_id=$1
       GROUP BY item->>0
       ORDER BY contexts DESC, symbol
       LIMIT 110`,
      [languageId]
    ) : { rows: [] };
    const exactPlan = languageId ? await client.query(
      `EXPLAIN (FORMAT JSON)
       SELECT model.id
       FROM ${schema}.ngram_models model
       WHERE model.model_json->>'profileId'=ANY(ARRAY(
         SELECT lp.id FROM ${schema}.language_profiles lp WHERE lp.language_id=$1
       ))`,
      [languageId]
    ) : { rows: [] };
    const exactTop = languageId ? await client.query(
      `SELECT item.key AS symbol, SUM(item.value::bigint)::bigint AS contexts
       FROM ${schema}.ngram_models model
       CROSS JOIN LATERAL jsonb_each_text(COALESCE(model.model_json->'model'->'continuationCounts', '{}'::jsonb)) item
       WHERE model.model_json->>'profileId'=ANY(ARRAY(
         SELECT lp.id FROM ${schema}.language_profiles lp WHERE lp.language_id=$1
       ))
       GROUP BY item.key
       ORDER BY contexts DESC, symbol
       LIMIT 384`,
      [languageId]
    ) : { rows: [] };
    console.log(JSON.stringify({ populations: populations.rows, models: models.rows, compactTop: compactTop.rows, exactPlan: exactPlan.rows, exactTop: exactTop.rows }));
    await client.query("ROLLBACK");
  } finally {
    client.release();
    await pool.end();
  }
})().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
