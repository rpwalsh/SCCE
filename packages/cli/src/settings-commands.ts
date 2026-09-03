import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  createVideoFrameSource,
  downloadModel,
  formatBytes,
  listLocalModels,
  readLumaWithRawImage,
  removeLocalModel,
  runSensorSource,
  type ScceRuntimeConfig,
  type createNodeRuntime
} from "@scce/adapters-node";
import { isLoopbackHostname } from "@scce/kernel";

/** Phase 6/8 CLI surfaces: interactive settings written back to scce.config.json, local model management, sensor runs. */

type JsonObject = Record<string, unknown>;

function setPath(target: JsonObject, dotted: string, value: unknown): void {
  const keys = dotted.split(".");
  let current: JsonObject = target;
  for (const key of keys.slice(0, -1)) {
    if (typeof current[key] !== "object" || current[key] === null) current[key] = {};
    current = current[key] as JsonObject;
  }
  current[keys[keys.length - 1]!] = value;
}

function getPath(target: JsonObject, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((current, key) => (current && typeof current === "object" ? (current as JsonObject)[key] : undefined), target);
}

export const SETTINGS_FIELDS: Array<{ key: string; prompt: string; kind: "string" | "boolean" | "choice" | "number"; choices?: string[]; validate?: (value: string) => string | undefined }> = [
  { key: "realization.provider", prompt: "Realization provider", kind: "choice", choices: ["native", "ollama", "api"] },
  { key: "realization.ollama.host", prompt: "Ollama host (loopback only)", kind: "string", validate: value => { try { return isLoopbackHostname(new URL(value).hostname) ? undefined : "must be a loopback host"; } catch { return "must be a URL"; } } },
  { key: "realization.ollama.model", prompt: "Ollama model", kind: "string" },
  { key: "realization.apiProvider.endpoint", prompt: "API endpoint (https)", kind: "string", validate: value => /^https:\/\//iu.test(value) ? undefined : "must be https" },
  { key: "realization.apiProvider.model", prompt: "API model", kind: "string" },
  { key: "realization.apiProvider.apiKeyEnv", prompt: "Env var holding the API key (never stored in config)", kind: "string" },
  { key: "realization.apiProvider.acknowledgeRemoteDataExposure", prompt: "Acknowledge that evidence leaves this device when the API provider is used", kind: "boolean" },
  { key: "realization.constrainedDecoding.enabled", prompt: "Enable local constrained-decoding realizer", kind: "boolean" },
  { key: "realization.constrainedDecoding.modelId", prompt: "Constrained-decoding model id", kind: "string" },
  { key: "realization.constrainedDecoding.modelDir", prompt: "Local model directory", kind: "string" },
  { key: "ingestion.visual.embeddings.enabled", prompt: "Enable image / PDF-page visual embeddings", kind: "boolean" },
  { key: "ingestion.visual.embeddings.modelId", prompt: "Visual embedding model id", kind: "string" },
  { key: "ingestion.visual.embeddings.modelDir", prompt: "Visual model directory", kind: "string" }
];

export async function runSettingsCommand(configPath: string, args: string[]): Promise<void> {
  const absolute = path.resolve(configPath);
  const raw = JSON.parse(await readFile(absolute, "utf8")) as JsonObject;
  if (args[0] === "show") {
    for (const field of SETTINGS_FIELDS) process.stdout.write(`${field.key} = ${JSON.stringify(getPath(raw, field.key) ?? null)}\n`);
    return;
  }
  if (args[0] === "set" && args[1]) {
    const field = SETTINGS_FIELDS.find(item => item.key === args[1]);
    if (!field) throw new Error(`unknown setting ${args[1]}`);
    const value = coerce(field, args.slice(2).join(" "));
    const problem = field.validate?.(String(value));
    if (problem) throw new Error(`${field.key}: ${problem}`);
    setPath(raw, field.key, value);
    await writeFile(absolute, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    process.stdout.write(`${field.key} = ${JSON.stringify(value)} written to ${absolute}\n`);
    return;
  }
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    for (const field of SETTINGS_FIELDS) {
      const current = getPath(raw, field.key);
      const hint = field.kind === "choice" ? ` [${field.choices!.join("/")}]` : field.kind === "boolean" ? " [y/n]" : "";
      const answer = (await rl.question(`${field.prompt}${hint} (${JSON.stringify(current ?? "")}): `)).trim();
      if (!answer) continue;
      const value = coerce(field, answer);
      const problem = field.validate?.(String(value));
      if (problem) { process.stdout.write(`  skipped: ${problem}\n`); continue; }
      setPath(raw, field.key, value);
    }
  } finally {
    rl.close();
  }
  await writeFile(absolute, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  process.stdout.write(`settings written to ${absolute}\n`);
}

function coerce(field: (typeof SETTINGS_FIELDS)[number], answer: string): unknown {
  if (field.kind === "boolean") return /^(y|yes|true|1)$/iu.test(answer);
  if (field.kind === "number") return Number(answer);
  if (field.kind === "choice" && !field.choices!.includes(answer)) throw new Error(`${field.key} must be one of ${field.choices!.join(", ")}`);
  return answer;
}

export function modelDirectoryFor(config: ScceRuntimeConfig): string {
  return config.realization?.constrainedDecoding?.modelDir ?? config.ingestion?.visual?.embeddings?.modelDir ?? path.resolve("models");
}

export async function runModelCommand(config: ScceRuntimeConfig, args: string[]): Promise<void> {
  const modelDir = path.resolve(modelDirectoryFor(config));
  const sub = args[0];
  if (sub === "list" || !sub) {
    const models = await listLocalModels(modelDir);
    if (!models.length) { process.stdout.write(`no local models in ${modelDir}\n`); return; }
    const active = [config.realization?.constrainedDecoding?.modelId, config.ingestion?.visual?.embeddings?.modelId].filter(Boolean);
    for (const model of models) process.stdout.write(`${active.includes(model.id) ? "*" : " "} ${model.id}  ${formatBytes(model.bytes)}  ${model.files} files\n`);
    process.stdout.write(`total ${formatBytes(models.reduce((sum, model) => sum + model.bytes, 0))} in ${modelDir}\n`);
    return;
  }
  if (sub === "download" && args[1]) {
    const kind = args.includes("--clip") ? "clip" : "causal-lm";
    process.stdout.write(`downloading ${args[1]} (${kind}) into ${modelDir} -- this is the only network access for models, and you asked for it\n`);
    let lastLine = "";
    const record = await downloadModel({
      modelDir,
      modelId: args[1],
      kind,
      dtype: (args.find(arg => arg.startsWith("--dtype="))?.slice(8) as "q8" | "q4" | "fp16" | "fp32" | undefined) ?? "q8",
      onProgress: progress => {
        const line = `${progress.status} ${progress.file} ${progress.progress ? progress.progress.toFixed(0) + "%" : ""}`;
        if (line !== lastLine) { process.stdout.write(`\r${line.padEnd(100)}`); lastLine = line; }
      }
    });
    process.stdout.write(`\ndownloaded ${record.id}: ${formatBytes(record.bytes)}, ${record.files} files\n`);
    return;
  }
  if (sub === "remove" && args[1]) {
    process.stdout.write((await removeLocalModel(modelDir, args[1])) ? `removed ${args[1]}\n` : `not present: ${args[1]}\n`);
    return;
  }
  throw new Error("usage: scce model list | download <org/name> [--clip] [--dtype=q8] | remove <org/name>");
}

export async function runSensorCommand(config: ScceRuntimeConfig, runtime: ReturnType<typeof createNodeRuntime>, args: string[]): Promise<void> {
  const id = args[1];
  const sensor = config.ingestion?.sensors?.find(item => item.id === id);
  if (args[0] !== "run" || !sensor) throw new Error(`usage: scce sensor run <id>; configured: ${(config.ingestion?.sensors ?? []).map(item => `${item.id}${item.enabled ? "" : " (disabled)"}`).join(", ") || "none"}`);
  if (!sensor.enabled) throw new Error(`sensor ${id} is disabled in config (ingestion.sensors[].enabled)`);
  const source = createVideoFrameSource({ id: sensor.id, kind: sensor.kind, input: sensor.input, fps: sensor.fps, maxFrames: sensor.maxFrames });
  const result = await runSensorSource({
    source,
    readLuma: readLumaWithRawImage,
    changeThreshold: sensor.changeThreshold,
    log: message => process.stderr.write(`[scce] ${message}\n`),
    sink: {
      ingestFile: input => runtime.kernel.ingest({
        path: input.path,
        uri: input.uri,
        metadata: input.metadata as never,
        sourceAdmission: { sourceClass: "owner_local", intendedUse: "direct_evidence", promotionAuthority: "owner" }
      } as never)
    }
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
