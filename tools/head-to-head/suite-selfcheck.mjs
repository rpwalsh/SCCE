#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Offline checks on the head-to-head suite: no server, no database, no model. A suite that cannot fail on books or
// code is not evidence about books or code, and an item whose gold sits inside its own prompt is not evidence
// about anything -- echoing the question would score it correct. Both are checked here, and the per-corpus
// report is exercised on a replay so the integrator can trust it before spending a live run on it.
//
//   node tools/head-to-head/build-suite.mjs --out artifacts/head-to-head/suite.json
//   node tools/head-to-head/suite-selfcheck.mjs --suite artifacts/head-to-head/suite.json
import { existsSync, readFileSync } from "node:fs";
import { score, summarizeVerdicts, formatPerCorpus } from "./grade.mjs";

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
const suitePath = args.get("suite") ?? "artifacts/head-to-head/suite.json";
if (!existsSync(suitePath)) {
  console.error(`no suite at ${suitePath}; run tools/head-to-head/build-suite.mjs first`);
  process.exit(2);
}
const suite = JSON.parse(readFileSync(suitePath, "utf8"));
const failures = [];
const warnings = [];
const graded = suite.items.filter(item => !item.gold.ungraded);
const nonWiki = graded.filter(item => item.corpus === "gutenberg" || item.corpus === "code");

// ---- 1. every item carries a corpus, or the per-corpus report is a fiction -----------------------------------
for (const item of suite.items) {
  if (!item.corpus) failures.push(`${item.id}: no corpus label, so it cannot be reported per corpus`);
}

// ---- 2. the non-Wikipedia corpora are actually measured ------------------------------------------------------
const gutenberg = graded.filter(item => item.corpus === "gutenberg");
const code = graded.filter(item => item.corpus === "code");
if (gutenberg.length < 12) failures.push(`only ${gutenberg.length} graded Gutenberg items; the suite cannot fail on books`);
if (code.length < 6) failures.push(`only ${code.length} graded code items; the suite cannot fail on code`);

// ---- 3. gold must not sit inside the item's own prompt -------------------------------------------------------
// Scored with the real grader against the question itself: if that is "correct", the item measures echoing.
for (const item of graded) {
  if (item.gold.unanswerable) continue;
  if (score(item, item.prompt).verdict !== "correct") continue;
  const message = `${item.id}: echoing its own prompt scores correct -- gold is inside the question`;
  if (item.corpus === "gutenberg" || item.corpus === "code") failures.push(message);
  else warnings.push(message);
}

// ---- 4. a person must be able to check a verdict without running anything ------------------------------------
for (const item of nonWiki) {
  if (!item.support?.document || !item.support?.quote) {
    failures.push(`${item.id}: no support.document/support.quote, so a disputed verdict is not checkable by hand`);
    continue;
  }
  if (!item.gold.requiredStrings.length && !item.gold.acceptedAnswers.length) {
    failures.push(`${item.id}: no gold, so it can never be wrong`);
  }
}

// ---- 5. question kinds are spread, not twelve of one kind ----------------------------------------------------
const kinds = {};
for (const item of nonWiki) kinds[item.kind ?? "(none)"] = (kinds[item.kind ?? "(none)"] ?? 0) + 1;
if (Object.keys(kinds).length < 3) failures.push(`non-wiki items span only ${Object.keys(kinds).length} question kinds`);

// ---- 6. replay: the per-corpus report, on canned answers, with no server -------------------------------------
// Two Gutenberg items answered one right one wrong, two code items likewise, one Wikipedia item right: if the
// report ever collapses to a single number again, these three separate lines stop matching.
const REPLAY = [
  ["book:moby-narrator", "Ishmael narrates the book.", "correct"],
  ["book:littlewomen-beth", "It was Jo who died.", "wrong"],
  ["code:replan-builds-on", "It builds on hierarchical-task-decomposition.ts.", "correct"],
  ["code:closed-class-derived-from", "I do not have that information.", "declined_when_answerable"],
  ["relation:capital-japan", "The capital of Japan is Tokyo.", "correct"]
];
const replayRows = [];
for (const [id, answer, expected] of REPLAY) {
  const item = suite.items.find(candidate => candidate.id === id);
  if (!item) { failures.push(`replay: no item ${id} in the suite`); continue; }
  const verdict = score(item, answer);
  if (verdict.verdict !== expected) {
    failures.push(`replay: ${id} graded ${verdict.verdict}, expected ${expected}`);
  }
  replayRows.push({ id, workload: item.workload, corpus: item.corpus, scce: { ...verdict } });
}
const replay = summarizeVerdicts(replayRows, "scce");
const EXPECTED_REPLAY = { gutenberg: [1, 2], code: [1, 2], wikipedia: [1, 1] };
for (const [corpus, [correct, items]] of Object.entries(EXPECTED_REPLAY)) {
  const bucket = replay.byCorpus[corpus];
  if (!bucket) { failures.push(`replay: no ${corpus} line in the per-corpus report`); continue; }
  if (bucket.correct !== correct || bucket.items !== items) {
    failures.push(`replay: ${corpus} reported ${bucket.correct}/${bucket.items}, expected ${correct}/${items}`);
  }
}

// ---- report --------------------------------------------------------------------------------------------------
console.log(`suite ${suitePath}: ${suite.items.length} items, ${graded.length} graded`);
console.log("graded per corpus:");
const perCorpus = {};
for (const item of graded) perCorpus[item.corpus ?? "unlabelled"] = (perCorpus[item.corpus ?? "unlabelled"] ?? 0) + 1;
for (const [corpus, count] of Object.entries(perCorpus).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${corpus.padEnd(12)} ${count}`);
}
console.log(`non-wiki question kinds: ${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(", ")}`);
console.log("replay per-corpus report (the same printer a live run uses):");
for (const line of formatPerCorpus(replay.byCorpus)) console.log(line);
for (const warning of warnings) console.log(`WARN  ${warning}`);
if (failures.length) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`\nok: ${gutenberg.length} Gutenberg and ${code.length} code items graded, ${warnings.length} warning(s)`);
