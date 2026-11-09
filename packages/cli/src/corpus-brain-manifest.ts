// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { open } from "node:fs/promises";
import path from "node:path";
import { createHasher, type InformationLabel, type ScceStorage } from "@scce/kernel";
import { completeInitialSourceBrainFromStoredReports, sourceBrainBuildReceipt, validateStoredSourceBrainPlan,
  type StoredSourceBrainPlan, type SourceBrainFileAdmission } from "@scce/adapters-node";

export interface LoadedCorpusBrainManifest { path: string; hash: string; plan: StoredSourceBrainPlan; byteBudget: number; manifestBytes: number }
export async function readCorpusBrainManifest(manifestPath: string, byteBudget: number, complete = false): Promise<LoadedCorpusBrainManifest> {
  if (!Number.isSafeInteger(byteBudget) || byteBudget <= 0) throw new Error("brain manifest requires an explicit positive byte budget");
  const filename = path.resolve(manifestPath), bytes = await readBounded(filename, byteBudget);
  return { path: filename, hash: createHasher().digestHex(bytes), plan: validateStoredSourceBrainPlan(JSON.parse(bytes.toString("utf8")), complete), byteBudget, manifestBytes: bytes.byteLength };
}

/** The normal producer owns URI/byte/projection preparation; the plan only admits its exact declaration. */
export function plannedSourceFileAdmission(manifest: LoadedCorpusBrainManifest): (source: SourceBrainFileAdmission) => void {
  const byUri = new Map(structuredClone(manifest.plan.selectedItems).map(item => [item.canonicalUri, item]));
  const bareHash = (value: string) => value.replace(/^sha256_/iu, "").toLowerCase();
  return source => {
    const item = byUri.get(source.canonicalUri);
    if (!item) throw new Error(`unplanned source file refused before training: ${source.canonicalUri}`);
    if (!item.sourceFileHash || item.sourceFileHash !== bareHash(source.rawContentHash)
      || bareHash(item.contentHash) !== bareHash(source.sourceContentHash) || item.byteLength !== source.sourceByteLength)
      throw new Error(`planned source file hash/bytes changed before training: ${source.canonicalUri}`);
    if (!Number.isSafeInteger(source.rawByteLength) || source.rawByteLength <= 0 || !source.projections.length)
      throw new Error("invalid source file preparation before training");
    if (!item.projections) {
      if (source.projections.length !== 1 || source.projections.some(row => row.projection !== undefined || row.transformId !== undefined))
        throw new Error("planned source file requires explicit projection declarations before training");
    } else {
      if (item.projections.length !== source.projections.length) throw new Error("planned source projection set changed before training");
      const matched = new Set<number>();
      for (const expected of item.projections) {
        const found = source.projections.flatMap((row, index) => row.sourceSystemId === expected.sourceSystemId
          && (expected.projection === undefined || expected.projection === row.projection)
          && (expected.transformId === undefined || expected.transformId === row.transformId) ? [index] : []);
        if (found.length !== 1 || matched.has(found[0]!)) throw new Error("planned source projection changed or is ambiguous before training");
        matched.add(found[0]!);
      }
    }
  };
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
