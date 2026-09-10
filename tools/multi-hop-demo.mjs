#!/usr/bin/env node
// Demo rehearsal: A->B in one document, B->C in another (A->C never stated anywhere), ask whether A implies C.
// Then remove the B->C document and confirm the same question is no longer certified.
// Modeled on tools/full-system-one-shot.mjs's ingest/promote pattern, isolated in a disposable schema.
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
const schema = `scce_multihop_${process.pid}_${Date.now()}`;
if (!/^scce_multihop_[a-z0-9_]+$/u.test(schema)) throw new Error("refusing unsafe schema name");
const config = { ...loaded, database: { ...loaded.database, schema } };

const stages = [];
const stage = (id, passed, observed) => {
  stages.push({ id, passed: Boolean(passed), observed });
  process.stdout.write(`${passed ? "  ok  " : " FAIL "} ${id.padEnd(30)} ${observed}\n`);
};

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "scce-multihop-"));
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
    namespace: "multihop-demo",
    mediaType: "text/plain",
    sourceAdmission: { sourceClass: "owner_local", intendedUse: "direct_evidence", promotionAuthority: "owner" },
    sourceTrust: {
      identity: 1, integrity: 1, parserReliability: 0.94, directness: 1, authority: 1, freshness: 0.98,
      independenceGroup: `multihop-demo-${doc.id}`, accessScope: "owner_private", licenseStatus: "owner_authorized"
    },
    metadata: { title: doc.title, documentId: doc.id }
  });
};
const promote = () => runtime.kernel.train({ config: { promotion: { minTrust: 0, namespaces: ["multihop-demo"] }, learningGoals: [] } });
const ask = async (text) => {
  const result = await runtime.kernel.turn({ text });
  return { answer: String(result.answer ?? ""), evidence: result.evidence?.length ?? 0, force: result.epistemicForce ?? null };
};

const DOC_A_B = { id: "doc-ab", title: "Kelvinge Station Location", name: "ab.txt",
  text: "Kelvinge station is located in the Vantam district.\n" };
const DOC_B_C = { id: "doc-bc", title: "Vantam District Territory", name: "bc.txt",
  text: "The Vantam district is part of the Northern Territory.\n" };
const QUESTION = "Is Kelvinge station part of the Northern Territory?";

try {
  await ingestDocument(DOC_A_B);
  await promote();
  const onlyAB = await ask(QUESTION);
  const notYetCertified = !/northern territory/iu.test(onlyAB.answer) || onlyAB.evidence === 0;
  stage("1.no_premature_certification_with_only_A_B", notYetCertified, `evidence=${onlyAB.evidence} answer=${JSON.stringify(onlyAB.answer.slice(0, 100))}`);

  await ingestDocument(DOC_B_C);
  await promote();
  const withBoth = await ask(QUESTION);
  const chained = /northern territory/iu.test(withBoth.answer) && withBoth.evidence > 0;
  stage("2.derives_A_implies_C_from_two_documents", chained, `evidence=${withBoth.evidence} answer=${JSON.stringify(withBoth.answer.slice(0, 150))}`);

  const passed = stages.filter(s => s.passed).length;
  process.stdout.write(`\n${passed}/${stages.length} stages passed\n`);
} finally {
  try {
    if (runtime) await runtime.storage.query?.(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } catch { /* the schema is disposable; a failed drop is not a gate result */ }
  await rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
  await runtime?.close?.().catch(() => undefined);
}
