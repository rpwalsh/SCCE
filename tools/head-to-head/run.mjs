#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Head-to-head suite: SCCE against a local language model on the same items, with the cost each one paid.
//
// Each item is asked of SCCE first and then of the model, never concurrently, and each ask sits between two samples
// of the answering process's own CPU time (cost-meter.mjs). An idle window before the run records how much each
// process burns doing nothing, so background load is visible rather than silently charged to an answer.
//
// Workloads (v1): wiki-factual and wiki-abstention from tools/datasets/wiki-qa.json, and the cognitive-state tasks.
// The model is given the top retrieved chunks of the same article by default (retrieval plus a model, the system SCCE
// is an alternative to); --model-context=article gives it the whole article instead.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { metered, ollamaTokenCost, processCpuSeconds, thermalReading } from "./cost-meter.mjs";

const args = new Map(process.argv.slice(2).filter(argument => argument.startsWith("--")).map(argument => {
  const at = argument.indexOf("=");
  return at < 0 ? [argument.slice(2), "true"] : [argument.slice(2, at), argument.slice(at + 1)];
}));
const serverUrl = args.get("server") ?? "http://127.0.0.1:3873";
const endpoint = args.get("endpoint") ?? "http://127.0.0.1:11434";
const model = args.get("model") ?? "qwen2.5:3b";
const workloadFilter = args.has("workloads") ? new Set(args.get("workloads").split(",")) : undefined;
const limit = args.has("limit") ? Number(args.get("limit")) : Infinity;
const outPath = args.get("out") ?? "artifacts/head-to-head/run.json";
const wattsPerBusyCore = Number(args.get("watts-per-core") ?? 12);
const modelContextMode = args.get("model-context") ?? "retrieved";
const retrievedChunks = Number(args.get("retrieved-k") ?? 3);
const skipModel = args.has("scce-only");
const scceProcess = { commandLineIncludes: ["server/dist/index.js"] };
const modelProcess = { names: ["ollama*"] };

const normalize = value => String(value ?? "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const declinePattern = /(do not|does not|doesn't|don't|no (information|mention|reference|record|grounded source)|not (mentioned|found|provided|present|specified|available|contain|include)|cannot|can't|unable|unknown|not enough|isn't (mentioned|specified)|no specific)/u;

async function askScce(text, sessionId) {
  const response = await fetch(`${serverUrl}/api/turn?full=1`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, ...(sessionId ? { sessionId } : {}) })
  }).catch(error => ({ ok: false, status: 0, text: async () => String(error) }));
  const body = await response.text();
  if (response.status === 422) return { answer: "", declined: true };
  if (!response.ok) return { answer: "", declined: false, error: `${response.status} ${body.slice(0, 120)}` };
  const parsed = JSON.parse(body);
  const answer = String(parsed.answer ?? "");
  return { answer, declined: !answer.trim() || parsed.assistantForce === "insufficient_support", scceTiming: parsed.timing?.resourceUsage ?? null };
}

