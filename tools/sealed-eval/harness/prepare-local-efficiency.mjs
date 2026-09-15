#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { argsMap, readJsonl, required, writeJson } from "./lib/util.mjs";

// Reuse the existing developer workload without calling it a fresh holdout.
// This only prepares manifests; the existing run-systems command executes them.
const args = argsMap();
const kit = fileURLToPath(new URL("../", import.meta.url));
const repo = path.resolve(kit, "../..");
const output = path.resolve(required(args, "out"));
const device = args.get("device") ?? "cpu";
if (!["cpu", "gpu"].includes(device)) throw new Error("--device must be cpu or gpu");
const order = args.get("order") ?? "scce-first";
if (!["scce-first", "qwen-first"].includes(order)) throw new Error("--order must be scce-first or qwen-first");
const questionsPath = path.resolve(args.get("questions") ?? path.join(kit, "artifacts/run-20260818/questions-bare.jsonl"));
const corpusManifest = path.resolve(args.get("corpus") ?? path.join(kit, "artifacts/run-20260816/corpus-manifest.json"));
const questions = await readJsonl(questionsPath);
const threads = Number(args.get("threads") ?? availableParallelism());
if (!Number.isSafeInteger(threads) || threads < 1) throw new Error("--threads must be a positive integer");
const systems = [
  {
    systemId: "scce", conditionId: "full", displayName: "SCCE persistent CPU runtime",
    mode: "jsonl-stdio", command: [process.execPath, path.join(kit, "integration/scce-jsonl-adapter.mjs")], cwd: kit,
    env: { SCCE_EVAL_CONDITION: "full", SCCE_EVAL_CONFIG_PATH: path.resolve(args.get("config") ?? path.join(repo, "scce.config.json")), NODE_OPTIONS: "--max-old-space-size=8192" },
    timeoutMs: 1500000, networkPolicy: "local PostgreSQL; source allowlist enforced by existing adapter", assistance: "none"
  },
  {
    systemId: "reference.qwen2.5-3b", conditionId: `rag-${device}`, displayName: `Qwen2.5:3b Q4_K_M local RAG ${device}`,
    mode: "jsonl-stdio", command: [process.execPath, path.join(kit, "harness/adapters/reference-ollama.mjs"), "--model=qwen2.5:3b", "--mode=rag", `--device=${device}`, `--threads=${threads}`, "--num-ctx=4096", "--num-predict=96", "--keep-alive=30m", "--request-timeout-ms=120000"],
    cwd: kit, env: {}, timeoutMs: 180000, networkPolicy: "loopback Ollama only", assistance: "declared local reference model"
  }
];
if (order === "qwen-first") systems.reverse();
// Never replace an earlier run or historical answers.
await mkdir(output, { recursive: false });
const systemManifest = path.join(output, "systems.json");
const planPath = path.join(output, "plan.json");
await writeJson(systemManifest, { schemaVersion: "1.0", systems });
await writeJson(planPath, {
  schemaVersion: "1.0", runId: `development-efficiency-${device}-${path.basename(output)}`,
  evaluationId: "development-rehearsal-existing-20260818-workload",
  corpusManifest, questionsPath, systemManifest, outputDirectory: path.join(output, "results"),
  captureHostConfiguration: true,
  seed: "cloze-full-20260818", clock: "2026-08-18T22:00:00.000Z", questionOrder: "seeded-random", conditionOrder: "source",
  hostPreconditions: { ollamaModelsUnloaded: true },
  powerMeasurement: {
    command: ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(kit, "harness/power/windows-rapl-jsonl.ps1"), "-IntervalMilliseconds", "1000"],
    cwd: repo, startupTimeoutMs: 10000, maxSampleGapMs: 3000
  },
  disclosure: {
    purpose: "Development rehearsal; this question set has already been used for development. Not a fresh held-out proof or completed public review.",
    questionCount: questions.length, order, threads,
    conditionLifecycle: "One adapter process per condition; one already-running Ollama daemon; one resident model through all questions. No explicit warmup; preloaded Ollama models make the cold run fail preflight.",
    energyScope: "Processor-package RAPL, gross including background work; not whole-machine, wall-outlet, or GPU-only energy.",
    preprocessing: "SCCE brain ingestion/training before this run is excluded; Qwen BM25 indexing at adapter startup is included. Report prior preprocessing costs separately before lifecycle-efficiency claims.",
    deadlines: "Existing SCCE adapter has a 10s internal per-turn budget. Qwen has a 120s request timeout; all consumed condition time and energy remain in denominators.",
    gpu: device === "gpu" ? "Separate deployment comparison; verify server Vulkan discovery and recorded GPU residency. Same local model digest required." : "Primary CPU-vs-CPU comparison; Qwen explicitly uses num_gpu=0 and rejects nonzero VRAM residency."
  }
});
console.log(JSON.stringify({ planPath, systemManifest, questionCount: questions.length, device, order }, null, 2));
