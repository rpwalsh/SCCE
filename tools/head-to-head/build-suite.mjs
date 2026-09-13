#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Assembles the head-to-head suite from the labelled sets this repository already has, into one manifest with
// one scoring contract. Nothing here invents a question or an answer: every item carries the gold its source
// shipped with, and every item records which source it came from so a disputed verdict can be traced back.
//
//   node tools/head-to-head/build-suite.mjs [--out artifacts/head-to-head/suite.json]
//
// Reads local files only -- no server, no database -- so it is safe to run while a calibration holds the server.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const token = process.argv[i];
  if (!token.startsWith("--")) continue;
  const eq = token.indexOf("=");
  if (eq > 0) { args.set(token.slice(2, eq), token.slice(eq + 1)); continue; }
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) { args.set(token.slice(2), next); i++; continue; }
  args.set(token.slice(2), "1");
}
const outPath = args.get("out") ?? "artifacts/head-to-head/suite.json";

const items = [];
const add = item => {
  if (!item.prompt || !item.id) return;
  if (items.some(existing => existing.id === item.id)) return;
  items.push(item);
};

// ---- 1. sealed evaluation set: cloze and source-bound questions with explicit gold ---------------------------
function loadSealed() {
  const candidates = [
    "tools/sealed-eval/artifacts/run-20260818/questions.jsonl",
    "tools/sealed-eval/artifacts/run-20260818/questions-mix.jsonl",
    "tools/sealed-eval/artifacts/run-20260816/questions.jsonl"
  ].filter(existsSync);
  let count = 0;
  for (const path of candidates) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const gold = row.gold ?? {};
      add({
        id: `sealed:${row.questionId}`,
        workload: gold.unanswerable ? "abstention" : (row.category ?? "cloze"),
        // The sealed corpus is an export of Wikipedia article text (star-trek, star-trek-tos, star-trek-ds9, ada-lovelace).
        corpus: "wikipedia",
        prompt: row.prompt,
        gold: {
          requiredStrings: gold.requiredStrings ?? [],
          acceptedAnswers: gold.acceptedAnswers ?? [],
          forbiddenStrings: gold.forbiddenStrings ?? [],
          unanswerable: gold.unanswerable === true
        },
        source: path
      });
      count++;
    }
  }
  return count;
}

// ---- 2. reference comparison: corpus-verified factual questions with unanswerable controls -------------------
function loadReferenceComparison() {
  const path = "tools/reference-comparison-large.mjs";
  if (!existsSync(path)) return 0;
  const source = readFileSync(path, "utf8");
  const open = source.indexOf("[", source.indexOf("const QUESTIONS = ["));
  let depth = 0;
  let questions = [];
  for (let i = open; i < source.length; i++) {
    if (source[i] === "[") depth++;
    else if (source[i] === "]" && --depth === 0) {
      questions = new Function("return " + source.slice(open, i + 1))();
      break;
    }
  }
  for (const question of questions) {
    add({
      id: `reference:${question.id}`,
      workload: question.answerable ? "factual" : "abstention",
      corpus: "wikipedia",
      prompt: question.text,
      article: question.article,
      gold: {
        requiredStrings: question.answerable && question.expect ? [question.expect] : [],
        acceptedAnswers: question.answerable && question.expect ? [question.expect] : [],
        forbiddenStrings: [],
        unanswerable: question.answerable !== true
      },
      source: path
    });
  }
  return questions.length;
}

