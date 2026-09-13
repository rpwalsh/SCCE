#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Fits the sentence ranker's coefficients as ONE vector, from logged candidates, in a single pass.
//
// The ranker's score is linear in its features, so its coefficients cannot be fitted one at a time: they trade
// off against each other. This collects, for every labelled question, the raw feature vector of every candidate
// sentence the ranker considered (traced as local_evidence.rank_features), labels a candidate positive when it
// carries the gold answer, and fits all weights together by pairwise logistic regression -- the same shape the
// spine already fits for judge.requirement_weights.
//
//   SCCE_TRACE=1 sh scripts/restart-server.sh
//   node tools/fit-ranking-weights.mjs --limit 120
//   node tools/fit-ranking-weights.mjs --limit 120 --install     # write the fitted profile
//
// Ranking is invariant to positive rescaling of the whole weight vector, so the fitted vector is rescaled to
// the shipped vector's norm before it is reported: only the relative structure is evidence.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
const traceDir = process.env.SCCE_TRACE_DIR ?? ".scce/traces";
const suitePath = flag("suite", "artifacts/head-to-head/suite.json");
const outPath = flag("out", "artifacts/calibration/ranking-weights.json");
const profilePath = process.env.SCCE_PROD_CALIBRATIONS ?? "private-runtime/calibration/prod-calibrations.json";
const limit = Number(flag("limit", "120"));

// feature name -> calibration id it scales. sourceOrderTerm and longSentencePenalty have no id yet.
const FEATURE_TO_ID = {
  unitOverlap: "ranking.unit_overlap_weight",
  lexical: "ranking.lexical_similarity_weight",
  pairOverlap: "ranking.best.pair_overlap_weight",
  alpha: "ranking.best.evidence_alpha_weight",
  anchorMatch: "ranking.anchor_boost",
  titleLead: "ranking.title_lead_boost",
  sourceAffinity: "ranking.source_affinity_weight",
  nearDuplicateFraction: "ranking.near_duplicate_weight",
  fragmentCount: "ranking.fragment_penalty"
};
const FEATURES = [...Object.keys(FEATURE_TO_ID), "sourceOrderTerm"];
// Penalties enter the score negatively; the fitted weight is stored as a positive magnitude.
const NEGATIVE = new Set(["fragmentCount"]);

const { PUBLIC_CALIBRATIONS } = await import("../packages/kernel/dist/index.js");
const shipped = {};
for (const feature of FEATURES) {
  if (feature === "sourceOrderTerm") { shipped[feature] = 1; continue; }
  shipped[feature] = PUBLIC_CALIBRATIONS[FEATURE_TO_ID[feature]];
}

const normalize = value => String(value).replace(/\s+/gu, " ").trim().toLowerCase();
const carriesGold = (sentence, item) => {
  const spoken = normalize(sentence);
  const required = item.gold.requiredStrings ?? [];
  const accepted = item.gold.acceptedAnswers ?? [];
  if (required.length) return required.every(s => normalize(s).split(/[\s,]+/u).filter(Boolean).every(p => spoken.includes(p)));
  return accepted.some(s => spoken.includes(normalize(s)));
};

function newestTrace() {
  const files = readdirSync(traceDir).filter(f => f.endsWith(".jsonl"))
    .map(f => ({ f, m: statSync(join(traceDir, f)).mtimeMs })).sort((a, b) => b.m - a.m);
  return files.length ? join(traceDir, files[0].f) : undefined;
}

// ---- collect ------------------------------------------------------------------------------------------------
if (!existsSync(suitePath)) { console.error(`no suite at ${suitePath}`); process.exit(2); }
const suite = JSON.parse(readFileSync(suitePath, "utf8"));
const items = suite.items
  .filter(item => !item.gold.unanswerable && !item.gold.ungraded)
  .filter(item => (item.gold.requiredStrings?.length ?? 0) > 0 || (item.gold.acceptedAnswers?.length ?? 0) > 0)
  .slice(0, limit);

