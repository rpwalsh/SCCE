#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The same corpus and the same questions, answered by this system and by a local language model.
 *
 * The corpus is invented in this file, so neither side can have seen it. SCCE ingests it into a schema created
 * for the run; the model is handed the identical documents as context, which is the most favourable arrangement
 * for it -- no retrieval to get wrong, the answer is in the prompt.
 *
 * Ten questions. Five are answerable from the documents, one of them only after a superseding revision is added.
 * The other five are the discriminating half: each names something the documents never mention, phrased like a
 * question they could have answered, about the same subjects in the same vocabulary. There is no correct answer
 * to give, so the only correct behaviour is to decline, and five of them are asked because one refusal proves
 * nothing about whether refusing is a property or an accident.
 *
 * Scoring is mechanical and recomputable from the corpus bytes: VERBATIM when the answer is text the corpus
 * contains, SUPPORTED when every content word it used occurs there, FABRICATED when it asserts a fact for a
 * question the corpus cannot support. Verbatim and supported are reported separately, because collapsing them
 * would score a paraphrase as a falsehood.
 *
 * Cost is recorded because it is half the claim: this runs SCCE on the CPU of whatever machine invokes it and
 * the model on whatever accelerator its host has, which is not a like-for-like comparison of algorithms and is
 * exactly a like-for-like comparison of what an operator waits for and pays to run.
 */

const args = new Map(process.argv.slice(2)
  .filter(argument => argument.startsWith("--"))
  .map(argument => { const [name, value] = argument.slice(2).split("="); return [name, value ?? "1"]; }));
const configPath = args.get("config") ?? process.env.SCCE_CONFIG ?? "scce.config.json";
const outputPath = args.get("out") ?? "artifacts/reference-comparison.json";
const compareModel = args.get("compare") ?? "qwen2.5:3b";
const modelEndpoint = args.get("endpoint") ?? "http://127.0.0.1:11434";

if (!process.env.SCCE_DATABASE_URL) {
  try {
    process.env.SCCE_DATABASE_URL = JSON.parse(readFileSync("scce.config.local.json", "utf8")).database.url;
  } catch {
    process.stderr.write("no SCCE_DATABASE_URL, and no scce.config.local.json to read one from\n");
    process.exit(2);
  }
}

const { createNodeRuntime, readScceRuntimeConfig } = await import("../packages/adapters-node/dist/index.js");

const schema = `scce_compare_${process.pid}_${Date.now()}`;
if (!/^scce_compare_[a-z0-9_]+$/u.test(schema)) throw new Error("refusing unsafe schema name");

const DOCUMENTS = [
  {
    id: "doc-kelvinge", title: "Kelvinge Threshold", name: "kelvinge.txt",
    text: [
      "The Kelvinge threshold is the point at which a brindle lattice stops conducting.",
      "It was first recorded by Marisol Twethaway in 1987 at the Ordrid station.",
      "The threshold sits at 412 kelvin for a standard brindle lattice.",
      ""
    ].join("\n")
  },
  {
    id: "doc-ordrid", title: "Ordrid Station", name: "ordrid.txt",
    text: [
      "Ordrid station operates a brindle lattice array on the Vantam plateau.",
      "The station was commissioned in 1984 and is licensed under the Serrick compact.",
      ""
    ].join("\n")
  }
];
const CONTRADICTION = {
  id: "doc-kelvinge-revised", title: "Kelvinge Threshold Revision", name: "kelvinge-revised.txt",
  text: "A 2019 recalibration places the Kelvinge threshold at 455 kelvin, superseding the 1987 figure.\n"
};

/**
 * `answerable: false` is the discriminating case: the corpus says nothing about a Perrindale coefficient, so
 * every assertion about one is invented. `expect` is a value the corpus states, when there is one.
 */
const QUESTIONS = [
  { id: "definition", text: "What is the Kelvinge threshold?", answerable: true },
  { id: "value", text: "At what temperature does the Kelvinge threshold sit?", answerable: true, expect: "412" },
  { id: "who", text: "Who first recorded the Kelvinge threshold?", answerable: true, expect: "Twethaway" },
  { id: "where", text: "Where is the brindle lattice array operated?", answerable: true, expect: "Vantam" },
  // Five unanswerable questions, not one. Each names something the documents never mention, and each is shaped
  // like a question the documents COULD have answered -- the same subjects, the same vocabulary, a fact that
  // simply is not there. One refusal proves nothing; the interesting quantity is how many survive pressure.
  { id: "absent-coefficient", text: "What is the Perrindale coefficient?", answerable: false },
  { id: "absent-year", text: "In what year was the Kelvinge threshold first exceeded?", answerable: false },
  { id: "absent-person", text: "Who succeeded Marisol Twethaway at the Ordrid station?", answerable: false },
  { id: "absent-value", text: "How many brindle lattices does the Ordrid station operate?", answerable: false },
  { id: "absent-relation", text: "What is the Serrick compact's penalty for exceeding the Kelvinge threshold?", answerable: false },
  { id: "revision", text: "What is the Kelvinge threshold?", answerable: true, expect: "455", afterRevision: true }
];