// ---- 3. relation questions the ranking work is measured on ---------------------------------------------------
const RELATION_ITEMS = [
  ["japan", "What is the capital of Japan?", "Tokyo"],
  ["kenya", "What is the capital of Kenya?", "Nairobi"],
  ["peru", "What is the capital of Peru?", "Lima"],
  ["albania", "What is the capital of Albania?", "Tirana"],
  ["alabama", "What is the capital of Alabama?", "Montgomery"],
  ["azerbaijan", "What is the capital of Azerbaijan?", "Baku"],
  ["armenia", "What is the capital of Armenia?", "Yerevan"]
];
function loadRelations() {
  for (const [id, prompt, expect] of RELATION_ITEMS) {
    add({
      id: `relation:capital-${id}`,
      workload: "relation",
      corpus: "wikipedia",
      prompt,
      gold: { requiredStrings: [expect], acceptedAnswers: [expect], forbiddenStrings: [], unanswerable: false },
      source: "tools/head-to-head/build-suite.mjs"
    });
  }
  return RELATION_ITEMS.length;
}

// ---- 3b. heterogeneous sources: books and source files, graded -----------------------------------------------
// Every corpus is knowledge. These items are answerable only from a Gutenberg text or from the ingested source tree,
// never from a Wikipedia article, so a wiki-only retrieval path scores zero here. Gold is a fact of the text itself,
// and each item carries the corpus document and the quote that supports it so a verdict is checkable by hand.
function loadHeterogeneous() {
  const path = "tools/datasets/nonwiki-qa.json";
  if (!existsSync(path)) return 0;
  const dataset = JSON.parse(readFileSync(path, "utf8"));
  for (const question of dataset.questions) {
    add({
      id: `${question.corpus === "code" ? "code" : "book"}:${question.id}`,
      workload: question.corpus === "code" ? "code" : "book",
      corpus: question.corpus,
      kind: question.kind,
      prompt: question.prompt,
      gold: {
        requiredStrings: question.requiredStrings ?? [],
        acceptedAnswers: question.acceptedAnswers ?? [],
        forbiddenStrings: question.forbiddenStrings ?? [],
        unanswerable: false
      },
      support: question.support,
      source: path
    });
  }
  return dataset.questions.length;
}

// ---- 4. conversational probes: no gold, scored only for latency and energy -----------------------------------
function loadProbes() {
  const path = "tools/probe-questions.txt";
  if (!existsSync(path)) return 0;
  const lines = readFileSync(path, "utf8").split(/\r?\n/u).map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  lines.forEach((prompt, index) => add({
    id: `probe:${index + 1}`,
    workload: "conversational",
    corpus: "none",
    prompt,
    gold: { requiredStrings: [], acceptedAnswers: [], forbiddenStrings: [], unanswerable: false, ungraded: true },
    source: path
  }));
  return lines.length;
}

const counts = {
  sealed: loadSealed(),
  reference: loadReferenceComparison(),
  relation: loadRelations(),
  heterogeneous: loadHeterogeneous(),
  probe: loadProbes()
};

const byWorkload = {};
for (const item of items) byWorkload[item.workload] = (byWorkload[item.workload] ?? 0) + 1;

// Per corpus, counting only graded items: one total across Wikipedia, books and code hides which corpus is unmeasured.
const gradedByCorpus = {};
for (const item of items) {
  if (item.gold.ungraded) continue;
  gradedByCorpus[item.corpus ?? "unlabelled"] = (gradedByCorpus[item.corpus ?? "unlabelled"] ?? 0) + 1;
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({
  schema: "scce.head_to_head_suite.v1",
  generatedAt: new Date().toISOString(),
  total: items.length,
  byWorkload,
  gradedByCorpus,
  sourceCounts: counts,
  // Graded items decide correctness; ungraded ones are carried for latency and energy only, and are never
  // counted as correct or wrong.
  graded: items.filter(item => !item.gold.ungraded).length,
  items
}, null, 2) + "\n", "utf8");

console.log(`suite: ${items.length} items (${items.filter(i => !i.gold.ungraded).length} graded)`);
for (const [workload, count] of Object.entries(byWorkload).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${workload.padEnd(16)} ${count}`);
}
console.log("graded by corpus:");
for (const [corpus, count] of Object.entries(gradedByCorpus).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${corpus.padEnd(16)} ${count}`);
}
console.log(`wrote ${outPath}`);
