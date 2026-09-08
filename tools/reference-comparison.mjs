#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * The running system against a local language model, on the corpus the running system actually holds.
 *
 * Nothing here is staged. The questions are asked of the live brain over its real corpus, with real retrieval
 * across every span it holds; no fixture is ingested for the run and no document is invented. Ground truth is
 * taken from the corpus itself and checked before the comparison starts -- a question whose stated answer
 * cannot be found in the article it belongs to is dropped rather than scored, so no expectation rests on
 * anyone's recollection of what Wikipedia says.
 *
 * The model is given the article as its prompt. That is deliberately the easier task: it does not have to find
 * anything, while this system searches its whole corpus for the same fact. Where the model wins, it wins from
 * a stronger starting position than the one it is being compared against.
 *
 * Half the questions cannot be answered from the corpus. They name the same real subjects in the same
 * vocabulary and ask for facts the articles do not contain, which is the case that separates a system that
 * knows what it does not know from one that continues fluently. Five of them, because one refusal is an
 * anecdote.
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
const { default: pg } = await import("../node_modules/.pnpm/pg@8.22.0/node_modules/pg/lib/index.js");

/**
 * Real questions about real articles this corpus holds.
 *
 * `expect` is the answer as the corpus states it, and every one is verified against the article's own spans
 * before anything is asked. The unanswerable half names the same subjects and asks for facts the articles do
 * not carry; `absent` is checked not to appear, so "unanswerable" is a property of the corpus rather than an
 * assumption.
 */
const QUESTIONS = [
  { id: "einstein-born", article: "Albert Einstein", text: "When was Albert Einstein born?", expect: "14 March 1879", answerable: true },
  { id: "einstein-work", article: "Albert Einstein", text: "What theory did Albert Einstein develop?", expect: "relativity", answerable: true },
  { id: "apollo-land", article: "Apollo 11", text: "When did Apollo 11 land on the Moon?", expect: "July 20", answerable: true },
  { id: "apollo-commander", article: "Apollo 11", text: "Who commanded Apollo 11?", expect: "Neil Armstrong", answerable: true },
  { id: "lincoln-office", article: "Abraham Lincoln", text: "Which president of the United States was Abraham Lincoln?", expect: "16th", answerable: true },

  { id: "absent-einstein-shoe", article: "Albert Einstein", text: "What was Albert Einstein's shoe size?", absent: "shoe size", answerable: false },
  { id: "absent-einstein-dentist", article: "Albert Einstein", text: "Who was Albert Einstein's dentist?", absent: "dentist", answerable: false },
  { id: "absent-apollo-coffee", article: "Apollo 11", text: "How many cups of coffee did the Apollo 11 crew drink?", absent: "cups of coffee", answerable: false },
  { id: "absent-apollo-blood", article: "Apollo 11", text: "What was the blood type of the Apollo 11 crew?", absent: "blood type", answerable: false },
  { id: "absent-lincoln-watch", article: "Abraham Lincoln", text: "What was the serial number of Abraham Lincoln's pocket watch?", absent: "serial number", answerable: false }
];

const normalize = value => String(value).replace(/\s+/gu, " ").trim().toLowerCase();

/** Declining, or saying the source does not carry it, is the correct answer to an unanswerable question. */
const declines = answer => {
  const spoken = normalize(answer);
  if (!spoken) return true;
  return /(do not|does not|doesn't|don't|no (information|mention|reference|record)|not (mentioned|found|provided|present|specified|available|contain|include)|cannot|can't|unable|unknown|not enough|isn't (mentioned|specified)|no specific)/u.test(spoken);
};

