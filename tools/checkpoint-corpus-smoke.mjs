// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const LIVE_RUNNER = fileURLToPath(new URL("./multicorpus-live-acceptance.mjs", import.meta.url));
const CORPUS_LANES = Object.freeze({ wikipedia: "wikipedia", gutenberg: "gutenberg", dolly: "dolly", code: "code", openassistant: "oasst" });
const ENGLISH_CHECKPOINT_CORPORA = Object.freeze(["wikipedia", "gutenberg", "dolly", "code"]);

export function selectCheckpointCases(receipt, requestedCorpora) {
  if (!receipt || receipt.status !== "complete") throw new Error("Checkpoint smoke requires a completed brain receipt");
  if (!Array.isArray(receipt.acceptanceCases)) throw new Error("Completed brain receipt has no acceptance cases");
  const defaults = receipt.selection?.englishOnly === true ? ENGLISH_CHECKPOINT_CORPORA : Object.keys(CORPUS_LANES);
  const requested = [...new Set((requestedCorpora?.length ? requestedCorpora : defaults).map(value => String(value).toLocaleLowerCase()))];
  const selected = [];
  for (const corpus of requested) {
    const lane = CORPUS_LANES[corpus];
    if (!lane) throw new Error(`Unknown checkpoint corpus: ${corpus}`);
    if (receipt.lanes?.[lane]?.included !== true) continue;
    const testCase = receipt.acceptanceCases.find(item => String(item?.corpus).toLocaleLowerCase() === corpus);
    if (!testCase) throw new Error(`Included corpus has no source-bound acceptance case: ${corpus}`);
    selected.push(testCase);
  }
  if (!selected.length) throw new Error("Checkpoint smoke selected no ingested corpus cases");
  return selected;
}

export async function runCheckpointCorpusSmoke(options) {
  const receipt = JSON.parse(await readFile(options.buildReceiptPath, "utf8"));
  const cases = selectCheckpointCases(receipt, options.requestedCorpora);
  await mkdir(path.dirname(options.casesPath), { recursive: true });
  await writeFile(options.casesPath, JSON.stringify({ schema: "scce.checkpoint_corpus_smoke_cases.v1",
    sourceReceipt: options.buildReceiptPath, cases }, null, 2));
  const required = [...new Set(cases.map(item => String(item.corpus).toLocaleLowerCase()))];
  const child = spawn(process.execPath, [LIVE_RUNNER,
    "--config", options.configPath,
    "--cases", options.casesPath,
    "--out", options.outputPath,
    "--required-corpora", required.join(","),
    "--startup-timeout-ms", String(options.startupTimeoutMs),
    "--turn-timeout-ms", String(options.turnTimeoutMs)
  ], { cwd: process.cwd(), stdio: "inherit", windowsHide: true });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => resolve(code));
  });
  if (exitCode !== 0) throw new Error(`Checkpoint corpus smoke failed with exit code ${String(exitCode)}`);
}

function parseArguments(argv, cwd = process.cwd()) {
  const value = flag => {
    const index = argv.indexOf(flag);
    return index < 0 ? undefined : argv[index + 1];
  };
  const config = value("--config"), receipt = value("--build-receipt"), output = value("--out");
  if (!config || !receipt || !output) throw new Error("--config, --build-receipt, and --out are required");
  const corpora = value("--corpora")?.split(",").map(item => item.trim()).filter(Boolean);
  const outputPath = path.resolve(cwd, output);
  return {
    configPath: path.resolve(cwd, config), buildReceiptPath: path.resolve(cwd, receipt), outputPath,
    casesPath: path.resolve(cwd, value("--cases-out") ?? `${output}.cases.json`), requestedCorpora: corpora,
    startupTimeoutMs: positiveInteger(value("--startup-timeout-ms") ?? 300_000, "startup-timeout-ms"),
    turnTimeoutMs: positiveInteger(value("--turn-timeout-ms") ?? 300_000, "turn-timeout-ms")
  };
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} must be a positive safe integer`);
  return number;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(SCRIPT_PATH).href) {
  try {
    await runCheckpointCorpusSmoke(parseArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(JSON.stringify({ schema: "scce.checkpoint_corpus_smoke.v1", status: "failed",
      message: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}
