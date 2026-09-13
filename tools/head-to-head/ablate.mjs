#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Does each piece of the cognitive math earn its place? The full runtime and one ablated runtime per condition answer
// the same graded items, in-process, under the sealed evaluation conditions of evaluation-flags.ts; each condition is
// scored on the workloads that need the component it removes. The report is the per-workload delta and a paired sign
// test over the items whose verdict flipped, so "removing X does not hurt" is a measured statement with a p-value.
//
//   node --max-old-space-size=7168 tools/head-to-head/ablate.mjs [--conditions=no_graph,no_language_memory] [--limit=N]
//
// Runs alone: every condition warms its own runtime (~3 GB of language cache) and the turns are timed.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createNodeRuntime, readScceRuntimeConfig } from "../../packages/adapters-node/dist/index.js";
import { createEvaluationCondition } from "../../packages/kernel/dist/index.js";
import { score } from "./grade.mjs";

const flag = (name, fallback) => (process.argv.find(a => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).split("=").slice(1).join("=");
const suitePath = flag("suite", "artifacts/head-to-head/suite.json");
const outPath = flag("out", "artifacts/head-to-head/ablation.json");
const limit = Number(flag("limit", "0"));

// Which workloads exercise the component a condition removes. A component that only matters on tasks the suite
// does not carry is reported as such, not as "harmless".
const CONDITION_WORKLOADS = {
  no_query_diffusion: ["factual", "relation", "book", "code"],
  no_powerwalk: ["factual", "relation", "book", "code"],
  no_graph: ["factual", "relation", "book", "code"],
  no_relation_potential: ["relation", "factual"],
  no_language_memory: ["cloze", "book", "direct"],
  no_support_engine: ["abstention", "factual"],
  deterministic_mouth: ["factual", "relation", "book", "code", "direct"],
  lexical_only: ["factual", "relation", "book", "code", "cloze"]
};
const conditions = flag("conditions", Object.keys(CONDITION_WORKLOADS).join(",")).split(",").filter(Boolean);
for (const id of conditions) if (!CONDITION_WORKLOADS[id]) throw new Error(`no workload mapping for condition ${id}`);

const suite = JSON.parse(readFileSync(suitePath, "utf8"));
const wanted = new Set(conditions.flatMap(id => CONDITION_WORKLOADS[id]));
let items = suite.items.filter(item => !item.gold.ungraded && wanted.has(item.workload));
if (limit) {
  // Stride, not prefix: the suite is grouped by workload and a prefix would sample one workload only.
  const stride = Math.max(1, Math.floor(items.length / limit));
  items = items.filter((_, index) => index % stride === 0).slice(0, limit);
}
console.log(`ablation: ${items.length} graded items over ${[...wanted].join(", ")}; conditions full + ${conditions.join(", ")}`);

const config = await readScceRuntimeConfig(process.env.SCCE_PROBE_CONFIG ?? "scce.config.json");
const clockIso = new Date().toISOString();
const seed = `ablation-${clockIso}`;

async function runCondition(conditionId, subset) {
  const evaluationCondition = createEvaluationCondition({ conditionId, seed, clockIso });
  const runtime = createNodeRuntime(config, { evaluationCondition, evaluationRunId: `ablation:${conditionId}:${seed}` });
  const started = Date.now();
  await runtime.kernel.warmup({ graph: true, language: true, brain: true, profile: true, corrections: true });
  console.log(`\n[${conditionId}] warm in ${((Date.now() - started) / 1000).toFixed(1)}s; ${subset.length} items`);
  const verdicts = {};
  let done = 0;
  for (const item of subset) {
    const turnStarted = Date.now();
    let answer = "";
    try {
      const result = await runtime.kernel.turn({ text: item.prompt, metadata: { sessionId: `ablation-${conditionId}-${item.id}` } });
      answer = String(result.answer ?? "");
    } catch (error) {
      answer = "";
      console.log(`  ${item.id}: turn failed: ${String(error?.message ?? error).slice(0, 120)}`);
    }
    verdicts[item.id] = { ...score(item, answer), ms: Date.now() - turnStarted, answer: answer.replace(/\s+/gu, " ").slice(0, 200) };
    done += 1;
    if (done % 10 === 0 || done === subset.length) console.log(`  ${done}/${subset.length}`);
  }
  await runtime.close();
  return verdicts;
}

/** Exact two-sided binomial sign test on the flipped items: P(as extreme | p = 0.5). */
function signTest(lost, gained) {
  const n = lost + gained;
  if (!n) return { n: 0, p: 1 };
  const k = Math.min(lost, gained);
  const choose = (a, b) => { let r = 1; for (let i = 1; i <= b; i += 1) r = r * (a - b + i) / i; return r; };
  let tail = 0;
  for (let i = 0; i <= k; i += 1) tail += choose(n, i);
  const p = Math.min(1, 2 * tail / 2 ** n);
  return { n, p: Number(p.toFixed(4)) };
}

const full = await runCondition("full", items);
const report = { schema: "scce.ablation.v1", generatedAt: new Date().toISOString(), seed, items: items.length, conditions: {} };
for (const conditionId of conditions) {
  const subset = items.filter(item => CONDITION_WORKLOADS[conditionId].includes(item.workload));
  const ablated = await runCondition(conditionId, subset);
  const byWorkload = {};
  let lost = 0;
  let gained = 0;
  for (const item of subset) {
    const bucket = byWorkload[item.workload] ??= { items: 0, fullCorrect: 0, ablatedCorrect: 0 };
    bucket.items += 1;
    const fullCorrect = full[item.id]?.verdict === "correct";
    const ablatedCorrect = ablated[item.id]?.verdict === "correct";
    if (fullCorrect) bucket.fullCorrect += 1;
    if (ablatedCorrect) bucket.ablatedCorrect += 1;
    if (fullCorrect && !ablatedCorrect) lost += 1;
    if (!fullCorrect && ablatedCorrect) gained += 1;
  }
  const test = signTest(lost, gained);
  report.conditions[conditionId] = { workloads: CONDITION_WORKLOADS[conditionId], byWorkload, lost, gained, signTest: test, verdicts: ablated };
  const line = Object.entries(byWorkload).map(([w, b]) => `${w} ${b.fullCorrect}→${b.ablatedCorrect}/${b.items}`).join(", ");
  console.log(`  ${conditionId}: ${line}; lost ${lost}, gained ${gained}, sign-test p=${test.p}`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ ...report, full }, null, 2) + "\n", "utf8");
}
console.log(`\nwrote ${outPath}`);
