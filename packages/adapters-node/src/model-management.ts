// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Local model management (Phase 8). Models live under one directory in the
 * layout transformers.js uses for both its cache and localModelPath
 * (`<modelDir>/<org>/<name>/...`), so a download here is exactly what the
 * local-only runtime loads later. Downloading is the ONLY place remote model
 * access is allowed, and it is an explicit user action.
 */

export type ModelKind = "clip";

export interface LocalModelRecord {
  id: string;
  path: string;
  bytes: number;
  files: number;
}

export interface ModelDownloadProgress {
  file: string;
  progress: number;
  status: string;
}

export async function listLocalModels(modelDir: string): Promise<LocalModelRecord[]> {
  const out: LocalModelRecord[] = [];
  let orgs: string[] = [];
  try { orgs = await readdir(modelDir); } catch { return out; }
  for (const org of orgs) {
    const orgPath = path.join(modelDir, org);
    if (!(await stat(orgPath).catch(() => undefined))?.isDirectory()) continue;
    for (const name of await readdir(orgPath)) {
      const modelPath = path.join(orgPath, name);
      if (!(await stat(modelPath).catch(() => undefined))?.isDirectory()) continue;
      const usage = await directoryUsage(modelPath);
      out.push({ id: `${org}/${name}`, path: modelPath, bytes: usage.bytes, files: usage.files });
    }
  }
  return out.sort((left, right) => left.id.localeCompare(right.id));
}

export async function directoryUsage(directory: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0, files = 0;
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(entryPath);
      else { files++; bytes += (await stat(entryPath)).size; }
    }
  };
  await walk(directory).catch(() => undefined);
  return { bytes, files };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export async function removeLocalModel(modelDir: string, modelId: string): Promise<boolean> {
  const target = path.resolve(modelDir, ...modelId.split("/"));
  if (!target.startsWith(path.resolve(modelDir) + path.sep)) throw new Error(`refusing to remove outside modelDir: ${modelId}`);
  const exists = await stat(target).catch(() => undefined);
  if (!exists) return false;
  await rm(target, { recursive: true, force: true });
  return true;
}

/** Explicit, user-initiated download into modelDir. The only code path that sets allowRemoteModels. */
export async function downloadModel(input: {
  modelDir: string;
  modelId: string;
  kind: ModelKind;
  onProgress?: (progress: ModelDownloadProgress) => void;
}): Promise<LocalModelRecord> {
  await mkdir(input.modelDir, { recursive: true });
  const specifier = "@huggingface/transformers";
  const transformers = await import(specifier) as typeof import("@huggingface/transformers");
  transformers.env.allowRemoteModels = true;
  transformers.env.allowLocalModels = true;
  transformers.env.cacheDir = input.modelDir;
  transformers.env.localModelPath = input.modelDir;
  const progress_callback = (event: { file?: string; progress?: number; status?: string }) =>
    input.onProgress?.({ file: event.file ?? "", progress: Number(event.progress ?? 0), status: event.status ?? "" });
  await transformers.AutoProcessor.from_pretrained(input.modelId, { progress_callback });
  await transformers.AutoTokenizer.from_pretrained(input.modelId, { progress_callback });
  await transformers.CLIPVisionModelWithProjection.from_pretrained(input.modelId, { progress_callback, device: "cpu" });
  await transformers.CLIPTextModelWithProjection.from_pretrained(input.modelId, { progress_callback, device: "cpu" });
  transformers.env.allowRemoteModels = false;
  const modelPath = path.join(input.modelDir, ...input.modelId.split("/"));
  const usage = await directoryUsage(modelPath);
  return { id: input.modelId, path: modelPath, bytes: usage.bytes, files: usage.files };
}
