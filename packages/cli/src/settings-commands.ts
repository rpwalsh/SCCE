// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  SETTINGS_FIELDS,
  applySetting,
  createVideoFrameSource,
  downloadModel,
  formatBytes,
  getSettingPath,
  listLocalModels,
  readLumaWithRawImage,
  removeLocalModel,
  runSensorSource,
  type ScceRuntimeConfig,
  type createNodeRuntime
} from "@scce/adapters-node";

export { SETTINGS_FIELDS };

/** Phase 6/8 CLI surfaces: settings written back to scce.config.json through the shared schema, local model management, sensor runs. */

export async function runSettingsCommand(configPath: string, args: string[]): Promise<void> {
  const absolute = path.resolve(configPath);
  const raw = JSON.parse(await readFile(absolute, "utf8")) as Record<string, unknown>;
  const sub = args[0];
  if (sub === "show" || sub === "list") {
    for (const field of SETTINGS_FIELDS) process.stdout.write(`${field.key} = ${JSON.stringify(getSettingPath(raw, field.key) ?? null)}\n`);
    return;
  }
  if (sub === "get" && args[1]) {
    if (!SETTINGS_FIELDS.some(field => field.key === args[1])) throw new Error(`unknown setting ${args[1]}; see: scce settings show`);
    process.stdout.write(`${JSON.stringify(getSettingPath(raw, args[1]) ?? null)}\n`);
    return;
  }
  if (sub === "set" && args[1]) {
    const value = applySetting(raw, args[1], args.slice(2).join(" "));
    await writeFile(absolute, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    process.stdout.write(`${args[1]} = ${JSON.stringify(value)} written to ${absolute}\n`);
    return;
  }
  if (sub && sub !== "edit") throw new Error("usage: scce settings show | get <key> | set <key> <value> | edit");
  if (!stdin.isTTY) throw new Error("scce settings edit needs an interactive terminal; use show, get, or set");
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    for (const field of SETTINGS_FIELDS) {
      const current = getSettingPath(raw, field.key);
      const hint = field.kind === "choice" ? ` [${field.choices!.join("/")}]` : field.kind === "boolean" ? " [y/n]" : "";
      const answer = (await rl.question(`${field.label}${hint} (${JSON.stringify(current ?? "")}): `)).trim();
      if (!answer) continue;
      try {
        applySetting(raw, field.key, answer);
      } catch (error) {
        process.stdout.write(`  skipped: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  } finally {
    rl.close();
  }
  await writeFile(absolute, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  process.stdout.write(`settings written to ${absolute}\n`);
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
    process.stdout.write(`downloading ${args[1]} (${kind}) into ${modelDir} -- the only network access for models, and you asked for it\n`);
    let lastLine = "";
    const record = await downloadModel({
      modelDir,
      modelId: args[1],
      kind,
      dtype: (args.find(arg => arg.startsWith("--dtype="))?.slice(8) as "q8" | "q4" | "fp16" | "fp32" | undefined) ?? "q8",
      onProgress: progress => {
        const line = `${progress.status} ${progress.file} ${progress.progress ? `${progress.progress.toFixed(0)}%` : ""}`;
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
