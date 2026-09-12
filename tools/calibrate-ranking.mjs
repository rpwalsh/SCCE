#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Fits public-calibrations ids against the current corpus, on the served path, with a source-disjoint holdout.
//
// The ids in calibrations/public-calibrations.ts are bootstrap defaults: none has ever been fitted, because the
// calibration spine fits score-to-probability mappings and these are free parameters of the ranking function.
// This harness is the missing equipment. It sweeps one id at a time (coordinate descent), installs each value
// through the same private-runtime profile a production instance uses, restarts the server so the value is
// actually in force, and scores the corpus-verified question set the reference comparison already ships.
//
//   node tools/calibrate-ranking.mjs --id ranking.title_lead_boost --values 2,3,4,6,8
//   node tools/calibrate-ranking.mjs --id units.prefix_ratio_floor --values 0.60,0.66,0.72 --limit 60
//
// Objective is correct-on-answerable minus fabrications-on-unanswerable, counted on the TRAIN split only.
// Articles never span splits, so a value cannot be chosen on the same source it is scored on. The holdout
// number is reported and never optimised against. Nothing is installed permanently: the winning profile is
// printed, for the owner to write into private-runtime/calibration/prod-calibrations.json.
//
// A substring test decides "correct" here, which is the same proxy the reference comparison uses and is known
// to be generous (it scores "Lima" correct inside a sentence about a 16th-century viceroyalty). Read the
// recorded answers of the winning run before adopting a value.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Accepts both --id=value and --id value; the space form silently parsed as a bare flag before.
const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const token = process.argv[i];
  if (!token.startsWith("--")) continue;
  const eq = token.indexOf("=");
  if (eq > 0) {
    args.set(token.slice(2, eq), token.slice(eq + 1));
    continue;
  }
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) {
    args.set(token.slice(2), next);
    i++;
    continue;
  }
  args.set(token.slice(2), "1");
}
const flag = (name, fallback) => args.get(name) ?? fallback;

const serverUrl = process.env.SCCE_SERVER_URL ?? "http://127.0.0.1:3873";
const profilePath = process.env.SCCE_PROD_CALIBRATIONS ?? "private-runtime/calibration/prod-calibrations.json";
const targetId = flag("id", "");
const values = String(flag("values", "")).split(",").map(v => Number(v.trim())).filter(v => Number.isFinite(v));
const limit = Number(flag("limit", "0"));
const outPath = flag("out", "artifacts/calibration/ranking-sweep.json");
if (!targetId || !values.length) {
  console.error("usage: --id <calibration id> --values <comma separated numbers> [--limit N] [--out path]");
  process.exit(2);
}

// The question set the reference comparison already ships, read without importing it (its module body runs a
// full comparison on import). Plain object literals, so the array evaluates on its own.
function loadQuestions() {
  const source = readFileSync("tools/reference-comparison-large.mjs", "utf8");
  const start = source.indexOf("const QUESTIONS = [");
  if (start < 0) throw new Error("QUESTIONS not found in tools/reference-comparison-large.mjs");
  const open = source.indexOf("[", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "[") depth++;
    else if (source[i] === "]") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) throw new Error("QUESTIONS array never closes");
  return new Function("return " + source.slice(open, end + 1))();
}

const normalize = value => String(value).replace(/\s+/gu, " ").trim().toLowerCase();
const declines = answer => {
  const spoken = normalize(answer);
  if (!spoken) return true;
  return /(do not|does not|doesn't|don't|no (information|mention|reference|record|grounded source)|not (mentioned|found|provided|present|specified|available|contain|include)|cannot|can't|unable|unknown|not enough|isn't (mentioned|specified)|no specific)/u.test(spoken);
};
const statesExpected = (question, answer) => {
  const parts = String(question.expect).split(/[\s,]+/u).filter(Boolean);
  const spoken = normalize(answer);
  return parts.every(part => spoken.includes(normalize(part)));
};

// Source-disjoint split: an article lands wholly in train or wholly in holdout, so a value fitted on one
// source is never scored on that same source.
function splitByArticle(questions) {
  const articles = [...new Set(questions.map(q => q.article))].sort();
  const holdout = new Set(articles.filter((_, index) => index % 3 === 2));
  return {
    train: questions.filter(q => !holdout.has(q.article)),
    holdout: questions.filter(q => holdout.has(q.article))
  };
}

