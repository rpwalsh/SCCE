// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createHasher, type ScceStorage } from "@scce/kernel";
import { parseCorpusTrainOptions } from "../corpus-train-options.js";
const complete = vi.hoisted(() => vi.fn(async (input: unknown) => ({ completed: input })));
vi.mock("@scce/adapters-node", async () => ({
  validateStoredSourceBrainPlan: (await import("../../../adapters-node/src/source-brain-build.js")).validateStoredSourceBrainPlan,
  completeInitialSourceBrainFromStoredReports: complete,
  sourceBrainBuildReceipt: (value: unknown) => value
}));
import { finalizeCorpusBrainManifest, plannedStoredSourceIds, readCorpusBrainManifest, verifyPlannedSourceFiles } from "../corpus-brain-manifest.js";
const roots: string[] = [];
afterEach(async () => { complete.mockClear(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "scce-brain-manifest-")); roots.push(root);
  const hasher = createHasher(), report = JSON.stringify({ schema: "scce.storedCorpusConstructionTrainReport.v1", preserved: "all native fields" });
  const transcript = JSON.stringify({ text: "genuine source bytes are checked by the normal trainer" });
  await writeFile(path.join(root, "report.json"), report); await writeFile(path.join(root, "human.json"), transcript);
  const plan = { schema: "scce.storedSourceBrainPlan.v1", sourceId: "planned-brain", rootPath: root,
    selectedItems: [{ sourceVersionId: "wiki-owned", canonicalUri: "wikipedia://owned", contentHash: "a".repeat(64), byteLength: 64 },
      { canonicalUri: pathToFileURL(path.join(root, "human.json")).href, contentHash: "b".repeat(64), byteLength: 64, sourceFileHash: hasher.digestHex(transcript) }],
    reportFiles: [{ path: "report.json", sha256: hasher.digestHex(report) }] };
  const manifestPath = path.join(root, "plan.json"); await writeFile(manifestPath, JSON.stringify(plan));
  return { root, plan, manifestPath, report, transcript };
}
it("reads the exact pinned manifest/reports through the CLI helper and delegates the whole cohort to canonical validation", async () => {
  const f = await fixture(), manifest = await readCorpusBrainManifest(f.manifestPath, 65536, true);
  expect(parseCorpusTrainOptions([`--brain-manifest=${f.manifestPath}`])).toEqual({ brainManifestPath: f.manifestPath });
  expect(plannedStoredSourceIds(manifest)).toEqual(["wiki-owned"]);
  await verifyPlannedSourceFiles(manifest, f.root);
  await finalizeCorpusBrainManifest({ storage: {} as ScceStorage, informationLabel: { tenantId: "owner", principals: ["owner"], compartments: [], exportClass: "restricted", mergePolicy: "isolated" }, manifestPath: f.manifestPath, maxTotalBytes: 65536 });
  expect(complete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ plan: f.plan, reports: [JSON.parse(f.report)], sourceManifestHash: manifest.hash }));
});
it("refuses changed report/file hashes, foreign stored selection and cumulative byte overflow before activation", async () => {
  const f = await fixture(), manifest = await readCorpusBrainManifest(f.manifestPath, 65536, true);
  expect(() => plannedStoredSourceIds(manifest, ["not-planned"])).toThrow("outside");
  await writeFile(path.join(f.root, "human.json"), "changed");
  await expect(verifyPlannedSourceFiles(manifest, f.root)).rejects.toThrow("file hash changed");
  await writeFile(path.join(f.root, "report.json"), f.report + " ");
  const args = { storage: {} as ScceStorage, informationLabel: { tenantId: "owner", principals: ["owner"], compartments: [], exportClass: "restricted" as const, mergePolicy: "isolated" as const }, manifestPath: f.manifestPath, maxTotalBytes: 65536 };
  await expect(finalizeCorpusBrainManifest(args)).rejects.toThrow("report hash changed");
  await expect(finalizeCorpusBrainManifest({ ...args, maxTotalBytes: manifest.manifestBytes + f.report.length - 1 })).rejects.toThrow("byte budget");
  expect(complete).not.toHaveBeenCalled();
});
it("allows a pre-training report path without a final hash but refuses finalization until it is pinned", async () => {
  const f = await fixture(); const value = { ...f.plan, reportFiles: [{ path: "future-report.json" }] };
  await writeFile(f.manifestPath, JSON.stringify(value));
  expect((await readCorpusBrainManifest(f.manifestPath, 65536)).plan.reportFiles).toEqual(value.reportFiles);
  await expect(readCorpusBrainManifest(f.manifestPath, 65536, true)).rejects.toThrow("report file/hash");
  expect(complete).not.toHaveBeenCalled();
});

it("refuses malformed or duplicate planned projection pins rather than silently discarding constraints", async () => {
  const f = await fixture();
  const projection = { sourceSystemId: "opaque-source-system", projection: "verbatim" };
  for (const projections of [[{ ...projection, sourceVersionID: "misspelled-owner-pin" }], [projection, projection], []]) {
    await writeFile(f.manifestPath, JSON.stringify({ ...f.plan, selectedItems: [{ ...f.plan.selectedItems[0], projections }] }));
    await expect(readCorpusBrainManifest(f.manifestPath, 65536, true)).rejects.toThrow(/projection/);
  }
  expect(complete).not.toHaveBeenCalled();
});