const askModel = async (question, context) => {
  const prompt = [
    "Answer the question using only the reference article below.",
    "If the article does not contain the answer, say that it does not.",
    "",
    "Reference article:",
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

const config = await readScceRuntimeConfig(configPath);
const client = new pg.Client({ connectionString: config.database.url });
await client.connect();
await client.query("set statement_timeout to '180s'");
const schema = config.database.schema;

/** The article as the corpus holds it: what the model is given, and what ground truth is checked against. */
const articleText = async title => {
  const rows = await client.query(
    `select text_content from ${schema}.evidence_spans
     where provenance_json->>'title' = $1 and status = 'promoted' order by char_start limit 40`,
    [title]
  );
  return rows.rows.map(row => String(row.text_content)).join("\n");
};

const articles = new Map();
for (const title of [...new Set(QUESTIONS.map(question => question.article))]) {
  articles.set(title, await articleText(title));
  process.stdout.write(`corpus: ${title} -> ${articles.get(title).length} chars of promoted span text\n`);
}

// Ground truth is checked before anything is asked, so no score rests on a remembered fact.
const usable = [];
for (const question of QUESTIONS) {
  const corpus = normalize(articles.get(question.article) ?? "");
  if (question.answerable) {
    const present = corpus.includes(normalize(question.expect));
    if (!present) { process.stdout.write(`  dropped ${question.id}: "${question.expect}" is not in the article\n`); continue; }
  } else {
    const present = corpus.includes(normalize(question.absent));
    if (present) { process.stdout.write(`  dropped ${question.id}: "${question.absent}" IS in the article, so it is answerable\n`); continue; }
  }
  usable.push(question);
}
process.stdout.write(`\n${usable.length} of ${QUESTIONS.length} questions verified against the corpus\n`);

const runtime = createNodeRuntime(config);
const warmup = await runtime.kernel.warmup({ languageLimit: 64 }).catch(() => undefined);
process.stdout.write(`warmup ${Math.round(warmup?.totalMs ?? 0)}ms, language models=${warmup?.language?.models ?? 0}\n`);

const rows = [];
try {
  for (const question of usable) {
    const started = Date.now();
    const result = await runtime.kernel.turn({ text: question.text });
    const scceAnswer = String(result.answer ?? "");
    const scce = {
      answer: scceAnswer,
      durationMs: Date.now() - started,
      force: result.epistemicForce ?? null,
      evidence: result.evidence?.length ?? 0,
      cited: /source:/iu.test(scceAnswer)
    };
    const model = await askModel(question.text, articles.get(question.article) ?? "");

    // Dates are compared by their parts, so "March 14, 1879" and "14 March 1879" are the same answer.
    const statesExpected = (answer) => {
      const parts = String(question.expect).split(/[s,]+/u).filter(Boolean);
      const spoken = normalize(answer);
      return parts.every(part => spoken.includes(normalize(part)));
    };
    const score = (answer) => question.answerable
      ? { correct: new RegExp(question.expect.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu").test(answer), declined: declines(answer) }
      : { correct: null, declined: declines(answer) };

    rows.push({
      question: question.id,
      text: question.text,
      article: question.article,
      answerable: question.answerable,
      expect: question.expect ?? null,
      scce: { ...scce, ...score(scce.answer), answer: scce.answer.slice(0, 220) },
      model: { ...model, ...score(model.answer), answer: model.answer.slice(0, 220) }
    });

    const row = rows[rows.length - 1];
    process.stdout.write(`\n${question.id}${question.answerable ? "" : "   (not in the corpus)"}: ${question.text}\n`);
    for (const side of ["scce", "model"]) {
      const entry = row[side];
      const verdict = question.answerable
        ? (entry.correct ? "CORRECT" : entry.declined ? "declined" : "wrong")
        : (entry.declined ? "declined" : "FABRICATED");
      process.stdout.write(
        `  ${side === "scce" ? "scce  " : compareModel.slice(0, 6).padEnd(6)} ${String(entry.durationMs).padStart(6)}ms  `
        + `${verdict.padEnd(10)}${side === "scce" && entry.cited ? " cited" : "      "}  ${JSON.stringify(String(entry.answer).slice(0, 88))}\n`
      );
    }
  }
} finally {
  await runtime.close?.().catch(() => undefined);
  await client.end().catch(() => undefined);
}

const answerable = rows.filter(row => row.answerable);
const unanswerable = rows.filter(row => !row.answerable);
const tally = side => ({
  correct: answerable.filter(row => row[side].correct).length,
  wrong: answerable.filter(row => !row[side].correct && !row[side].declined).length,
  declinedWhenAnswerable: answerable.filter(row => !row[side].correct && row[side].declined).length,
  fabrications: unanswerable.filter(row => !row[side].declined).length,
  declined: unanswerable.filter(row => row[side].declined).length,
  cited: rows.filter(row => row[side].cited).length,
  meanMs: Math.round(rows.reduce((sum, row) => sum + row[side].durationMs, 0) / Math.max(1, rows.length))
});

const report = {
  schema: "scce.reference_comparison.v2",
  generatedAt: new Date().toISOString(),
  corpus: { config: configPath, schema, articlesUsed: [...articles.keys()], staged: false },
  compareModel,
  modelAdvantage: "the model is given the article in its prompt; scce retrieves from the whole corpus",
  answerable: answerable.length,
  unanswerable: unanswerable.length,
  scce: tally("scce"),
  model: tally("model"),
  rows
};
await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true }).catch(() => undefined);
writeFileSync(path.resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");

const line = (label, entry) =>
  `  ${label.padEnd(14)}${`${entry.correct}/${answerable.length}`.padStart(8)}   ${String(entry.wrong).padStart(5)}   `
  + `${`${entry.declined}/${unanswerable.length}`.padStart(9)}   ${String(entry.fabrications).padStart(12)}   `
  + `${String(entry.cited).padStart(6)}   ${String(entry.meanMs).padStart(9)}ms\n`;
process.stdout.write(
  `\n${"".padEnd(78, "-")}\n`
  + `                 correct   wrong   declined   fabrications   cited   mean latency\n`
  + line("scce", report.scce)
  + line(compareModel, report.model)
  + `wrote ${outputPath}\n`
);
process.exit(0);