function readProfile() {
  try {
    const parsed = JSON.parse(readFileSync(profilePath, "utf8"));
    return parsed?.calibrations ?? parsed ?? {};
  } catch {
    return {};
  }
}

function writeProfile(calibrations) {
  mkdirSync(dirname(profilePath), { recursive: true });
  writeFileSync(profilePath, JSON.stringify({
    schema: "scce.prod_calibrations.v1",
    note: "Fitted values. Not in version control; see private-runtime/README.md.",
    calibrations
  }, null, 2) + "\n", "utf8");
}

function restartServer() {
  execFileSync("sh", ["scripts/restart-server.sh"], { stdio: "pipe", timeout: 420000 });
}

async function ask(text) {
  const started = Date.now();
  try {
    const response = await fetch(`${serverUrl}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text })
    });
    if (response.status === 422) return { answer: "", ms: Date.now() - started };
    const payload = await response.json();
    return { answer: String(payload.answer ?? ""), ms: Date.now() - started };
  } catch (error) {
    return { answer: "", ms: Date.now() - started, error: String(error?.message ?? error) };
  }
}

function tally(rows) {
  const answerable = rows.filter(r => r.answerable);
  const unanswerable = rows.filter(r => !r.answerable);
  const correct = answerable.filter(r => r.correct).length;
  const fabrications = unanswerable.filter(r => !r.declined).length;
  return {
    correct,
    answerable: answerable.length,
    wrong: answerable.filter(r => !r.correct && !r.declined).length,
    declinedWhenAnswerable: answerable.filter(r => !r.correct && r.declined).length,
    fabrications,
    unanswerable: unanswerable.length,
    objective: correct - fabrications
  };
}

async function scoreRun(questions) {
  const rows = [];
  for (const question of questions) {
    const { answer, ms } = await ask(question.text);
    rows.push({
      id: question.id,
      article: question.article,
      answerable: question.answerable === true,
      correct: question.answerable ? statesExpected(question, answer) : null,
      declined: declines(answer),
      ms,
      answer: answer.replace(/\s+/gu, " ").slice(0, 300)
    });
  }
  return rows;
}

const all = loadQuestions();
const selected = limit > 0 ? all.slice(0, limit) : all;
const { train, holdout } = splitByArticle(selected);
const baseProfile = readProfile();
const originalProfile = { ...baseProfile };

console.log(`sweeping ${targetId} over ${values.join(", ")}`);
console.log(`${selected.length} questions: ${train.length} train / ${holdout.length} holdout, split by article`);

const runs = [];
try {
  for (const value of values) {
    writeProfile({ ...baseProfile, [targetId]: value });
    restartServer();
    const trainRows = await scoreRun(train);
    const holdoutRows = await scoreRun(holdout);
    const run = {
      value,
      train: tally(trainRows),
      holdout: tally(holdoutRows),
      trainRows,
      holdoutRows
    };
    runs.push(run);
    console.log(`  ${targetId}=${value}  train objective ${run.train.objective} (correct ${run.train.correct}/${run.train.answerable}, fabrications ${run.train.fabrications})  holdout objective ${run.holdout.objective} (correct ${run.holdout.correct}/${run.holdout.answerable})`);
  }
} finally {
  // Always restore whatever profile was in force before the sweep.
  if (Object.keys(originalProfile).length) writeProfile(originalProfile);
  else writeProfile({});
  restartServer();
}

const best = [...runs].sort((a, b) => b.train.objective - a.train.objective || a.value - b.value)[0];
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({
  schema: "scce.calibration_sweep.v1",
  generatedAt: new Date().toISOString(),
  calibrationId: targetId,
  values,
  questionCount: selected.length,
  split: { train: train.length, holdout: holdout.length, rule: "article index % 3 === 2 held out" },
  best: best ? { value: best.value, train: best.train, holdout: best.holdout } : null,
  runs
}, null, 2) + "\n", "utf8");

console.log(`\nbest on train: ${targetId}=${best?.value} (objective ${best?.train.objective}); its holdout objective is ${best?.holdout.objective}`);
console.log(`wrote ${outPath}`);
console.log("nothing installed: write the value into " + profilePath + " to adopt it");
