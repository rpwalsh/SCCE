// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCheckpointCorpusSmoke } from "./checkpoint-corpus-smoke.mjs";
import { recoverBrainBuildPublication } from "./lib/brain-build-publication.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const BUILDER_PATH = fileURLToPath(new URL("./build-5gb-multicorpus-brain.mjs", import.meta.url));

export function brainInitializationUsage() {
  return [
    "Usage:",
    "  node tools/run-brain-initialization.mjs (--fresh-config <empty-brain.json> | --config <base-local-config.json> --output-config <new-ignored-config.json>) --receipt <ignored-receipt.json> [builder options] [supervisor options]",
    "",
    "Supervisor options:",
    "  --node-heap-mb <n>          default 6144; the safety checkpoint is derived below it",
    "  --max-restarts <n>          default 20",
    "  --restart-delay-ms <n>      default 1000",
    "  --checkpoint-smoke-out <p>  run source-bound corpus smoke checks after completion",
    "",
    "All corpus, database budget, target, worker, and --english-only options are forwarded to build-5gb-multicorpus-brain.mjs.",
    "The supervisor owns --resume and adds it only after reading a durable unfinished state."
  ].join("\n");
}

export function parseSupervisorArguments(args, cwd = process.cwd()) {
  const builderArgs = [];
  const supervisor = { nodeHeapMb: 6144, maxRestarts: 20, restartDelayMs: 1000 };
  const own = new Map([
    ["--node-heap-mb", "nodeHeapMb"],
    ["--max-restarts", "maxRestarts"],
    ["--restart-delay-ms", "restartDelayMs"]
  ]);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--resume") throw new Error("run-brain-initialization owns --resume; omit it");
    if (flag === "--checkpoint-smoke-out") {
      const value = args[index + 1];
      if (!value || value.startsWith("--") || supervisor.checkpointSmokeOut) throw new Error("--checkpoint-smoke-out requires one value");
      supervisor.checkpointSmokeOut = path.resolve(cwd, value);
      index++;
      continue;
    }
    const key = own.get(flag);
    if (!key) {
      builderArgs.push(flag);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    supervisor[key] = nonnegativeInteger(value, flag, key === "nodeHeapMb");
    index++;
  }
  const freshConfig = flagValue(builderArgs, "--fresh-config");
  const outputConfig = flagValue(builderArgs, "--output-config");
  const receipt = flagValue(builderArgs, "--receipt");
  const state = flagValue(builderArgs, "--state");
  const config = freshConfig ?? outputConfig;
  if (!config || !receipt) throw new Error("Builder arguments must identify a fresh/output config and receipt");
  const checkpointFlagIndex = builderArgs.indexOf("--heap-checkpoint-mb");
  if (checkpointFlagIndex < 0) {
    builderArgs.push("--heap-checkpoint-mb", String(Math.floor(supervisor.nodeHeapMb * 0.85)));
  } else {
    const checkpointMb = nonnegativeInteger(builderArgs[checkpointFlagIndex + 1], "--heap-checkpoint-mb", true);
    if (checkpointMb >= supervisor.nodeHeapMb) {
      throw new Error("--heap-checkpoint-mb must be smaller than --node-heap-mb");
    }
  }
  return {
    ...supervisor,
    builderArgs,
    configPath: path.resolve(cwd, config),
    statePath: path.resolve(cwd, state ?? `${config}.build-state.json`),
    receiptPath: path.resolve(cwd, receipt)
  };
}

export function classifyInitializationAttempt({ state, exitCode, signal, stoppedByUser }) {
  if (stoppedByUser) return { action: "stop", reason: "user_interrupt" };
  if (state?.status === "complete") return { action: "complete", reason: "brain_complete" };
  if (state?.lastFailure) return { action: "fail", reason: "durable_sccE_failure" };
  if (state?.status === "building") {
    return { action: "retry", reason: signal ? `external_signal:${signal}` : `external_exit:${String(exitCode)}` };
  }
  return { action: "fail", reason: state ? `unexpected_state:${String(state.status)}` : "missing_state" };
}

