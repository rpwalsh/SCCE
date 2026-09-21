#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Fits every calibration id that has outcome data, and reports what the fit is worth on HELD-OUT data.
//
// Promise G7 claims SCCE learns its decision weights from outcomes. This tool establishes how far that is true:
// it enumerates every declared id (CALIBRATION_IDS plus PUBLIC_CALIBRATIONS), counts the observations each one
// actually has, fits the ones that have enough, and scores fitted against bootstrap on a split the fit never saw.
// A converged fit is not evidence: an id whose fitted weights do not beat bootstrap by more than the paired
// standard error of the difference is reported as no-improvement and left uninstalled.
//
// Three sources, all offline -- no server is started or called, and every statement runs READ ONLY:
//   calibration_observations  probability calibration per (id, task class), source-disjoint holdout
//   calibration_observations  judge.requirement_weights softmax coefficients, same source-disjoint holdout
//   .scce/traces              the sentence ranker's weight vector, question-disjoint holdout (opt-in, see below)
//
//   node tools/fit-calibration-from-observations.mjs
//   node tools/fit-calibration-from-observations.mjs --traces          # also fit the ranking vector offline
//   node tools/fit-calibration-from-observations.mjs --install         # write ids that earned it
//   node tools/fit-calibration-from-observations.mjs --config=scce.config.scce6.json --check-config
//   --config (or SCCE_CONFIG) selects the runtime config and its own .local.json overlay;
//   --schema explicitly overrides only the selected database schema.
//
// The ranking source is opt-in because its only labels are the sealed suite's: fitting production constants on
// them would unseal the benchmark, so --install never writes a ranking id no matter how well it scores.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readRuntimeConfig } from "./lib/runtime-config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// SCCE_REPO_ROOT lets a worktree with no install of its own borrow the primary checkout's build.
const repoRoot = process.env.SCCE_REPO_ROOT ? path.resolve(process.env.SCCE_REPO_ROOT) : path.resolve(here, "..");
const args = new Map();
for (let index = 2; index < process.argv.length; index++) {
  const token = process.argv[index];
  if (!token.startsWith("--")) continue;
  const equals = token.indexOf("=");
  if (equals > 0) { args.set(token.slice(2, equals), token.slice(equals + 1)); continue; }
  const next = process.argv[index + 1];
  if (next && !next.startsWith("--")) { args.set(token.slice(2), next); index++; continue; }
  args.set(token.slice(2), "1");
}
const flag = (name, fallback) => args.get(name) ?? fallback;
const seed = flag("seed", "scce.calibration.holdout.v1");
const holdoutFraction = Number(flag("holdout", "0.25"));
// Cost bound: one read of the newest rows, sized so the whole table fits today and a runaway one cannot.
const rowLimit = Number(flag("limit", "50000"));
const binCount = Number(flag("bins", "10"));
const outPath = flag("out", "artifacts/calibration/observation-fit.json");
const profilePath = process.env.SCCE_PROD_CALIBRATIONS ?? "private-runtime/calibration/prod-calibrations.json";
const traceDir = process.env.SCCE_TRACE_DIR ?? ".scce/traces";
const suitePath = flag("suite", "artifacts/head-to-head/suite.json");
if (!Number.isFinite(holdoutFraction) || holdoutFraction <= 0 || holdoutFraction >= 1) throw new Error("--holdout must be within (0,1)");
if (!Number.isFinite(rowLimit) || rowLimit <= 0) throw new Error("--limit must be positive");

const configPath = path.resolve(flag("config", process.env.SCCE_CONFIG ?? path.join(repoRoot, "scce.config.json")));
const config = readRuntimeConfig(configPath);
const databaseUrl = config.database?.url?.trim();
const schema = flag("schema", config.database?.schema);
if (!databaseUrl) throw new Error("database.url is missing from the selected runtime config; set SCCE_DATABASE_URL or its .local.json overlay");
if (!/^[a-z0-9_]+$/u.test(String(schema ?? ""))) throw new Error("schema must be a plain identifier");
// Resolve the exact target without loading a learner, connecting to Postgres, or writing a report.
// Never include the connection URL: it may contain credentials.
if (args.has("check-config")) {
  console.log(JSON.stringify({ configPath, schema, databaseUrlConfigured: true }));
  process.exit(0);
}

const require_ = createRequire(pathToFileURL(path.join(repoRoot, "packages", "adapters-node", "package.json")));
const pg = require_("pg");
const kernel = await import(pathToFileURL(path.join(repoRoot, "packages", "kernel", "dist", "index.js")).href);

const {
  CALIBRATION_IDS, PUBLIC_CALIBRATIONS, PUBLIC_CALIBRATION_IDS, TURN_REQUIREMENT_DIMENSIONS,
  JUDGE_REQUIREMENT_QUALITY_KEYS, buildJudgeRequirementModels, derivedJudgeRequirementFeatures,
  evaluateCalibration, fitAndEvaluateCalibrationObservations, judgeRequirementWeights, createHasher
} = kernel;

