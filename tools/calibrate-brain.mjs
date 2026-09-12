#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Calibrates a brain: fits the public-calibrations ids against whatever corpus this instance has ingested and
// writes the fitted profile the private runtime loads. This is the machinery a NEW brain runs once; the values
// in calibrations/public-calibrations.ts are bootstrap defaults that were never fitted at all.
//
//   SCCE_ALLOW_CALIBRATION_API=1 sh scripts/restart-server.sh
//   node tools/calibrate-brain.mjs --ids ranking.title_lead_boost,units.prefix_ratio_floor --limit 60
//   node tools/calibrate-brain.mjs --all --limit 90 --passes 2        # overnight
//
// Method
//   Coordinate descent. One id at a time, coarse grid from the engine's own search space, then bisection
//   between the winner and its neighbours to find the PLATEAU -- the interval of values that produce an
//   identical objective. The adopted value is the plateau midpoint, which maximises margin to the nearest
//   behaviour change, and the plateau is reported so nobody quotes more precision than the evidence supports.
//   A threshold compared against min(len)/max(len) has only ~31 reachable values for real word lengths, so
//   fitting it to 64-bit precision would be false precision, not accuracy.
//
//   Articles never span the train/holdout split. A value is chosen on train and adopted only if holdout does
//   not get worse, which is the same source-disjoint acceptance the repository already applies to fitted models.
//
// Cost
//   Each evaluation is one question run. With the calibration API enabled no server restart is needed, so an
//   evaluation costs about as long as the question set; without it every evaluation restarts the server.
//   Progress is written after every id, and --resume continues from it.
import { execFileSync } from "node:child_process";
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
const flag = (name, fallback) => args.get(name) ?? fallback;

const serverUrl = process.env.SCCE_SERVER_URL ?? "http://127.0.0.1:3873";
const profilePath = process.env.SCCE_PROD_CALIBRATIONS ?? "private-runtime/calibration/prod-calibrations.json";
const reportPath = flag("out", "artifacts/calibration/brain-calibration.json");
const limit = Number(flag("limit", "60"));
const passes = Number(flag("passes", "1"));
const resume = args.has("resume");

const { CALIBRATION_SEARCH_SPACE, CALIBRATION_SEARCH_IDS, snapCalibrationValue, PUBLIC_CALIBRATIONS } =
  await import("../packages/kernel/dist/index.js");

const requestedIds = args.has("all")
  ? [...CALIBRATION_SEARCH_IDS]
  : String(flag("ids", "")).split(",").map(s => s.trim()).filter(Boolean);
if (!requestedIds.length) {
  console.error("usage: --ids a,b,c | --all   [--limit N] [--passes N] [--resume]");
  process.exit(2);
}
const unknown = requestedIds.filter(id => !(id in CALIBRATION_SEARCH_SPACE));
if (unknown.length) {
  console.error("no search space for: " + unknown.join(", "));
  process.exit(2);
}

// ---- question set ------------------------------------------------------------------------------------------
function loadQuestions() {
  const source = readFileSync("tools/reference-comparison-large.mjs", "utf8");
  const open = source.indexOf("[", source.indexOf("const QUESTIONS = ["));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "[") depth++;
    else if (source[i] === "]" && --depth === 0) return new Function("return " + source.slice(open, i + 1))();
  }
  throw new Error("QUESTIONS array never closes");
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

const all = loadQuestions();
// Sampled by stride, not sliced: the set is ordered by article, so the first N questions would be three
// articles deep and a small sample would fit constants against Einstein and Apollo alone.
const selected = limit > 0 && limit < all.length
  ? all.filter((_, index) => index % Math.ceil(all.length / limit) === 0)
  : all;
const articles = [...new Set(selected.map(q => q.article))].sort();
const heldOut = new Set(articles.filter((_, index) => index % 3 === 2));
const train = selected.filter(q => !heldOut.has(q.article));
const holdout = selected.filter(q => heldOut.has(q.article));

// ---- installing values -------------------------------------------------------------------------------------
let apiAvailable = false;
async function detectApi() {
  try {
    const response = await fetch(`${serverUrl}/api/calibrations`);
    apiAvailable = response.ok;
  } catch {
    apiAvailable = false;
  }
  return apiAvailable;
}

function writeProfile(calibrations) {
  mkdirSync(dirname(profilePath), { recursive: true });
  writeFileSync(profilePath, JSON.stringify({
    schema: "scce.prod_calibrations.v1",
    note: "Fitted by tools/calibrate-brain.mjs. Not in version control; see private-runtime/README.md.",
    calibrations
  }, null, 2) + "\n", "utf8");
}