async function askModel(prompt) {
  const response = await fetch(`${endpoint}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0, top_p: 1, seed: 20260911 } })
  }).catch(error => ({ ok: false, json: async () => ({ error: String(error) }) }));
  const body = await response.json();
  if (!response.ok) return { answer: "", declined: false, error: String(body.error ?? "model request failed"), tokens: null };
  const answer = String(body.response ?? "").trim();
  return { answer, declined: declinePattern.test(answer.toLocaleLowerCase()), tokens: ollamaTokenCost(body) };
}

/** Article chunks from the live corpus, in document order, for the model's context. */
async function articleChunks(client, schema, title) {
  const uriTail = `/${encodeURIComponent(title.replace(/ /gu, "_"))}`;
  const rows = await client.query(
    `select es.text_content from ${schema}.evidence_spans es join ${schema}.sources s on s.id = es.source_id
     where s.canonical_uri like 'wikipedia://%' and s.canonical_uri like $1 and es.status = 'promoted'
     order by es.char_start limit 40`, [`%${uriTail}`]);
  return rows.rows.map(row => String(row.text_content));
}

/** BM25 over one article's chunks: the reference retriever the model is paired with. */
function topChunks(chunks, question, k) {
  const tokenize = text => normalize(text).split(" ").filter(token => token.length > 2);
  const docs = chunks.map(chunk => tokenize(chunk));
  const averageLength = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length);
  const documentFrequency = new Map();
  for (const doc of docs) for (const token of new Set(doc)) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  const query = [...new Set(tokenize(question))];
  const scored = docs.map((doc, index) => {
    const counts = new Map();
    for (const token of doc) counts.set(token, (counts.get(token) ?? 0) + 1);
    let score = 0;
    for (const token of query) {
      const f = counts.get(token) ?? 0;
      if (!f) continue;
      const idf = Math.log(1 + (docs.length - (documentFrequency.get(token) ?? 0) + 0.5) / ((documentFrequency.get(token) ?? 0) + 0.5));
      score += idf * (f * 2.2) / (f + 1.2 * (1 - 0.75 + 0.75 * doc.length / Math.max(1, averageLength)));
    }
    return { index, score };
  }).sort((left, right) => right.score - left.score || left.index - right.index);
  const keep = new Set([0, ...scored.slice(0, k).map(row => row.index)]);
  return chunks.filter((_, index) => keep.has(index));
}

function modelPrompt(question, context) {
  return ["Answer the question using only the reference material below.", "If the material does not contain the answer, say that it does not.", "", "Reference material:", context, "", `Question: ${question}`].join("\n");
}

async function wikiItems() {
  const { default: pg } = await import("../../node_modules/.pnpm/pg@8.22.0/node_modules/pg/lib/index.js");
  const config = JSON.parse(readFileSync("scce.config.local.json", "utf8"));
  const runtimeConfig = JSON.parse(readFileSync("scce.config.json", "utf8"));
  const schema = runtimeConfig.database?.schema ?? "scce3_runtime";
  const client = new pg.Client({ connectionString: config.database.url });
  await client.connect();
  await client.query("set statement_timeout to '180s'");
  const dataset = JSON.parse(readFileSync("tools/datasets/wiki-qa.json", "utf8")).questions;
  const chunksByArticle = new Map();
  for (const title of new Set(dataset.map(row => row.article))) chunksByArticle.set(title, await articleChunks(client, schema, title));
  await client.end();
  return dataset.map(row => ({
    workload: row.answerable ? "wiki-factual" : "wiki-abstention",
    id: row.id,
    question: row.text,
    expect: row.expect ?? null,
    answerable: row.answerable,
    context: (modelContextMode === "article" ? chunksByArticle.get(row.article) : topChunks(chunksByArticle.get(row.article) ?? [], row.text, retrievedChunks)).join("\n")
  }));
}

function cognitiveTasks() {
  return readFileSync("tools/cognitive-state-benchmark/tasks.jsonl", "utf8").split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
}

function scoreWiki(item, reply) {
  if (!item.answerable) return reply.declined || !reply.answer.trim();
  return !reply.declined && normalize(reply.answer).includes(normalize(item.expect));
}

function scoreCognitive(score, reply) {
  if (!score || score.distractor) return null;
  if (score.answerable === false) return reply.declined || !reply.answer.trim();
  const answer = normalize(reply.answer);
  if (score.mustContainAll && !score.mustContainAll.every(value => answer.includes(normalize(value)))) return false;
  if (score.mustContainAny && !score.mustContainAny.some(value => answer.includes(normalize(value)))) return false;
  if (score.mustNotContain && score.mustNotContain.some(value => answer.includes(normalize(value)))) return false;
  return !reply.declined;
}

async function idleBaseline(seconds) {
  const before = { scce: processCpuSeconds(scceProcess), model: processCpuSeconds(modelProcess) };
  await new Promise(resolve => setTimeout(resolve, seconds * 1000));
  const after = { scce: processCpuSeconds(scceProcess), model: processCpuSeconds(modelProcess) };
  return { seconds, scceCpuPerSecond: (after.scce.seconds - before.scce.seconds) / seconds, modelCpuPerSecond: (after.model.seconds - before.model.seconds) / seconds };
}

const rows = [];
const want = workload => !workloadFilter || workloadFilter.has(workload);
const baseline = await idleBaseline(10);
const thermal = thermalReading();
process.stdout.write(`idle baseline: scce ${baseline.scceCpuPerSecond.toFixed(3)} cpu-s/s, model ${baseline.modelCpuPerSecond.toFixed(3)} cpu-s/s; thermal ${thermal.celsius ?? thermal.reason}\n`);

if (want("wiki-factual") || want("wiki-abstention")) {
  const items = (await wikiItems()).filter(item => want(item.workload));
  const perWorkload = new Map();
  for (const item of items) {
    const count = perWorkload.get(item.workload) ?? 0;
    if (count >= limit) continue;
    perWorkload.set(item.workload, count + 1);
    const scce = await metered(scceProcess, () => askScce(item.question));
    const modelRun = skipModel ? undefined : await metered(modelProcess, () => askModel(modelPrompt(item.question, item.context)));
    rows.push({
      workload: item.workload, id: item.id, question: item.question, expect: item.expect,
      scce: { answer: scce.value.answer, declined: scce.value.declined, correct: scoreWiki(item, scce.value), wallMs: scce.wallMs, cpuSeconds: scce.cpuSeconds, error: scce.value.error ?? null },
      model: modelRun ? { answer: modelRun.value.answer, declined: modelRun.value.declined, correct: scoreWiki(item, modelRun.value), wallMs: modelRun.wallMs, cpuSeconds: modelRun.cpuSeconds, tokens: modelRun.value.tokens, contextChars: item.context.length, error: modelRun.value.error ?? null } : null
    });
    const last = rows[rows.length - 1];
    process.stdout.write(`${item.workload} ${item.id}: scce ${last.scce.correct ? "right" : "wrong"} ${Math.round(last.scce.wallMs)}ms ${last.scce.cpuSeconds.toFixed(2)}cpu-s | model ${last.model ? `${last.model.correct ? "right" : "wrong"} ${Math.round(last.model.wallMs)}ms ${last.model.cpuSeconds.toFixed(2)}cpu-s` : "skipped"}\n`);
  }
}

if (want("cognitive-state")) {
  for (const task of cognitiveTasks().slice(0, limit)) {
    const sessionId = `h2h.${task.taskId}.${Date.now().toString(36)}`;
    const taught = [];
    for (const turn of task.turns) {
      if (turn.kind === "teach") {
        await askScce(turn.text, sessionId);
        taught.push(turn.text);
        continue;
      }
      const scce = await metered(scceProcess, () => askScce(turn.text, sessionId));
      const modelRun = skipModel ? undefined : await metered(modelProcess, () => askModel(modelPrompt(turn.text, taught.join("\n"))));
      const scceCorrect = scoreCognitive(turn.score, scce.value);
      if (scceCorrect === null) continue;
      rows.push({
        workload: "cognitive-state", id: `${task.taskId}:${rows.length}`, question: turn.text, expect: turn.score ?? null,
        scce: { answer: scce.value.answer, declined: scce.value.declined, correct: scceCorrect, wallMs: scce.wallMs, cpuSeconds: scce.cpuSeconds },
        model: modelRun ? { answer: modelRun.value.answer, declined: modelRun.value.declined, correct: scoreCognitive(turn.score, modelRun.value), wallMs: modelRun.wallMs, cpuSeconds: modelRun.cpuSeconds, tokens: modelRun.value.tokens } : null
      });
    }
  }
}

const summary = {};
for (const workload of new Set(rows.map(row => row.workload))) {
  const items = rows.filter(row => row.workload === workload);
  const sum = (list, pick) => list.reduce((total, row) => total + (pick(row) ?? 0), 0);
  const scceCpu = sum(items, row => row.scce.cpuSeconds);
  const modelCpu = sum(items, row => row.model?.cpuSeconds);
  const scceRight = items.filter(row => row.scce.correct).length;
  const modelRight = items.filter(row => row.model?.correct).length;
  summary[workload] = {
    items: items.length,
    scceCorrect: scceRight,
    modelCorrect: skipModel ? null : modelRight,
    scceCpuSeconds: scceCpu,
    modelCpuSeconds: skipModel ? null : modelCpu,
    scceJoules: scceCpu * wattsPerBusyCore,
    modelJoules: skipModel ? null : modelCpu * wattsPerBusyCore,
    energyRatio: skipModel || !modelCpu ? null : scceCpu / modelCpu,
    win: skipModel ? null : scceRight >= modelRight && modelCpu > 0 && scceCpu <= 0.2 * modelCpu
  };
}

const report = {
  schema: "scce.head_to_head.v1",
  generatedAt: new Date().toISOString(),
  model, modelContextMode, retrievedChunks, wattsPerBusyCore,
  method: "Each item is asked of SCCE, then of the model, never concurrently. CPU seconds are each answering process's own accumulated processor time, sampled before and after the item outside the timed window. Joules are CPU seconds times one stated watts-per-busy-core figure; the energy ratio does not depend on it. The model's GPU use, if any, is not captured by CPU time, which understates its energy.",
  idleBaseline: baseline,
  thermal,
  summary,
  rows
};
mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 1)}\n`);
process.stdout.write(`\n${JSON.stringify(summary, null, 1)}\nwrote ${outPath}\n`);