export async function runBrainInitialization(options) {
  let activeChild;
  let stoppedByUser = false;
  const stop = signal => {
    stoppedByUser = true;
    try { activeChild?.kill(signal); } catch { /* the child may already be gone */ }
  };
  const sigint = () => stop("SIGINT");
  const sigterm = () => stop("SIGTERM");
  process.once("SIGINT", sigint);
  process.once("SIGTERM", sigterm);
  let restarts = 0;
  let unchangedRestarts = 0;
  let previousFingerprint;
  try {
    while (true) {
      await recoverBrainBuildPublication({ statePath: options.statePath, receiptPath: options.receiptPath });
      const before = await readState(options.statePath);
      if (before?.status === "complete") return await printReceipt(options.receiptPath);
      if (before && before.status !== "building") throw new Error(`Initialization state cannot resume from ${String(before.status)}`);
      const resume = before?.status === "building";
      const childArgs = [`--max-old-space-size=${options.nodeHeapMb}`, BUILDER_PATH, ...options.builderArgs, ...(resume ? ["--resume"] : [])];
      const outcome = await new Promise((resolve, reject) => {
        activeChild = spawn(process.execPath, childArgs, { cwd: process.cwd(), stdio: "inherit", windowsHide: true });
        activeChild.once("error", reject);
        activeChild.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
      });
      activeChild = undefined;
      await recoverBrainBuildPublication({ statePath: options.statePath, receiptPath: options.receiptPath });
      const state = await readState(options.statePath);
      const decision = classifyInitializationAttempt({ state, ...outcome, stoppedByUser });
      if (decision.action === "complete") return await printReceipt(options.receiptPath);
      if (decision.action === "stop") {
        process.exitCode = 130;
        return undefined;
      }
      if (decision.action === "fail") throw new Error(`Brain initialization stopped: ${decision.reason}`);
      const fingerprint = progressFingerprint(state);
      unchangedRestarts = fingerprint === previousFingerprint ? unchangedRestarts + 1 : 0;
      previousFingerprint = fingerprint;
      if (unchangedRestarts >= 3) throw new Error("Brain initialization made no durable progress across three restart attempts");
      if (restarts++ >= options.maxRestarts) throw new Error(`Brain initialization exceeded ${options.maxRestarts} automatic restarts`);
      console.error(JSON.stringify({ schema: "scce.brain_initialization_supervisor.v1", status: "resuming", reason: decision.reason,
        restart: restarts, statePath: options.statePath }));
      await delay(options.restartDelayMs);
    }
  } finally {
    process.removeListener("SIGINT", sigint);
    process.removeListener("SIGTERM", sigterm);
  }
}

async function readState(statePath) {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function printReceipt(receiptPath) {
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  if (receipt?.status !== "complete") throw new Error("Initialization state is complete but its public receipt is not complete");
  console.log(JSON.stringify(receipt));
  return receipt;
}

function progressFingerprint(state) {
  if (!state) return "missing";
  const last = Array.isArray(state.batches) ? state.batches.at(-1) : undefined;
  return JSON.stringify({ status: state.status, batches: state.batches?.length ?? 0, reports: state.reports?.length ?? 0,
    afterBytes: last?.afterBytes ?? 0, lastFailure: state.lastFailure ?? null });
}

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function nonnegativeInteger(value, name, positive = false) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < (positive ? 1 : 0)) throw new Error(`${name} must be ${positive ? "a positive" : "a nonnegative"} safe integer`);
  return number;
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(SCRIPT_PATH).href) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(brainInitializationUsage());
  } else try {
    const options = parseSupervisorArguments(process.argv.slice(2));
    const receipt = await runBrainInitialization(options);
    if (receipt && options.checkpointSmokeOut) {
      await runCheckpointCorpusSmoke({
        configPath: options.configPath,
        buildReceiptPath: options.receiptPath,
        outputPath: options.checkpointSmokeOut,
        casesPath: `${options.checkpointSmokeOut}.cases.json`,
        startupTimeoutMs: 300_000,
        turnTimeoutMs: 300_000
      });
    }
  } catch (error) {
    console.error(JSON.stringify({ schema: "scce.brain_initialization_supervisor.v1", status: "failed",
      message: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}