async function install(calibrations) {
  if (apiAvailable) {
    const response = await fetch(`${serverUrl}/api/calibrations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reset: true, calibrations })
    });
    const payload = await response.json();
    if (payload?.ignored?.length) console.warn("  ignored ids: " + payload.ignored.join(", "));
    return;
  }
  writeProfile(calibrations);
  execFileSync("sh", ["scripts/restart-server.sh"], { stdio: "pipe", timeout: 420000 });
}

// ---- evaluation --------------------------------------------------------------------------------------------
async function ask(text) {
  try {
    const response = await fetch(`${serverUrl}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text })
    });
    if (response.status === 422) return "";
    const payload = await response.json();
    return String(payload.answer ?? "");
  } catch {
    return "";
  }
}
// Measured 2026-09-12: asking 6 turns at once cost 6.9s per question against 3.3s sequential. The runtime
// serialises a turn's heavy work, so overlap only adds contention. Sequential is the default for that reason.
const concurrency = Math.max(1, Number(flag("concurrency", "1")));
async function objectiveFor(questions) {
  let correct = 0;
  let fabrications = 0;
  const answers = [];
  for (let start = 0; start < questions.length; start += concurrency) {
    const batch = questions.slice(start, start + concurrency);
    const spoken = await Promise.all(batch.map(question => ask(question.text)));
    batch.forEach((question, index) => {
      const answer = spoken[index];
      answers.push({ id: question.id, answer: answer.replace(/\s+/gu, " ").slice(0, 200) });
      if (question.answerable) { if (statesExpected(question, answer)) correct++; }
      else if (!declines(answer)) fabrications++;
    });
  }
  return { objective: correct - fabrications, correct, fabrications, answers };
}

const evaluationCache = new Map();
async function evaluate(profile, label) {
  const key = JSON.stringify(profile);
  if (evaluationCache.has(key)) return evaluationCache.get(key);
  await install(profile);
  const trainScore = await objectiveFor(train);
  const holdoutScore = await objectiveFor(holdout);
  const result = { train: trainScore, holdout: holdoutScore };
  evaluationCache.set(key, result);
  console.log(`    ${label}: train ${trainScore.objective} (correct ${trainScore.correct}, fabricated ${trainScore.fabrications})  holdout ${holdoutScore.objective}`);
  return result;
}

// ---- plateau refinement ------------------------------------------------------------------------------------
/**
 * The interval around `value` whose objective is identical. Bisects towards each neighbour until the gap is
 * below the id's resolution, so the reported precision is the precision the objective can actually separate.
 */
async function plateauFor(id, entry, profile, value, targetObjective, neighbours) {
  const edge = async direction => {
    const neighbour = direction < 0
      ? Math.max(entry.min, neighbours.below ?? entry.min)
      : Math.min(entry.max, neighbours.above ?? entry.max);
    let same = value;
    let different = neighbour;
    if (entry.kind === "count") return same;
    while (Math.abs(different - same) > entry.resolution) {
      const middle = snapCalibrationValue(entry, (same + different) / 2);
      if (middle === same || middle === different) break;
      const score = await evaluate({ ...profile, [id]: middle }, `${id}=${middle}`);
      if (score.train.objective === targetObjective) same = middle;
      else different = middle;
    }
    return same;
  };
  const low = await edge(-1);
  const high = await edge(1);
  return { low: Math.min(low, high), high: Math.max(low, high) };
}

// ---- run ---------------------------------------------------------------------------------------------------
mkdirSync(dirname(reportPath), { recursive: true });
const priorReport = resume && existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : undefined;
const profile = { ...(priorReport?.profile ?? {}) };
const results = [...(priorReport?.results ?? [])];
const done = new Set(results.map(row => row.id));

console.log(`calibration api: ${await detectApi() ? "on (no restarts)" : "off (restart per evaluation -- enable SCCE_ALLOW_CALIBRATION_API=1 to go faster)"}`);
console.log(`${selected.length} questions: ${train.length} train / ${holdout.length} holdout, split by article`);
console.log(`${requestedIds.length} ids, ${passes} pass(es)\n`);

const baseline = await evaluate(profile, "baseline");
let bestObjective = baseline.train.objective;
let baselineHoldout = baseline.holdout.objective;
const startedAt = Date.now();

