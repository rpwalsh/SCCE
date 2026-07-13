#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  EVAL_CATEGORY_IDS,
  blindEvalReportMarkdown,
  createJsonlEvalProvider,
  runBlindPairwiseEval
} from "../../packages/kernel/dist/index.js";

const args = process.argv.slice(2);
const outDir = valueAfter("--out") ?? ".scce/eval";
const answerPath = valueAfter("--answers");
const promptPath = valueAfter("--prompts");
const corpusAblation = args.includes("--corpus-ablation");

if (!promptPath || !answerPath) {
  process.stderr.write("yopp-blind-eval requires --prompts=<jsonl> and --answers=<jsonl>; this repository does not ship canned evaluation answers.\n");
  process.exit(2);
}

if (corpusAblation) {
  process.stderr.write("--corpus-ablation fake scorer was removed. Provide real live condition answers as provider rows in --answers=<jsonl> and compare them with the normal blind eval path.\n");
  process.exit(2);
}

const prompts = await readJsonl(promptPath);
const importedAnswers = await readJsonl(answerPath);
const providerIds = [...new Set(importedAnswers.map(answer => answer.providerId ?? answer.provider_id ?? "provider.local"))];
const providers = providerIds.map(providerId => createJsonlEvalProvider({
  providerId,
  answers: importedAnswers
    .filter(answer => (answer.providerId ?? answer.provider_id ?? "provider.local") === providerId)
    .map(answer => ({
      id: String(answer.id),
      promptId: String(answer.promptId ?? answer.prompt_id),
      providerId,
      text: String(answer.text ?? answer.answer ?? ""),
      metadata: answer.metadata ?? {}
    }))
}));

const { answers, judgments, report, calibrationObservations } = await runBlindPairwiseEval({
  prompts,
  providers,
  judgeId: "judge.local.heuristic",
  baselineProviderId: providerIds[0]
});

await mkdir(outDir, { recursive: true });
await writeJson(path.join(outDir, "blind_eval_report.json"), { report, judgments, answers, calibrationObservations });
await writeJson(path.join(outDir, "calibration_observations.json"), { calibrationObservations });
await writeFile(path.join(outDir, "blind_eval_report.md"), blindEvalReportMarkdown(report), "utf8");
await writeFile(path.join(outDir, "preference_learning_report.md"), preferenceLearningReport(report), "utf8");
await writeFile(path.join(outDir, "proof_preservation_report.md"), proofPreservationReport(report), "utf8");
await writeFile(path.join(outDir, "multilingual_profile_report.md"), multilingualProfileReport(report), "utf8");

process.stdout.write(`Yopp eval reports written to ${path.resolve(outDir)}\n`);
process.stdout.write(`prompts=${report.promptCount} judgments=${report.judgmentCount} hiddenProviderIds=${report.hiddenProviderIds}\n`);

function valueAfter(flag) {
  const direct = args.find(arg => arg.startsWith(`${flag}=`));
  if (direct) return direct.slice(flag.length + 1);
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function readJsonl(filePath) {
  const text = await readFile(path.resolve(filePath), "utf8");
  return text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function preferenceLearningReport(report) {
  return [
    "# Preference Learning Report",
    "",
    "Status: provisional local heuristic.",
    "",
    `Judgments available: ${report.judgmentCount}`,
    "Calibration: no frontier or human preference claim is made unless imported/human judgments are supplied.",
    ""
  ].join("\n");
}

function proofPreservationReport(report) {
  const failureRate = mean(report.categories.map(category => category.protectedSpanFailureRate));
  return [
    "# Proof Preservation Report",
    "",
    `Protected span failure rate: ${percent(failureRate)}`,
    "Invariant source: blind-eval protected-span rubric plus kernel paraphrase regression tests.",
    ""
  ].join("\n");
}

function multilingualProfileReport(report) {
  const multilingual = report.categories.filter(category => category.categoryId === EVAL_CATEGORY_IDS.multilingual || category.categoryId === EVAL_CATEGORY_IDS.translation);
  return [
    "# Multilingual Profile Report",
    "",
    `Profile categories evaluated: ${multilingual.length}`,
    "Sparse profile behavior: no confident fluency claim is made by this report without target-profile evidence.",
    ""
  ].join("\n");
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percent(value) {
  return `${Math.round(value * 1000) / 10}%`;
}
