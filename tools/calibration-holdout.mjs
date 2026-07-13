#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fitAndEvaluateCalibrationObservations } from "../packages/kernel/dist/index.js";

const args = process.argv.slice(2);
const inputPath = valueAfter("--input");
const datasetId = valueAfter("--dataset-id");
const outputDirectory = valueAfter("--out") ?? ".scce/calibration";

if (!inputPath || !datasetId) {
  process.stderr.write("Usage: pnpm calibration:evaluate --input <observations.json|jsonl> --dataset-id <immutable-id> [--out <directory>]\n");
  process.exit(2);
}

const observations = await readObservations(inputPath);
const createdAt = numberAfter("--created-at") ?? observations.reduce((latest, row) => Math.max(latest, finiteNumber(row?.createdAt) ?? 0), 0);
const output = fitAndEvaluateCalibrationObservations({
  observations,
  datasetId,
  seed: valueAfter("--seed"),
  holdoutFraction: numberAfter("--holdout-fraction"),
  minimumFitPoints: numberAfter("--minimum-fit-points"),
  minimumHoldoutPoints: numberAfter("--minimum-holdout-points"),
  binCount: numberAfter("--bin-count"),
  createdAt
});

const resolvedOutput = path.resolve(outputDirectory);
await mkdir(resolvedOutput, { recursive: true });
await writeJson(path.join(resolvedOutput, "calibration-model-set.json"), output.modelSet);
await writeJson(path.join(resolvedOutput, "calibration-holdout-report.json"), output.report);

process.stdout.write(`Calibration holdout report: ${path.join(resolvedOutput, "calibration-holdout-report.json")}\n`);
process.stdout.write(`observations=${output.report.observationCount} evaluated=${output.report.evaluatedModelCount} insufficient=${output.report.insufficientModelCount}\n`);
for (const result of output.report.results) {
  const delta = result.brierDelta === undefined ? "n/a" : result.brierDelta.toFixed(6);
  process.stdout.write(`${result.status.toUpperCase()} ${result.key} fit=${result.split.fitObservationIds.length} holdout=${result.split.holdoutObservationIds.length} brier_delta=${delta}`);
  if (result.reasons.length) process.stdout.write(` reasons=${result.reasons.join(",")}`);
  process.stdout.write("\n");
}

if (args.includes("--require-evaluated") && output.report.evaluatedModelCount === 0) process.exitCode = 1;
if (args.includes("--require-all") && output.report.insufficientModelCount > 0) process.exitCode = 1;

async function readObservations(candidate) {
  const absolute = path.resolve(candidate);
  const text = await readFile(absolute, "utf8");
  if (path.extname(absolute).toLocaleLowerCase() === ".jsonl") return jsonLines(text);
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.calibrationObservations)) return parsed.calibrationObservations;
  if (Array.isArray(parsed?.observations)) return parsed.observations;
  throw new Error("calibration input must be an array or contain calibrationObservations/observations");
}

function jsonLines(text) {
  return text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`invalid JSONL at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
  });
}

function valueAfter(flag) {
  const direct = args.find(arg => arg.startsWith(`${flag}=`));
  if (direct) return direct.slice(flag.length + 1);
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function numberAfter(flag) {
  const value = valueAfter(flag);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${flag} must be finite`);
  return parsed;
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