// Written after every id, on both paths. An id that turns out unidentifiable is still a result, and a run this
// long must survive being stopped.
function persistReport() {
  writeFileSync(reportPath, JSON.stringify({
    schema: "scce.brain_calibration.v1",
    generatedAt: new Date().toISOString(),
    elapsedMinutes: Math.round((Date.now() - startedAt) / 60000),
    questionCount: selected.length,
    split: { train: train.length, holdout: holdout.length, rule: "article index % 3 === 2 held out" },
    baseline: { train: baseline.train.objective, holdout: baseline.holdout.objective },
    current: { train: bestObjective, holdout: baselineHoldout },
    profile,
    results
  }, null, 2) + "\n", "utf8");
}

for (let pass = 1; pass <= passes; pass++) {
  for (const id of requestedIds) {
    if (pass === 1 && done.has(id)) { console.log(`${id}: carried from previous run`); continue; }
    const entry = CALIBRATION_SEARCH_SPACE[id];
    const shipped = PUBLIC_CALIBRATIONS[id];
    console.log(`${id} (pass ${pass}, shipped ${shipped})`);
    const candidates = [...new Set([shipped, ...entry.coarse].map(v => snapCalibrationValue(entry, v)))].sort((a, b) => a - b);
    // Stop early on an id nothing moves: three candidates apart on the search range scoring identically is
    // already evidence the objective cannot see this constant, and the remaining probes cost measurements.
    const scored = [];
    for (const value of candidates) {
      const score = await evaluate({ ...profile, [id]: value }, `${id}=${value}`);
      scored.push({ value, ...score });
      if (scored.length >= 3 && new Set(scored.map(row => row.train.objective)).size === 1) {
        console.log(`    flat after ${scored.length} probes, stopping early`);
        break;
      }
    }
    // An id every candidate scores identically on is not identifiable from this question set: no value of it
    // changes an answer here. Refining it would spend measurements manufacturing precision the evidence does
    // not contain, so it keeps its shipped value and is reported as unidentifiable.
    const distinct = new Set(scored.map(row => row.train.objective));
    if (distinct.size === 1) {
      console.log(`  unidentifiable on this corpus: every candidate scores ${scored[0].train.objective}; kept shipped ${shipped}`);
      results.push({
        id,
        pass,
        shipped,
        adopted: profile[id] ?? shipped,
        plateau: { low: entry.min, high: entry.max },
        candidates: scored.map(row => ({ value: row.value, train: row.train.objective, holdout: row.holdout.objective })),
        accepted: false,
        unidentifiable: true
      });
      persistReport();
      continue;
    }
    const winner = [...scored].sort((a, b) =>
      b.train.objective - a.train.objective
      || Math.abs(a.value - shipped) - Math.abs(b.value - shipped))[0];
    const index = candidates.indexOf(winner.value);
    const plateau = await plateauFor(id, entry, profile, winner.value, winner.train.objective, {
      below: candidates[index - 1],
      above: candidates[index + 1]
    });
    const adopted = entry.kind === "count"
      ? winner.value
      : snapCalibrationValue(entry, (plateau.low + plateau.high) / 2);
    const confirm = adopted === winner.value ? winner : await evaluate({ ...profile, [id]: adopted }, `${id}=${adopted} (plateau midpoint)`);

    // Source-disjoint acceptance: better on train, and never worse on the sources it was not chosen on.
    const improves = confirm.train.objective > bestObjective;
    const safe = confirm.holdout.objective >= baselineHoldout;
    if (improves && safe) {
      profile[id] = adopted;
      bestObjective = confirm.train.objective;
      baselineHoldout = confirm.holdout.objective;
      console.log(`  adopted ${id} = ${adopted}  plateau [${plateau.low}, ${plateau.high}]  train ${confirm.train.objective} holdout ${confirm.holdout.objective}`);
    } else {
      console.log(`  kept shipped ${id} = ${shipped} (best candidate ${winner.value} ${improves ? "hurt holdout" : "did not beat train"})`);
    }
    results.push({
      id,
      pass,
      shipped,
      adopted: profile[id] ?? shipped,
      plateau,
      candidates: scored.map(row => ({ value: row.value, train: row.train.objective, holdout: row.holdout.objective })),
      accepted: Boolean(improves && safe)
    });
    persistReport();
  }
}

// The fitted profile is what a production instance loads; the public table is left alone.
writeProfile(profile);
if (apiAvailable) await install(profile);
console.log(`\nfitted ${Object.keys(profile).length} of ${requestedIds.length} ids`);
console.log(`train objective ${baseline.train.objective} -> ${bestObjective}, holdout ${baseline.holdout.objective} -> ${baselineHoldout}`);
console.log(`profile written to ${profilePath}`);
console.log(`report written to ${reportPath}`);