const spineIds = [...new Set(Object.values(CALIBRATION_IDS))].sort();
const publicIds = [...PUBLIC_CALIBRATION_IDS].sort();
const declaredIds = [...new Set([...spineIds, ...publicIds])].sort();

// ---- read the observations, read-only ------------------------------------------------------------------------
const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
let coverage = [];
let observations = [];
try {
  await client.query(`SET search_path TO "${schema}"`);
  await client.query("SET statement_timeout TO 120000");
  await client.query("BEGIN READ ONLY");
  coverage = (await client.query(
    `select calibration_id, task_class, subsystem_id, count(*)::int as n,
            count(*) filter (where outcome)::int as positives,
            count(*) filter (where not outcome)::int as negatives,
            count(distinct source_record_id)::int as source_groups
     from calibration_observations group by 1,2,3 order by n desc`
  )).rows;
  observations = (await client.query(
    `select id, calibration_id, subsystem_id, task_class, raw_score, outcome, selected_output_hash, accepted,
            rejected, corrected, unsupported_fact_hit, citation_failure, user_correction_distance, final_outcome,
            source_trace_id, source_record_id, metadata_json, created_at
     from calibration_observations order by created_at desc limit $1`, [rowLimit]
  )).rows.map(observationRecord);
  await client.query("COMMIT");
} finally {
  await client.end();
}

console.log(`observations read: ${observations.length} (limit ${rowLimit}), schema ${schema}`);
console.log(`declared ids: ${declaredIds.length} = ${spineIds.length} CALIBRATION_IDS + ${publicIds.length} PUBLIC_CALIBRATIONS`);

const countsById = new Map();
for (const row of coverage) {
  const previous = countsById.get(row.calibration_id) ?? { n: 0, positives: 0, negatives: 0, sourceGroups: 0, taskClasses: [] };
  countsById.set(row.calibration_id, {
    n: previous.n + row.n,
    positives: previous.positives + row.positives,
    negatives: previous.negatives + row.negatives,
    sourceGroups: previous.sourceGroups + row.source_groups,
    taskClasses: [...previous.taskClasses, row.task_class]
  });
}
const undeclared = [...countsById.keys()].filter(id => !declaredIds.includes(id)).sort();

console.log("\n### observations per declared calibration id");
console.log(`${"calibration id".padEnd(48)} ${"table".padEnd(7)} ${"n".padStart(6)} ${"pos".padStart(6)} ${"neg".padStart(6)} ${"groups".padStart(7)}`);
for (const id of declaredIds) {
  const row = countsById.get(id);
  const table = spineIds.includes(id) ? "spine" : "public";
  console.log(`${id.padEnd(48)} ${table.padEnd(7)} ${String(row?.n ?? 0).padStart(6)} ${String(row?.positives ?? 0).padStart(6)} ${String(row?.negatives ?? 0).padStart(6)} ${String(row?.sourceGroups ?? 0).padStart(7)}`);
}
if (undeclared.length) console.log(`ids present in the table but not declared in source: ${undeclared.join(", ")}`);
const withData = declaredIds.filter(id => (countsById.get(id)?.n ?? 0) > 0);
console.log(`\n${withData.length} of ${declaredIds.length} declared ids carry any observation at all: ${withData.join(", ") || "(none)"}`);

// ---- source A: probability calibration, source-disjoint holdout -------------------------------------------------
const seeds = String(flag("seeds", seed)).split(",").map(value => value.trim()).filter(Boolean);

