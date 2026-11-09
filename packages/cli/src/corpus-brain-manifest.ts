// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHasher, type InformationLabel, type ScceStorage } from "@scce/kernel";
import { completeInitialSourceBrainFromStoredReports, sourceBrainBuildReceipt, validateStoredSourceBrainPlan,
  type StoredSourceBrainPlan } from "@scce/adapters-node";

export interface LoadedCorpusBrainManifest { path: string; hash: string; plan: StoredSourceBrainPlan; byteBudget: number; manifestBytes: number }
export async function readCorpusBrainManifest(manifestPath: string, byteBudget: number, complete = false): Promise<LoadedCorpusBrainManifest> {
  if (!Number.isSafeInteger(byteBudget) || byteBudget <= 0) throw new Error("brain manifest requires an explicit positive byte budget");
  const filename = path.resolve(manifestPath), bytes = await readBounded(filename, byteBudget);
  return { path: filename, hash: createHasher().digestHex(bytes), plan: validateStoredSourceBrainPlan(JSON.parse(bytes.toString("utf8")), complete), byteBudget, manifestBytes: bytes.byteLength };
}

/** File hashes are checked before normal file training; canonical decoded source hashes are checked at finalization. */
export async function verifyPlannedSourceFiles(manifest: LoadedCorpusBrainManifest, rootPath: string): Promise<void> {
  const root = path.resolve(rootPath), hasher = createHasher(); let count = 0;
  for (const item of manifest.plan.selectedItems) {
    if (!item.sourceFileHash || !item.canonicalUri.startsWith("file:")) continue;
    const filename = fileURLToPath(item.canonicalUri), relative = path.relative(root, filename);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) continue;
    const bytes = await readBounded(filename, manifest.byteBudget);
    if (hasher.digestHex(bytes) !== item.sourceFileHash) throw new Error(`planned source file hash changed: ${item.canonicalUri}`);
    count++;
  }
  if (!count) throw new Error("brain manifest contains no planned source files under this training root");
}
export function plannedStoredSourceIds(manifest: LoadedCorpusBrainManifest, requested?: readonly string[]): string[] {
  const all = manifest.plan.selectedItems.filter(item => !item.sourceFileHash).map(item => item.sourceVersionId!);
  if (!all.length || all.some(id => !id)) throw new Error("brain manifest contains no exact stored source owners");
  if (requested && (!requested.length || requested.some(id => !all.includes(id)))) throw new Error("stored training selection is outside the planned brain cohort");
  return requested ? [...requested] : all;
}
export async function finalizeCorpusBrainManifest(input: { storage: ScceStorage; informationLabel: InformationLabel; manifestPath: string; maxTotalBytes: number }) {
  const manifest = await readCorpusBrainManifest(input.manifestPath, input.maxTotalBytes, true);
  const reports: unknown[] = []; let remaining = manifest.byteBudget - manifest.manifestBytes;
  for (const file of manifest.plan.reportFiles) {
    const filename = path.resolve(path.dirname(manifest.path), file.path), bytes = await readBounded(filename, remaining);
    remaining -= bytes.byteLength;
    if (createHasher().digestHex(bytes) !== file.sha256) throw new Error(`planned training report hash changed: ${file.path}`);
    reports.push(JSON.parse(bytes.toString("utf8")));
  }
  return sourceBrainBuildReceipt(await completeInitialSourceBrainFromStoredReports({ storage: input.storage, informationLabel: input.informationLabel,
    plan: manifest.plan, reports, sourceManifestHash: manifest.hash, configuration: { maxTotalBytes: input.maxTotalBytes } }));
}
async function readBounded(filename: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(filename, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error(`brain manifest/report exceeds the declared byte budget: ${filename}`);
    const bytes = Buffer.alloc(info.size); let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new Error(`brain manifest/report changed during read: ${filename}`);
      offset += read.bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead) throw new Error(`brain manifest/report changed during read: ${filename}`);
    return bytes;
  } finally { await handle.close(); }
}
