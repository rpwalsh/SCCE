// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { createHasher } from "@scce/kernel";

const producers = vi.hoisted(() => ({ stored: vi.fn(), dialogue: vi.fn(), oss: vi.fn(), github: vi.fn(), gutenberg: vi.fn() }));
vi.mock("@scce/adapters-node", async importOriginal => ({
  ...await importOriginal<typeof import("@scce/adapters-node")>(), trainStoredCorpusConstructions: producers.stored,
  trainDialogueCorpus: producers.dialogue, trainOssCorpus: producers.oss, acquireAndTrainGithubOssRepository: producers.github,
  trainGutenbergCorpus: producers.gutenberg
}));
type Command = typeof import("../index.js")["corpus"];
let command: Command, root: string, manifestPath: string;
const priorExitCode = process.exitCode;
let stdout: MockInstance<typeof process.stdout.write>;
const kinds = ["stored", "dialogue", "oss", "oss-github", "gutenberg"] as const;
const explicitSelectionKinds = ["stored", "dialogue"] as const;
const ownerLabel = { tenantId: "owner", principals: ["owner"], compartments: [], exportClass: "restricted" as const, mergePolicy: "isolated" as const };
const runtime = { storage: {} } as unknown as NonNullable<Parameters<Command>[0]>;
const config = { security: { defaultSourceInformationLabel: ownerLabel, informationAccess: {
  tenantId: "owner", principalId: "owner", compartments: [], maximumExportClass: "restricted" } }, runtime: {} } as unknown as NonNullable<Parameters<Command>[2]>;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "scce-cli-manifest-completion-"));
  const text = "public test-authored input", hasher = createHasher(), filename = path.join(root, "source.txt");
  await writeFile(filename, text); await writeFile(path.join(root, "prior-report.json"), "{}");
  const manifest = { schema: "scce.storedSourceBrainPlan.v1", sourceId: "cli-owned-source", rootPath: root,
    selectedItems: [{ sourceVersionId: "stored-owned", canonicalUri: "wikipedia://owned", contentHash: "a".repeat(64), byteLength: 64 },
      { canonicalUri: pathToFileURL(filename).href, contentHash: "b".repeat(64), byteLength: Buffer.byteLength(text), sourceFileHash: hasher.digestHex(text) }],
    reportFiles: [{ path: "prior-report.json", sha256: hasher.digestHex("{}") }] };
  manifestPath = path.join(root, "manifest.json"); await writeFile(manifestPath, JSON.stringify(manifest));
  // Import the same production command under its ordinary help startup, without constructing a runtime.
  const argv = process.argv, write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try { process.argv = [process.execPath, "scce", "help"]; command = (await import("../index.js")).corpus; }
  finally { process.argv = argv; write.mockRestore(); }
});
beforeEach(() => { process.exitCode = undefined; stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true); });
afterEach(() => { stdout.mockRestore(); process.exitCode = priorExitCode; vi.clearAllMocks(); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

function details(complete: unknown) {
  const succeeded = complete === true, selected = succeeded ? ["stored-owned"] : Array.from({ length: 29 }, (_, index) => `owned-${index}`);
  return { schema: "scce.storedCorpusConstructionTrainReport.v1", sourcesEnumerated: selected.length, sourcesAttempted: selected.length,
    articlesTrained: succeeded ? selected.length : 0, nextSourceVersionId: "last-owned-source", nextBatchIndex: selected.length, stoppedByHeapSafetyBound: false,
    sourcesSkipped: succeeded ? [] : selected.map(sourceVersionId => ({ sourceVersionId, reason: "canonical source has no original language profile" })),
    contextualQa: { reports: [], deferred: succeeded ? [] : [{ sourceVersionId: "owned-0", reason: "no learned rows" }] },
    ...(complete === undefined ? {} : { selection: { selectedSourceVersionIds: selected, completedSourceVersionIds: succeeded ? selected : [], languageTrainingComplete: complete } }) };
}
async function run(kind: typeof kinds[number], report: unknown, manifest: boolean) {
  const producer = kind === "oss-github" ? producers.github : producers[kind];
  const raw = kind === "oss-github" ? { schema: "scce.githubOssAcquisition.v1", remoteUrl: "https://github.com/owner/repo", files: [{ path: "source.ts", byteLength: 23 }], training: report } : report;
  producer.mockResolvedValueOnce(raw);
  const args = ["train", kind, ...(kind === "stored" ? [] : [kind === "oss-github" ? "https://github.com/owner/repo" : root]),
    ...(kind === "oss-github" ? [`--commit=${"c".repeat(40)}`] : []), ...(manifest ? [`--brain-manifest=${manifestPath}`] : [])];
  await command(runtime, args, config);
  expect(producer).toHaveBeenCalledTimes(1);
  const output = stdout.mock.calls.map(args => String(args[0])).join("");
  expect(JSON.parse(output)).toEqual(raw); // Every cursor, skip reason and typed detail is retained unmodified.
  if (manifest) expect(producer.mock.calls[0]![0]).toMatchObject(kind === "stored"
    ? { sourceVersionIds: ["stored-owned"] } : kind === "oss-github" ? { training: { beforeSourceTraining: expect.any(Function) } } : { beforeSourceTraining: expect.any(Function) });
}

it.each(explicitSelectionKinds)("returns nonzero for an incomplete manifest-driven %s command while preserving the entire report", async kind => {
  await run(kind, details(false), true);
  expect(process.exitCode).toBe(1);
});
it.each(explicitSelectionKinds)("does not treat a missing completion field as manifest success: %s", async kind => {
  await run(kind, details(undefined), true); expect(process.exitCode).toBe(1);
});
it.each(explicitSelectionKinds)("does not treat a truthy non-boolean completion field as manifest success: %s", async kind => {
  await run(kind, details("true"), true); expect(process.exitCode).toBe(1);
});
it.each(explicitSelectionKinds)("permits an explicitly complete manifest-driven %s command", async kind => {
  await run(kind, details(true), true); expect(process.exitCode).toBeUndefined();
});
it.each(kinds)("preserves intentional non-manifest bounded/resume success for %s", async kind => {
  await run(kind, details(false), false); expect(process.exitCode).toBeUndefined();
});