function evaluateSeed(seedValue, verbose) {
const say = (...parts) => { if (verbose) console.log(...parts); };
const evaluation = fitAndEvaluateCalibrationObservations({
  observations,
  datasetId: `calibration_observations@${schema}`,
  seed: seedValue,
  holdoutFraction,
  binCount
});
const results = [];
say(`\n### probability calibration, source-disjoint holdout (seed "${seed}", holdout ${holdoutFraction})`);
say("base rate = predict the fit split's positive rate for everything; auroc says whether ranking changed at all");
say(`${"key".padEnd(52)} ${"fit".padStart(6)} ${"hold".padStart(6)} ${"brier raw".padStart(11)} ${"brier cal".padStart(11)} ${"brier base".padStart(11)} ${"gain".padStart(10)} ${"se".padStart(9)}`);
for (const result of evaluation.report.results) {
  if (result.status !== "evaluated") {
    say(`${result.key.padEnd(52)} ${String(result.split.fitObservationIds.length).padStart(6)} ${String(result.split.holdoutObservationIds.length).padStart(6)}  INSUFFICIENT ${result.reasons.join(",")}`);
    results.push({ source: "calibration_observations", kind: "probability_calibration", key: result.key, calibrationId: result.calibrationId, status: "insufficient_data", reasons: result.reasons });
    continue;
  }
  const model = evaluation.modelSet.models[result.key];
  const holdoutIds = new Set(result.split.holdoutObservationIds);
  const holdoutRows = observations.filter(row => holdoutIds.has(row.id));
  const paired = pairedSquaredErrorDelta(
    holdoutRows.map(row => ({ raw: row.rawScore, calibrated: kernel.calibrateProbability(row.rawScore, model), outcome: row.outcome }))
  );
  const gain = result.rawMetrics.brier - result.calibratedMetrics.brier;
  const improved = gain > paired.standardError;
  const baseRate = result.fitOutcomeRate;
  const baseRateMetrics = evaluateCalibration(holdoutRows.map(row => ({ predicted: baseRate, actual: row.outcome })), binCount);
  const overBaseRate = summarize(holdoutRows.map(row => {
    const actual = row.outcome ? 1 : 0;
    return (baseRate - actual) ** 2 - (kernel.calibrateProbability(row.rawScore, model) - actual) ** 2;
  }));
  const beatsBaseRate = overBaseRate.mean > overBaseRate.standardError;
  const aurocRaw = auroc(holdoutRows.map(row => ({ score: row.rawScore, outcome: row.outcome })));
  const aurocCalibrated = auroc(holdoutRows.map(row => ({ score: kernel.calibrateProbability(row.rawScore, model), outcome: row.outcome })));
  const verdict = verdictFor({ beatsBootstrap: improved, beatsBaseRate, aurocGain: aurocCalibrated - aurocRaw });
  say(`${result.key.padEnd(52)} ${String(result.split.fitObservationIds.length).padStart(6)} ${String(result.split.holdoutObservationIds.length).padStart(6)} ${result.rawMetrics.brier.toFixed(6).padStart(11)} ${result.calibratedMetrics.brier.toFixed(6).padStart(11)} ${baseRateMetrics.brier.toFixed(6).padStart(11)} ${gain.toFixed(6).padStart(10)} ${paired.standardError.toFixed(6).padStart(9)} ${verdict.status.toUpperCase()}`);
  say(`${"".padEnd(52)} over base rate ${overBaseRate.mean.toFixed(6)} +- ${overBaseRate.standardError.toFixed(6)} ${beatsBaseRate ? "beats base rate" : "NO BETTER THAN BASE RATE"}   auroc raw ${aurocRaw.toFixed(4)} -> calibrated ${aurocCalibrated.toFixed(4)}${verdict.reasons.length ? `   ${verdict.reasons.join(",")}` : ""}`);
  results.push({
    baseRate,
    baseRateBrier: baseRateMetrics.brier,
    gainOverBaseRate: overBaseRate.mean,
    gainOverBaseRateStandardError: overBaseRate.standardError,
    beatsBaseRate,
    aurocRaw,
    aurocCalibrated,
    reasons: verdict.reasons,
    source: "calibration_observations",
    kind: "probability_calibration",
    key: result.key,
    calibrationId: result.calibrationId,
    taskClass: result.taskClass,
    status: verdict.status,
    fitCount: result.split.fitObservationIds.length,
    holdoutCount: result.split.holdoutObservationIds.length,
    fitSourceGroups: result.split.fitSourceGroupIds.length,
    holdoutSourceGroups: result.split.holdoutSourceGroupIds.length,
    splitHash: result.split.splitHash,
    bootstrap: { description: "raw score, uncalibrated", brier: result.rawMetrics.brier, nll: result.rawMetrics.nll, ece: result.rawMetrics.ece },
    fitted: { modelId: result.modelId, brier: result.calibratedMetrics.brier, nll: result.calibratedMetrics.nll, ece: result.calibratedMetrics.ece },
    holdoutGain: gain,
    pairedStandardError: paired.standardError
  });
}

// ---- source A2: judge.requirement_weights coefficients, same source-disjoint holdout ---------------------------
const judgeId = CALIBRATION_IDS.judgeRequirementWeights;
const judgeResult = evaluation.report.results.find(result => result.calibrationId === judgeId);
if (!judgeResult) {
  say(`\n### ${judgeId}: no observations, nothing to fit`);
  results.push({ source: "calibration_observations", kind: "judge_requirement_coefficients", calibrationId: judgeId, status: "no_observations" });
} else {
  const byId = new Map(observations.map(row => [row.id, row]));
  const fitRows = judgeResult.split.fitObservationIds.map(id => byId.get(id)).filter(Boolean);
  const holdoutRows = judgeResult.split.holdoutObservationIds.map(id => byId.get(id)).filter(Boolean);
  const models = buildJudgeRequirementModels({ observations: fitRows });
  const model = models[judgeResult.taskClass];
  if (!model) {
    say(`\n### ${judgeId}: fit produced no model (below minSamples)`);
    results.push({ source: "calibration_observations", kind: "judge_requirement_coefficients", calibrationId: judgeId, status: "insufficient_data", reasons: ["below_min_samples"] });
  } else {
    const modelSet = { schema: "scce.calibration.model_set.v1", id: "fit.holdout", models: {}, judgeRequirementModels: models, observationCount: fitRows.length, createdAt: model.createdAt };
    const points = { bootstrap: [], fitted: [] };
    const squared = [];
    let featureMismatch = 0;
    for (const row of holdoutRows) {
      const sample = judgeSample(row);
      if (!sample) continue;
      if (!featuresAgree(sample)) featureMismatch++;
      const bootstrapProbability = positiveProbability(judgeRequirementWeights({ requirement: sample.requirement }).weights, sample.qualityPositive);
      const fittedProbability = positiveProbability(judgeRequirementWeights({ requirement: sample.requirement, modelSet, taskClass: judgeResult.taskClass, blendTargetSamples: 1 }).weights, sample.qualityPositive);
      const actual = row.outcome ? 1 : 0;
      points.bootstrap.push({ predicted: bootstrapProbability, actual: row.outcome });
      points.fitted.push({ predicted: fittedProbability, actual: row.outcome });
      squared.push((bootstrapProbability - actual) ** 2 - (fittedProbability - actual) ** 2);
    }
    const bootstrapMetrics = evaluateCalibration(points.bootstrap, binCount);
    const fittedMetrics = evaluateCalibration(points.fitted, binCount);
    const paired = summarize(squared);
    const gain = bootstrapMetrics.brier - fittedMetrics.brier;
    const improved = gain > paired.standardError;
    const baseRate = fitRows.filter(row => row.outcome).length / fitRows.length;
    const baseRateMetrics = evaluateCalibration(points.fitted.map(point => ({ predicted: baseRate, actual: point.actual })), binCount);
    const overBaseRate = summarize(points.fitted.map(point => {
      const actual = point.actual ? 1 : 0;
      return (baseRate - actual) ** 2 - (point.predicted - actual) ** 2;
    }));
    const bootstrapAuroc = auroc(points.bootstrap.map(point => ({ score: point.predicted, outcome: point.actual })));
    const fittedAuroc = auroc(points.fitted.map(point => ({ score: point.predicted, outcome: point.actual })));
    const judgeVerdict = verdictFor({ beatsBootstrap: improved, beatsBaseRate: overBaseRate.mean > overBaseRate.standardError, aurocGain: fittedAuroc - bootstrapAuroc });
    const moves = Object.entries(model.coefficients)
      .map(([id, value]) => ({ id, fitted: value, bootstrap: bootstrapCoefficient(id), move: value - bootstrapCoefficient(id) }))
      .sort((left, right) => Math.abs(right.move) - Math.abs(left.move));
    say(`\n### ${judgeId} coefficients, same source-disjoint holdout`);
    say(`fit samples ${model.sampleCount} (${judgeResult.split.fitSourceGroupIds.length} source groups), holdout ${points.fitted.length} (${judgeResult.split.holdoutSourceGroupIds.length} groups), feature-derivation mismatches ${featureMismatch}`);
    say(`  training loss           ${model.trainingLoss.toFixed(6)}`);
    say(`  holdout brier  bootstrap ${bootstrapMetrics.brier.toFixed(6)}   fitted ${fittedMetrics.brier.toFixed(6)}   gain ${gain.toFixed(6)}  paired se ${paired.standardError.toFixed(6)}  ${improved ? "IMPROVED" : "no-improvement"}`);
    say(`  holdout nll    bootstrap ${bootstrapMetrics.nll.toFixed(6)}   fitted ${fittedMetrics.nll.toFixed(6)}`);
    say(`  holdout ece    bootstrap ${bootstrapMetrics.ece.toFixed(6)}   fitted ${fittedMetrics.ece.toFixed(6)}`);
    say(`  holdout brier  base rate ${baseRateMetrics.brier.toFixed(6)} (predict ${baseRate.toFixed(4)} for everything)   fitted beats it by ${overBaseRate.mean.toFixed(6)} +- ${overBaseRate.standardError.toFixed(6)}  ${overBaseRate.mean > overBaseRate.standardError ? "BEATS BASE RATE" : "NO BETTER THAN BASE RATE"}`);
    say(`  holdout auroc  bootstrap ${auroc(points.bootstrap.map(point => ({ score: point.predicted, outcome: point.actual }))).toFixed(4)}   fitted ${auroc(points.fitted.map(point => ({ score: point.predicted, outcome: point.actual }))).toFixed(4)}`);
    say(`  ${judgeVerdict.status.toUpperCase()}${judgeVerdict.reasons.length ? `   ${judgeVerdict.reasons.join(",")}` : ""}`);
    say(`  largest coefficient moves (bootstrap -> fitted):`);
    for (const move of moves.slice(0, 8)) say(`    ${move.id.padEnd(46)} ${move.bootstrap.toFixed(4).padStart(9)} -> ${move.fitted.toFixed(4).padStart(9)}  ${move.move >= 0 ? "+" : ""}${move.move.toFixed(4)}`);
    results.push({
      source: "calibration_observations",
      kind: "judge_requirement_coefficients",
      calibrationId: judgeId,
      taskClass: judgeResult.taskClass,
      status: judgeVerdict.status,
      reasons: judgeVerdict.reasons,
      fitCount: model.sampleCount,
      holdoutCount: points.fitted.length,
      fitSourceGroups: judgeResult.split.fitSourceGroupIds.length,
      holdoutSourceGroups: judgeResult.split.holdoutSourceGroupIds.length,
      splitHash: judgeResult.split.splitHash,
      featureDerivationMismatches: featureMismatch,
      trainingLoss: model.trainingLoss,
      bootstrap: { description: "shipped bootstrap coefficients", ...bootstrapMetrics, auroc: auroc(points.bootstrap.map(point => ({ score: point.predicted, outcome: point.actual }))) },
      fitted: { modelId: model.id, ...fittedMetrics, auroc: auroc(points.fitted.map(point => ({ score: point.predicted, outcome: point.actual }))) },
      holdoutGain: gain,
      pairedStandardError: paired.standardError,
      baseRate,
      baseRateBrier: baseRateMetrics.brier,
      gainOverBaseRate: overBaseRate.mean,
      gainOverBaseRateStandardError: overBaseRate.standardError,
      beatsBaseRate: overBaseRate.mean > overBaseRate.standardError,
      coefficients: Object.fromEntries(moves.map(move => [move.id, { bootstrap: move.bootstrap, fitted: move.fitted }]))
    });
  }
}
return { evaluation, results };
}