const traceBefore = newestTrace();
const sizeBefore = traceBefore && existsSync(traceBefore) ? statSync(traceBefore).size : 0;
console.log(`asking ${items.length} labelled questions to collect candidate pools...`);
for (const [index, item] of items.entries()) {
  try {
    await fetch(`${serverUrl}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: item.prompt })
    }).then(r => r.json()).catch(() => ({}));
  } catch { /* a failed turn simply contributes no pool */ }
  if ((index + 1) % 20 === 0) console.log(`  ${index + 1}/${items.length}`);
}

const tracePath = newestTrace();
if (!tracePath) { console.error("no trace file; restart the server with SCCE_TRACE=1"); process.exit(2); }
const raw = readFileSync(tracePath, "utf8");
const body = tracePath === traceBefore ? raw.slice(sizeBefore) : raw;
const pools = new Map();
for (const line of body.split("\n")) {
  if (!line || line.indexOf("local_evidence.rank_features") < 0) continue;
  let event;
  try { event = JSON.parse(line); } catch { continue; }
  if (event.stage !== "local_evidence.rank_features") continue;
  const request = event.support?.request ?? "";
  const rows = event.support?.rows ?? [];
  if (!rows.length) continue;
  // Keep the largest pool seen for a request: the plan's ranker is the one with the full candidate list.
  const existing = pools.get(request);
  if (!existing || rows.length > existing.length) pools.set(request, rows);
}

// ---- build training pairs ------------------------------------------------------------------------------------
const groups = [];
for (const item of items) {
  const key = item.prompt.slice(0, 160);
  const rows = pools.get(key);
  if (!rows || rows.length < 2) continue;
  const positives = [];
  const negatives = [];
  for (const row of rows) {
    const vector = FEATURES.map(name => name === "sourceOrderTerm"
      ? Math.max(0, PUBLIC_CALIBRATIONS["ranking.best.source_order_bonus"] - (row.f.sourceOrderIndex ?? 0) * PUBLIC_CALIBRATIONS["ranking.best.source_order_decay"])
      : Number(row.f[name] ?? 0));
    (carriesGold(row.sentence, item) ? positives : negatives).push(vector);
  }
  if (positives.length && negatives.length) groups.push({ id: item.id, positives, negatives });
}
console.log(`\n${pools.size} candidate pools captured, ${groups.length} questions usable (gold present in the pool)`);
if (groups.length < 8) {
  console.error("too few usable questions to fit anything honest; nothing written");
  process.exit(1);
}

const score = (weights, vector) => vector.reduce((sum, value, index) =>
  sum + (NEGATIVE.has(FEATURES[index]) ? -1 : 1) * weights[index] * value, 0);

function top1Accuracy(weights) {
  let hit = 0;
  for (const group of groups) {
    const best = Math.max(...group.positives.map(v => score(weights, v)));
    const worst = Math.max(...group.negatives.map(v => score(weights, v)));
    if (best > worst) hit++;
  }
  return hit / groups.length;
}

// ---- fit: pairwise logistic, L2 regularised ------------------------------------------------------------------
const start = FEATURES.map(name => shipped[name] ?? 0);
let weights = [...start];
const learningRate = Number(flag("lr", "0.05"));
const l2 = Number(flag("l2", "0.002"));
const epochs = Number(flag("epochs", "400"));
for (let epoch = 0; epoch < epochs; epoch++) {
  const gradient = new Array(FEATURES.length).fill(0);
  let pairs = 0;
  for (const group of groups) {
    for (const positive of group.positives) {
      for (const negative of group.negatives) {
        const diff = positive.map((value, index) => (NEGATIVE.has(FEATURES[index]) ? -1 : 1) * (value - negative[index]));
        const margin = diff.reduce((sum, value, index) => sum + weights[index] * value, 0);
        const sigma = 1 / (1 + Math.exp(margin));
        for (let index = 0; index < gradient.length; index++) gradient[index] += sigma * diff[index];
        pairs++;
      }
    }
  }
  if (!pairs) break;
  for (let index = 0; index < weights.length; index++) {
    weights[index] += learningRate * (gradient[index] / pairs - l2 * weights[index]);
    if (weights[index] < 0) weights[index] = 0; // every term is a bonus or a penalty magnitude, never a sign flip
  }
}

// Rescale to the shipped vector's norm: only relative structure is evidence.
const norm = v => Math.sqrt(v.reduce((sum, value) => sum + value * value, 0));
const shippedNorm = norm(start);
const fittedNorm = norm(weights);
if (fittedNorm > 0) weights = weights.map(value => value * shippedNorm / fittedNorm);

const before = top1Accuracy(start);
const after = top1Accuracy(weights);
console.log(`\ntop-1 accuracy (a gold-bearing sentence outranks every other candidate)`);
console.log(`  shipped: ${(before * 100).toFixed(1)}%   fitted: ${(after * 100).toFixed(1)}%   over ${groups.length} questions\n`);
console.log("coefficient            shipped     fitted");
const profile = {};
FEATURES.forEach((name, index) => {
  const id = FEATURE_TO_ID[name];
  console.log(`  ${name.padEnd(22)} ${String(start[index]).padStart(7)}   ${weights[index].toFixed(3).padStart(8)}${id ? "" : "   (no id yet)"}`);
  if (id) profile[id] = Number(weights[index].toFixed(4));
});

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({
  schema: "scce.ranking_weight_fit.v1",
  generatedAt: new Date().toISOString(),
  questions: groups.length,
  pools: pools.size,
  accuracy: { shipped: before, fitted: after },
  features: FEATURES,
  shipped: start,
  fitted: weights,
  profile
}, null, 2) + "\n", "utf8");
console.log(`\nwrote ${outPath}`);

if (args.has("install")) {
  if (after <= before) {
    console.log("fitted vector does not beat shipped on top-1; NOT installing");
  } else {
    const existing = existsSync(profilePath) ? (JSON.parse(readFileSync(profilePath, "utf8")).calibrations ?? {}) : {};
    mkdirSync(dirname(profilePath), { recursive: true });
    writeFileSync(profilePath, JSON.stringify({
      schema: "scce.prod_calibrations.v1",
      note: "Fitted by tools/fit-ranking-weights.mjs. Not in version control; see private-runtime/README.md.",
      calibrations: { ...existing, ...profile }
    }, null, 2) + "\n", "utf8");
    console.log(`installed ${Object.keys(profile).length} coefficients into ${profilePath}`);
  }
}