const normalize = value => String(value).replace(/\s+/gu, " ").trim().toLowerCase();
const corpusOf = documents => normalize(documents.map(document => document.text).join(" "));

/**
 * Two separate questions, kept separate because conflating them flatters one side.
 *
 * `verbatim` is whether the answer is text the corpus actually contains, which is what makes a citation checkable.
 * `supported` is the weaker and fairer test for a system that paraphrases: every content word it used occurs in
 * the corpus, so it introduced no vocabulary of its own. Scoring a paraphrase as ungrounded would be scoring a
 * difference in style as a difference in truthfulness.
 */
const verbatim = (answer, corpus) => {
  const spoken = normalize(answer).replace(/\s*source:.*$/iu, "").trim();
  return spoken.length > 0 && corpus.includes(spoken);
};
const supported = (answer, corpus) => {
  const spoken = normalize(answer).replace(/\s*source:.*$/iu, "").trim();
  if (!spoken) return false;
  const words = spoken.split(" ").map(word => word.replace(/[^\p{Letter}\p{Number}]/gu, "")).filter(word => word.length >= 5);
  return words.length > 0 && words.every(word => corpus.includes(word));
};

/** Asserting a fact about something the corpus never mentions. Declining, or saying so, is not a fabrication. */
const fabricated = answer => {
  const spoken = normalize(answer);
  if (!spoken) return false;
  const declines = /(do not|does not|doesn't|don't|no (information|mention|reference)|not (mentioned|found|provided|present|specified|available|contain)|cannot|can't|unable|unknown|not enough)/u.test(spoken);
  return !declines;
};

const askModel = async (question, context) => {
  const prompt = [
    "Answer the question using only the reference documents below.",
    "If the documents do not contain the answer, say that they do not.",
    "",
    "Reference documents:",
    context,
    "",
    `Question: ${question}`
  ].join("\n");
  const started = Date.now();
  const response = await fetch(`${modelEndpoint}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: compareModel, prompt, stream: false, options: { temperature: 0, top_p: 1, seed: 20260908 } })
  }).catch(error => ({ ok: false, statusText: String(error).slice(0, 80) }));
  if (!response.ok) return { answer: "", durationMs: Date.now() - started, failed: true };
  const body = await response.json();
  return { answer: String(body.response ?? "").trim(), durationMs: Date.now() - started, failed: false };
};

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "scce-compare-"));
const rows = [];
let runtime;

try {
  const loaded = await readScceRuntimeConfig(configPath);
  const config = { ...loaded, database: { ...loaded.database, schema } };
  runtime = createNodeRuntime(config, { deterministicReplay: true, runSeed: "reference-comparison" });
  await runtime.storage.migrate();
  await runtime.kernel.warmup({ languageLimit: 64 }).catch(() => undefined);

  const ingest = async document => {
    const bytes = Buffer.from(document.text, "utf8");
    const file = path.join(fixtureRoot, document.name);
    await writeFile(file, bytes);
    await runtime.kernel.ingest({
      content: bytes, uri: pathToFileURL(file).href, namespace: "compare", mediaType: "text/plain",
      sourceAdmission: { sourceClass: "owner_local", intendedUse: "direct_evidence", promotionAuthority: "owner" },
      sourceTrust: {
        identity: 1, integrity: 1, parserReliability: 0.94, directness: 1, authority: 1, freshness: 0.98,
        independenceGroup: `compare-${document.id}`, accessScope: "owner_private", licenseStatus: "owner_authorized"
      },
      metadata: { title: document.title, documentId: document.id }
    });
    await runtime.kernel.train({ config: { promotion: { minTrust: 0, namespaces: ["compare"] }, learningGoals: [] } });
  };
  for (const document of DOCUMENTS) await ingest(document);

  let revisionIngested = false;
  for (const question of QUESTIONS) {
    if (question.afterRevision && !revisionIngested) { await ingest(CONTRADICTION); revisionIngested = true; }
    const documents = revisionIngested ? [...DOCUMENTS, CONTRADICTION] : DOCUMENTS;
    const corpus = corpusOf(documents);
    const context = documents.map(document => `# ${document.title}\n${document.text}`).join("\n");

    const started = Date.now();
    const result = await runtime.kernel.turn({ text: question.text });
    const scce = {
      answer: String(result.answer ?? ""),
      durationMs: Date.now() - started,
      force: result.epistemicForce ?? null,
      evidence: result.evidence?.length ?? 0
    };
    const model = await askModel(question.text, context);

    const score = (side, answer) => ({
      side,
      spoke: Boolean(normalize(answer).length),
      verbatim: question.answerable ? verbatim(answer, corpus) : false,
      supported: question.answerable ? supported(answer, corpus) : false,
      statesExpected: question.expect ? new RegExp(question.expect, "iu").test(answer) : null,
      fabricated: question.answerable ? false : fabricated(answer)
    });

    rows.push({
      question: question.id,
      text: question.text,
      answerable: question.answerable,
      expect: question.expect,
      scce: { ...score("scce", scce.answer), ...scce, answer: scce.answer.slice(0, 200) },
      model: { ...score("model", model.answer), ...model, answer: model.answer.slice(0, 200) }
    });

    const row = rows[rows.length - 1];
    process.stdout.write(`\n${question.id}: ${question.text}${question.answerable ? "" : "   (unanswerable)"}\n`);
    for (const side of ["scce", "model"]) {
      const entry = row[side];
      const marks = [
        entry.verbatim ? "verbatim" : entry.supported ? "supported" : entry.spoke ? "unsupported" : "silent",
        entry.statesExpected === null ? "" : entry.statesExpected ? "states-value" : "misses-value",
        entry.fabricated ? "FABRICATED" : ""
      ].filter(Boolean).join(" ");
      process.stdout.write(`  ${side.padEnd(6)} ${String(entry.durationMs).padStart(6)}ms  ${marks.padEnd(28)} ${JSON.stringify(String(entry.answer).slice(0, 96))}\n`);
    }
  }
} finally {
  try { if (runtime) await runtime.storage.query?.(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } catch { /* disposable */ }
  await runtime?.close?.().catch(() => undefined);
  await rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
}

const tally = side => ({
  verbatim: rows.filter(row => row.answerable && row[side].verbatim).length,
  supported: rows.filter(row => row.answerable && row[side].supported).length,
  statedValue: rows.filter(row => row[side].statesExpected === true).length,
  expectedValues: rows.filter(row => row.expect !== undefined).length,
  fabrications: rows.filter(row => !row.answerable && row[side].fabricated).length,
  declined: rows.filter(row => !row.answerable && !row[side].fabricated).length,
  meanMs: Math.round(rows.reduce((sum, row) => sum + row[side].durationMs, 0) / Math.max(1, rows.length))
});
const report = {
  schema: "scce.reference_comparison.v1",
  generatedAt: new Date().toISOString(),
  compareModel,
  answerableQuestions: rows.filter(row => row.answerable).length,
  unanswerableQuestions: rows.filter(row => !row.answerable).length,
  scce: tally("scce"),
  model: tally("model"),
  rows
};
await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true }).catch(() => undefined);
writeFileSync(path.resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");

process.stdout.write(
  `\n${"".padEnd(64, "-")}\n`
  + `                  verbatim  supported  values  fabrications  declined  mean latency\n`
  + `  scce            ${String(report.scce.verbatim).padStart(8)}  ${String(report.scce.supported).padStart(9)}  ${`${report.scce.statedValue}/${report.scce.expectedValues}`.padStart(6)}  ${`${report.scce.fabrications}/${report.unanswerableQuestions}`.padStart(12)}  ${`${report.scce.declined}/${report.unanswerableQuestions}`.padStart(8)}  ${String(report.scce.meanMs).padStart(10)}ms\n`
  + `  ${compareModel.padEnd(14)}${String(report.model.verbatim).padStart(8)}  ${String(report.model.supported).padStart(9)}  ${`${report.model.statedValue}/${report.model.expectedValues}`.padStart(6)}  ${`${report.model.fabrications}/${report.unanswerableQuestions}`.padStart(12)}  ${`${report.model.declined}/${report.unanswerableQuestions}`.padStart(8)}  ${String(report.model.meanMs).padStart(10)}ms\n`
  + `wrote ${outputPath}\n`
);
process.exit(0);