const runs = seeds.map((seedValue, index) => ({ seed: seedValue, ...evaluateSeed(seedValue, index === 0) }));
const { evaluation, results } = runs[0];
if (runs.length > 1) {
  console.log(`\n### verdict stability across ${runs.length} source-disjoint splits`);
  const keys = [...new Set(runs.flatMap(run => run.results.map(resultKey)))];
  console.log(`${"id / fit".padEnd(56)} ${seeds.map(value => value.slice(0, 10).padStart(11)).join(" ")}   verdict`);
  for (const key of keys) {
    const perSeed = runs.map(run => run.results.find(result => resultKey(result) === key));
    const cells = perSeed.map(result => (result?.gainOverBaseRate ?? Number.NaN).toFixed(6).padStart(11));
    const improvedCount = perSeed.filter(result => result?.status === "improved").length;
    console.log(`${key.padEnd(56)} ${cells.join(" ")}   improved on ${improvedCount}/${runs.length} splits`);
  }
  console.log("cells are held-out Brier gain over a constant base-rate predictor; a sign that flips is an unstable fit.");
}

// ---- source B: the ranking weight vector, from traces already on disk ------------------------------------------
const profile = {};
if (args.has("traces")) {
  const ranking = fitRankingFromTraces();
  if (ranking) results.push(ranking);
} else {
  console.log(`\n### ranking weight vector: skipped (pass --traces). ${publicIds.length} PUBLIC_CALIBRATIONS ids have no outcome rows at all.`);
}

