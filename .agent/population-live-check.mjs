import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { createPostgresStorageAdapter } from "../packages/adapters-node/dist/postgres.js";
import { deriveClosedClassWords } from "../packages/kernel/dist/closed-class-words.js";

const base = JSON.parse(fs.readFileSync("scce.config.json", "utf8"));
const local = JSON.parse(fs.readFileSync("scce.config.local.json", "utf8"));
const adapter = createPostgresStorageAdapter({
  ...base.database, ...local.database,
  informationAccess: local.security?.informationAccess ?? base.security.informationAccess
});
const client = await adapter.pool.connect();
try {
  await client.query("BEGIN READ ONLY");
  await client.query("SET LOCAL statement_timeout = 60000");
  adapter.query = async (sql, params) => (await client.query(sql, params)).rows;
  const access = adapter.informationAccessPredicate("lp", 1);
  const languages = await adapter.query(
    `SELECT lp.language_id, COUNT(*)::int AS profiles
     FROM ${adapter.table("language_profiles")} lp
     WHERE lp.language_id IS NOT NULL AND ${access.sql}
     GROUP BY lp.language_id ORDER BY profiles DESC LIMIT 1`, access.params
  );
  const started = performance.now();
  const population = await adapter.languageMemory.continuationPopulation({ languageId: languages[0].language_id });
  const queryMs = performance.now() - started;
  const coldStart = performance.now();
  const words = deriveClosedClassWords({ continuationPopulation: population });
  const coldDeriveMs = performance.now() - coldStart;
  const warmStart = performance.now();
  for (let index = 0; index < 100; index++) deriveClosedClassWords({ continuationPopulation: population });
  const warm100Ms = performance.now() - warmStart;
  console.log(JSON.stringify({
    profiles: languages[0].profiles, modelCount: population?.modelCount,
    symbols: Object.keys(population?.continuationCounts ?? {}).length,
    queryMs, coldDeriveMs, warm100Ms,
    derivedCount: words.size, sample: [...words].slice(0, 12),
    rawRanks: Object.fromEntries(["which", "does", "born", "country", "dentist"].map(word => [word,
      Object.entries(population?.continuationCounts ?? {}).sort((a, b) => b[1] - a[1]).findIndex(([symbol]) => symbol === word) + 1
    ])),
    membership: Object.fromEntries(["which", "does", "born", "country", "dentist"].map(word => [word, words.has(word)]))
  }));
} finally {
  await client.query("ROLLBACK");
  client.release();
  await adapter.close();
}
