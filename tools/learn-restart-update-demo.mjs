#!/usr/bin/env node
// Demo rehearsal: teach a fact, restart, confirm it survives, teach an update, confirm the answer changes.
// Modeled directly on tools/full-system-one-shot.mjs's ingest/promote/restart pattern (disposable schema, dropped after).
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (!process.env.SCCE_DATABASE_URL) {
  try {
    process.env.SCCE_DATABASE_URL = JSON.parse(readFileSync("scce.config.local.json", "utf8")).database.url;
  } catch {
    process.stderr.write("no SCCE_DATABASE_URL, and no scce.config.local.json to read one from\n");
    process.exit(2);
  }
}

const { createNodeRuntime, readScceRuntimeConfig } = await import("../packages/adapters-node/dist/index.js");
const loaded = await readScceRuntimeConfig("scce.config.json");
const schema = `scce_learnupdate_${process.pid}_${Date.now()}`;
if (!/^scce_learnupdate_[a-z0-9_]+$/u.test(schema)) throw new Error("refusing unsafe schema name");
const config = { ...loaded, database: { ...loaded.database, schema } };

const stages = [];
const stage = (id, passed, observed) => {
  stages.push({ id, passed: Boolean(passed), observed });
  process.stdout.write(`${passed ? "  ok  " : " FAIL "} ${id.padEnd(30)} ${observed}\n`);
};

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "scce-learn-update-"));
let runtime = createNodeRuntime(config);
await runtime.storage.migrate();
await runtime.kernel.warmup({ languageLimit: 64 }).catch(() => undefined);

const ingestDocument = async (doc) => {
  const bytes = Buffer.from(doc.text, "utf8");
  const file = path.join(fixtureRoot, doc.name);
  await writeFile(file, bytes);
  return runtime.kernel.ingest({
    content: bytes,
    uri: pathToFileURL(file).href,
    namespace: "learn-update-demo",
    mediaType: "text/plain",
    sourceAdmission: { sourceClass: "owner_local", intendedUse: "direct_evidence", promotionAuthority: "owner" },
    sourceTrust: {
      identity: 1, integrity: 1, parserReliability: 0.94, directness: 1, authority: 1, freshness: 0.98,
      independenceGroup: `learn-update-demo-${doc.id}`, accessScope: "owner_private", licenseStatus: "owner_authorized"
    },
    metadata: { title: doc.title, documentId: doc.id }
  });
};
const promote = () => runtime.kernel.train({ config: { promotion: { minTrust: 0, namespaces: ["learn-update-demo"] }, learningGoals: [] } });
const ask = async (text) => {
  const result = await runtime.kernel.turn({ text });
  return { answer: String(result.answer ?? ""), evidence: result.evidence?.length ?? 0, force: result.epistemicForce ?? null };
};

const QUESTION = "Who is the lead engineer on Project Atlas?";

try {
  const before = await ask(QUESTION);
  stage("1.unknown_before_teaching", before.evidence === 0, `evidence=${before.evidence} answer=${JSON.stringify(before.answer.slice(0, 80))}`);

  await ingestDocument({ id: "doc-zephyr", title: "Project Atlas Staffing", name: "zephyr.txt",
    text: "Zephyr is the lead engineer on Project Atlas.\nZephyr joined Project Atlas in 2024.\n" });
  await promote();
  const afterTeach = await ask(QUESTION);
  const knowsZephyr = /zephyr/iu.test(afterTeach.answer);
  stage("2.knows_after_teaching", knowsZephyr, `answer=${JSON.stringify(afterTeach.answer.slice(0, 100))}`);

  await runtime.close?.();
  runtime = createNodeRuntime(config);
  await runtime.kernel.warmup({ languageLimit: 64 }).catch(() => undefined);
  const afterRestart = await ask(QUESTION);
  const stillKnows = /zephyr/iu.test(afterRestart.answer);
  stage("3.remembers_after_restart", stillKnows, `answer=${JSON.stringify(afterRestart.answer.slice(0, 100))}`);

  await ingestDocument({ id: "doc-maya", title: "Project Atlas Staffing Update", name: "maya.txt",
    text: "Zephyr left Project Atlas in 2026.\nMaya is now the lead engineer on Project Atlas.\nMaya replaced Zephyr as lead engineer on Project Atlas.\n" });
  await promote();
  const afterUpdate = await ask(QUESTION);
  const nowMaya = /maya/iu.test(afterUpdate.answer);
  stage("4.answer_updates_after_new_teaching", nowMaya, `answer=${JSON.stringify(afterUpdate.answer.slice(0, 100))}`);

  const passed = stages.filter(s => s.passed).length;
  process.stdout.write(`\n${passed}/${stages.length} stages passed\n`);
} finally {
  try {
    if (runtime) await runtime.storage.query?.(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } catch { /* the schema is disposable; a failed drop is not a gate result */ }
  await rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
  await runtime?.close?.().catch(() => undefined);
}