// An override must survive every split it was tested on, not just the one that happened to flatter it.
const stableOnEverySplit = key => runs.every(run => run.results.find(result => resultKey(result) === key)?.status === "improved");
for (const result of results) {
  if (result.status !== "improved" || !result.installable || !stableOnEverySplit(resultKey(result))) continue;
  Object.assign(profile, result.installable);
}

const improvedIds = [...new Set(results.filter(result => result.status === "improved" && stableOnEverySplit(resultKey(result))).map(result => result.calibrationId ?? result.kind))].sort();

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify({
  schema: "scce.calibration_observation_fit.v1",
  generatedAt: new Date().toISOString(),
  datasetId: evaluation.report.datasetId,
  seed,
  holdoutFraction,
  binCount,
  rowLimit,
  declaredIdCount: declaredIds.length,
  spineIds,
  publicIds,
  observationCount: observations.length,
  idsWithObservations: withData,
  idsWithoutObservations: declaredIds.filter(id => !withData.includes(id)),
  undeclaredIdsInTable: undeclared,
  counts: Object.fromEntries(declaredIds.map(id => [id, countsById.get(id) ?? { n: 0, positives: 0, negatives: 0, sourceGroups: 0, taskClasses: [] }])),
  seeds,
  results,
  perSeed: runs.map(run => ({ seed: run.seed, results: run.results.map(result => ({ key: resultKey(result), status: result.status, reasons: result.reasons ?? [], holdoutGain: result.holdoutGain, gainOverBaseRate: result.gainOverBaseRate, aurocBootstrap: result.aurocRaw ?? result.bootstrap?.auroc, aurocFitted: result.aurocCalibrated ?? result.fitted?.auroc })) })),
  fitSplitModelSet: evaluation.modelSet,
  // What runtime-memory-control.ts builds for itself each cache cycle; emitted so the fitted values are inspectable.
  productionModelSet: kernel.buildCalibrationModelSet({ observations }),
  heldOutEvidenceFor: improvedIds,
  profile,
  profileSchema: "scce.prod_calibrations.v1"
}, null, 2)}\n`, "utf8");
console.log(`\nwrote ${outPath}`);

console.log(`\n${improvedIds.length} of ${declaredIds.length} declared ids beat both bootstrap and the base rate on held-out data across all ${runs.length} split(s): ${improvedIds.join(", ") || "(none)"}`);
console.log(`${Object.keys(profile).length} installable scalar override(s) earned`);
console.log("the two fitted ids need no file: runtime-memory-control.ts refits them from this same table on every cache cycle.");

if (args.has("install")) {
  if (!Object.keys(profile).length) {
    console.log("nothing earned a production override; prod-calibrations.json untouched");
  } else {
    const existing = existsSync(profilePath) ? (JSON.parse(readFileSync(profilePath, "utf8")).calibrations ?? {}) : {};
    mkdirSync(path.dirname(profilePath), { recursive: true });
    writeFileSync(profilePath, `${JSON.stringify({
      schema: "scce.prod_calibrations.v1",
      note: "Fitted by tools/fit-calibration-from-observations.mjs on held-out evidence. Not in version control; see private-runtime/README.md.",
      calibrations: { ...existing, ...profile }
    }, null, 2)}\n`, "utf8");
    console.log(`installed ${Object.keys(profile).length} value(s) into ${profilePath}`);
  }
}

// ---- helpers ---------------------------------------------------------------------------------------------------
function observationRecord(row) {
  const record = {
    schema: "scce.calibration.observation.v1",
    id: row.id,
    calibrationId: row.calibration_id,
    subsystemId: row.subsystem_id,
    taskClass: row.task_class,
    rawScore: Number(row.raw_score),
    outcome: row.outcome === true,
    finalOutcome: row.final_outcome,
    sourceRecordId: row.source_record_id ?? "",
    metadata: row.metadata_json ?? {},
    createdAt: new Date(row.created_at).getTime()
  };
  if (row.selected_output_hash) record.selectedOutputHash = row.selected_output_hash;
  if (row.source_trace_id) record.sourceTraceId = row.source_trace_id;
  for (const [field, column] of [["accepted", "accepted"], ["rejected", "rejected"], ["corrected", "corrected"], ["unsupportedFactHit", "unsupported_fact_hit"], ["citationFailure", "citation_failure"]]) {
    if (row[column] !== null && row[column] !== undefined) record[field] = row[column];
  }
  if (row.user_correction_distance !== null && row.user_correction_distance !== undefined) record.userCorrectionDistance = Number(row.user_correction_distance);
  return record;
}

function judgeSample(row) {
  const metadata = row.metadata ?? {};
  if (metadata.schema !== "scce.judge_requirement.observation.v1") return undefined;
  const features = metadata.requirementFeatures ?? {};
  const qualityPositive = metadata.qualityPositive ?? {};
  const requirement = {};
  for (const dimension of TURN_REQUIREMENT_DIMENSIONS) {
    const value = features[dimension];
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    requirement[dimension] = value;
  }
  for (const key of JUDGE_REQUIREMENT_QUALITY_KEYS) {
    if (typeof qualityPositive[key] !== "number" || !Number.isFinite(qualityPositive[key])) return undefined;
  }
  return { requirement, qualityPositive, storedFeatures: features };
}

// The observation stores derived features, not the requirement field; this proves the reconstruction is exact.
function featuresAgree(sample) {
  const rederived = derivedJudgeRequirementFeatures(sample.requirement);
  return Object.entries(rederived).every(([key, value]) => Math.abs(value - (sample.storedFeatures[key] ?? value)) < 1e-9);
}

function positiveProbability(weights, qualityPositive) {
  const blended = JUDGE_REQUIREMENT_QUALITY_KEYS.reduce((sum, key) => sum + weights[key] * qualityPositive[key], 0);
  return 1 / (1 + Math.exp(-blended));
}

function bootstrapCoefficient(paramId) {
  return judgeRequirementWeights({ requirement: Object.fromEntries(TURN_REQUIREMENT_DIMENSIONS.map(dimension => [dimension, 0])) }).coefficients[paramId] ?? 0;
}

function pairedSquaredErrorDelta(rows) {
  return summarize(rows.map(row => {
    const actual = row.outcome ? 1 : 0;
    return (row.raw - actual) ** 2 - (row.calibrated - actual) ** 2;
  }));
}

function resultKey(result) {
  return `${result.calibrationId ?? result.kind} / ${result.kind}`;
}

// A fit earns "improved" only by beating BOTH bootstrap and a constant predictor; beating bootstrap alone can
// mean the bootstrap score was never a probability. Ranking-only gains are named, not counted as improvement.
function verdictFor(input) {
  const reasons = [];
  if (!input.beatsBootstrap) reasons.push("no_gain_over_bootstrap");
  if (!input.beatsBaseRate) reasons.push("loses_to_base_rate");
  if (!reasons.length) return { status: "improved", reasons };
  if (input.aurocGain > 0) return { status: "improved_discrimination_only", reasons };
  return { status: "no_improvement", reasons };
}

// Rank discrimination. A monotone recalibration cannot move it, which is how a reader tells the two apart.
function auroc(rows) {
  const positives = rows.filter(row => row.outcome).length;
  const negatives = rows.length - positives;
  if (!positives || !negatives) return 0.5;
  const ordered = [...rows].sort((left, right) => left.score - right.score);
  const ranks = new Array(ordered.length);
  for (let index = 0; index < ordered.length;) {
    let end = index;
    while (end + 1 < ordered.length && ordered[end + 1].score === ordered[index].score) end++;
    const averageRank = (index + end) / 2 + 1;
    for (let inner = index; inner <= end; inner++) ranks[inner] = averageRank;
    index = end + 1;
  }
  const positiveRankSum = ordered.reduce((sum, row, index) => sum + (row.outcome ? ranks[index] : 0), 0);
  return (positiveRankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

function summarize(values) {
  if (values.length < 2) return { mean: 0, standardError: Number.POSITIVE_INFINITY, count: values.length };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return { mean, standardError: Math.sqrt(variance / values.length), count: values.length };
}

function fitRankingFromTraces() {
  // Mirrors tools/fit-ranking-weights.mjs's feature map; that tool collects live, this one reads traces on disk.
  const featureToId = {
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
  const features = [...Object.keys(featureToId), "sourceOrderTerm"];
  const negative = new Set(["fragmentCount"]);
  if (!existsSync(traceDir) || !existsSync(suitePath)) {
    console.log(`\n### ranking weight vector: no inputs (${traceDir}, ${suitePath})`);
    return undefined;
  }
  const suite = JSON.parse(readFileSync(suitePath, "utf8"));
  const items = suite.items.filter(item => !item.gold.unanswerable && !item.gold.ungraded
    && ((item.gold.requiredStrings?.length ?? 0) > 0 || (item.gold.acceptedAnswers?.length ?? 0) > 0));
  const pools = new Map();
  for (const file of readdirSync(traceDir).filter(name => name.endsWith(".jsonl"))) {
    for (const line of readFileSync(path.join(traceDir, file), "utf8").split("\n")) {
      if (!line || line.indexOf("local_evidence.rank_features") < 0) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.stage !== "local_evidence.rank_features") continue;
      const rows = event.support?.rows ?? [];
      const request = event.support?.request ?? "";
      if (!rows.length) continue;
      const existing = pools.get(request);
      if (!existing || rows.length > existing.length) pools.set(request, rows);
    }
  }
  const normalize = value => String(value).replace(/\s+/gu, " ").trim().toLowerCase();
  const carriesGold = (sentence, item) => {
    const spoken = normalize(sentence);
    const required = item.gold.requiredStrings ?? [];
    const accepted = item.gold.acceptedAnswers ?? [];
    if (required.length) return required.every(text => normalize(text).split(/[\s,]+/u).filter(Boolean).every(part => spoken.includes(part)));
    return accepted.some(text => spoken.includes(normalize(text)));
  };
  const vectorFor = row => features.map(name => name === "sourceOrderTerm"
    ? Math.max(0, PUBLIC_CALIBRATIONS["ranking.best.source_order_bonus"] - (row.f.sourceOrderIndex ?? 0) * PUBLIC_CALIBRATIONS["ranking.best.source_order_decay"])
    : Number(row.f[name] ?? 0));
  const groups = [];
  for (const item of items) {
    const rows = pools.get(item.prompt.slice(0, 160));
    if (!rows || rows.length < 2) continue;
    const positives = [];
    const negatives = [];
    for (const row of rows) (carriesGold(row.sentence, item) ? positives : negatives).push(vectorFor(row));
    if (positives.length && negatives.length) groups.push({ id: item.id, positives, negatives });
  }
  if (groups.length < 2) {
    console.log(`\n### ranking weight vector: ${groups.length} usable question(s) in ${pools.size} pools; nothing honest to fit`);
    return { source: "traces", kind: "ranking_weight_vector", status: "insufficient_data", reasons: ["too_few_usable_questions"], usableQuestions: groups.length, pools: pools.size };
  }
  const hasher = createHasher();
  const ordered = [...groups].sort((left, right) => {
    const leftHash = hasher.digestHex(`${seed}ranking${left.id}`);
    const rightHash = hasher.digestHex(`${seed}ranking${right.id}`);
    return leftHash < rightHash ? -1 : leftHash > rightHash ? 1 : (left.id < right.id ? -1 : 1);
  });
  const holdoutCount = Math.max(1, Math.min(ordered.length - 1, Math.round(ordered.length * holdoutFraction)));
  const holdout = ordered.slice(0, holdoutCount);
  const fit = ordered.slice(holdoutCount);
  const shipped = features.map(name => name === "sourceOrderTerm" ? 1 : PUBLIC_CALIBRATIONS[featureToId[name]]);
  const score = (weights, vector) => vector.reduce((sum, value, index) => sum + (negative.has(features[index]) ? -1 : 1) * weights[index] * value, 0);
  const top1 = (weights, set) => set.filter(group =>
    Math.max(...group.positives.map(vector => score(weights, vector))) > Math.max(...group.negatives.map(vector => score(weights, vector)))).length / set.length;
  let weights = [...shipped];
  const learningRate = Number(flag("lr", "0.05"));
  const l2 = Number(flag("l2", "0.002"));
  const epochs = Number(flag("epochs", "400"));
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradient = new Array(features.length).fill(0);
    let pairs = 0;
    for (const group of fit) {
      for (const positive of group.positives) {
        for (const negativeVector of group.negatives) {
          const difference = positive.map((value, index) => (negative.has(features[index]) ? -1 : 1) * (value - negativeVector[index]));
          const margin = difference.reduce((sum, value, index) => sum + weights[index] * value, 0);
          const sigma = 1 / (1 + Math.exp(margin));
          for (let index = 0; index < gradient.length; index++) gradient[index] += sigma * difference[index];
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
  const norm = vector => Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  const shippedNorm = norm(shipped);
  const fittedNorm = norm(weights);
  if (fittedNorm > 0) weights = weights.map(value => value * shippedNorm / fittedNorm);
  const bootstrapHoldout = top1(shipped, holdout);
  const fittedHoldout = top1(weights, holdout);
  const bootstrapFit = top1(shipped, fit);
  const fittedFit = top1(weights, fit);
  const outcomes = holdout.map(group => {
    const bootstrapHit = Math.max(...group.positives.map(vector => score(shipped, vector))) > Math.max(...group.negatives.map(vector => score(shipped, vector))) ? 1 : 0;
    const fittedHit = Math.max(...group.positives.map(vector => score(weights, vector))) > Math.max(...group.negatives.map(vector => score(weights, vector))) ? 1 : 0;
    return fittedHit - bootstrapHit;
  });
  const paired = summarize(outcomes);
  console.log(`\n### ranking weight vector, question-disjoint holdout (seed "${seed}", holdout ${holdoutFraction})`);
  console.log(`pools ${pools.size}, usable questions ${groups.length} -> fit ${fit.length} / holdout ${holdout.length}`);
  console.log(`  top-1 on FIT questions      bootstrap ${(bootstrapFit * 100).toFixed(1)}%   fitted ${(fittedFit * 100).toFixed(1)}%   (in-sample, not evidence)`);
  console.log(`  top-1 on HELD-OUT questions bootstrap ${(bootstrapHoldout * 100).toFixed(1)}%   fitted ${(fittedHoldout * 100).toFixed(1)}%   gain ${((fittedHoldout - bootstrapHoldout) * 100).toFixed(1)}pp  paired se ${(paired.standardError * 100).toFixed(1)}pp`);
  console.log("  coefficient                 bootstrap     fitted");
  const fittedById = {};
  features.forEach((name, index) => {
    const id = featureToId[name];
    console.log(`    ${name.padEnd(24)} ${String(shipped[index]).padStart(9)}   ${weights[index].toFixed(3).padStart(9)}${id ? "" : "   (no id)"}`);
    if (id) fittedById[id] = Number(weights[index].toFixed(4));
  });
  const improved = (fittedHoldout - bootstrapHoldout) > paired.standardError;
  console.log(`  ${improved ? "IMPROVED on held-out questions" : "no-improvement on held-out questions"}; NOT installable either way -- the only labels are the sealed suite's.`);
  return {
    source: "traces",
    kind: "ranking_weight_vector",
    calibrationId: "ranking.*",
    status: improved ? "improved" : "no_improvement",
    installBlocked: "labels come from the sealed suite; installing would unseal the benchmark",
    pools: pools.size,
    usableQuestions: groups.length,
    fitCount: fit.length,
    holdoutCount: holdout.length,
    bootstrap: { top1Holdout: bootstrapHoldout, top1Fit: bootstrapFit },
    fitted: { top1Holdout: fittedHoldout, top1Fit: fittedFit, values: fittedById },
    holdoutGain: fittedHoldout - bootstrapHoldout,
    pairedStandardError: paired.standardError
  };
}
