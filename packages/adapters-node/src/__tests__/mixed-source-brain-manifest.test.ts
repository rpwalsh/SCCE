// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { assertGenericBrainLifecycleTransition, assertBrainManifestReplayForActivation, createClock, createHasher,
  CORPUS_SOURCE_SYSTEM_IDS, CODE_SURFACE_RECIPE_ID, type SourceVersion, type EvidenceSpan, type IngestionCheckpoint,
  type LanguageProfileSignatureRow, type LanguageIdentityRecord, type BrainLifecycleRecord, type ContentHash } from "@scce/kernel";
import { storageFixtureForEvaluation } from "../../../kernel/src/__tests__/evidence-promotion-evaluation-fixture.js";
import { acquireAndTrainGithubOssRepository } from "../github-oss-acquisition.js";
import { trainOssCorpus } from "../oss-corpus.js";
import { trainGutenbergCorpus } from "../gutenberg-corpus.js";
import { completeInitialSourceBrainFromStoredReports, validateStoredSourceBrainPlan } from "../source-brain-build.js";
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "scce-mixed-brain-")); roots.push(root);
  const code = await readFile(new URL("../path-glob.ts", import.meta.url));
  const docs = await readFile(new URL("../../../../README.md", import.meta.url));
  const alice = (await readFile(new URL("../../../kernel/src/__tests__/fixtures/alice-acquisition-excerpt.txt", import.meta.url), "utf8")).slice(0, 2200);
  const repo = path.join(root, "repo"), books = path.join(root, "books");
  await mkdir(path.join(repo, "src"), { recursive: true }); await mkdir(books);
  await writeFile(path.join(repo, "src", "path-glob.ts"), code); await writeFile(path.join(repo, "README.md"), docs);
  const bookPath = path.join(books, "alice.txt"); await writeFile(bookPath, alice);
  const clock = createClock({ fixedTime: 1 }), hasher = createHasher(), evidence: EvidenceSpan[] = [];
  const { storage } = storageFixtureForEvaluation({ evidence, clockNow: () => clock.now() });
  const versions = new Map<string, SourceVersion>(), blobs = new Map<ContentHash, Uint8Array>(), checkpoints = new Map<string, IngestionCheckpoint>();
  storage.evidence.putSourceVersion = async row => { versions.set(String(row.sourceVersionId), structuredClone(row)); };
  storage.evidence.sourceVersionById = async id => versions.get(String(id)) ?? null;
  storage.evidence.sourceVersionsByContentHashes = async hashes => [...versions.values()].filter(row => hashes.includes(row.contentHash));
  storage.evidence.sourceVersionsForEvidence = async ids => [...versions.values()].filter(row => evidence.some(span => ids.includes(span.id) && span.sourceVersionId === row.sourceVersionId));
  storage.evidence.putEvidenceSpan = async span => { const at = evidence.findIndex(row => row.id === span.id); if (at < 0) evidence.push(span); else evidence[at] = span; };
  storage.evidence.putEvidenceSpans = async rows => { for (const row of rows) await storage.evidence.putEvidenceSpan(row); };
  storage.evidence.searchEvidence = async q => evidence.filter(row => (!q.sourceVersionId || row.sourceVersionId === q.sourceVersionId) && (!q.status || q.status === "any" || row.status === q.status)).slice(0, q.limit).map(span => ({ span, score: 1, reason: "canonical owner" }));
  storage.blobs = { put: async bytes => { const hash = `sha256_${hasher.digestHex(bytes)}` as ContentHash; blobs.set(hash, new Uint8Array(bytes)); return hash; },
    get: async hash => { const bytes = blobs.get(hash); if (!bytes) throw Error("missing canonical bytes"); return bytes; }, exists: async hash => blobs.has(hash) };
  storage.ingestion = { get: async id => checkpoints.get(id) ?? null, put: async row => { checkpoints.set(row.id, structuredClone(row)); }, list: async () => [...checkpoints.values()] };
  storage.model.listLanguageProfileHeaders = async q => (await storage.model.listLanguageProfiles()).filter(row => q.profileIds.includes(row.id)).slice(0, q.limit).map(row => ({ id: row.id, sourceVersionId: row.sourceVersionId }));
  storage.languageMemory.listNgramModelHeaders = async q => (await storage.languageMemory.listNgramModels({ limit: q.modelIds.length })).filter(row => q.modelIds.includes(row.id))
    .map(row => ({ id: row.id, profileId: String((row.modelJson as { profileId: string }).profileId) })).filter(row => !q.profileIds || q.profileIds.includes(row.profileId)).slice(0, q.limit);
  const signatures = new Map<string, LanguageProfileSignatureRow>(), identities = new Map<string, LanguageIdentityRecord>(), assignments = new Map<string, string>();
  storage.languageIdentities = { putProfileSignatures: async input => { for (const row of input.rows) signatures.set(row.id, structuredClone(row)); },
    listProfileSignatures: async q => [...signatures.values()].filter(row => !q.afterId || row.id > q.afterId).sort((a, b) => a.id.localeCompare(b.id)).slice(0, q.limit),
    listIdentities: async () => [...identities.values()], putIdentities: async rows => { for (const row of rows) identities.set(row.id, row); },
    replaceIdentities: async rows => { identities.clear(); for (const row of rows) identities.set(row.id, row); },
    assignProfileLanguages: async rows => { for (const row of rows) assignments.set(row.profileId, row.languageId); },
    listProfileLanguages: async q => [...assignments].filter(([id]) => !q?.profileIds || q.profileIds.includes(id)).map(([profileId, languageId]) => ({ profileId, languageId })) };
  const lifecycles = new Map<string, BrainLifecycleRecord>(); let activeVersion: string | undefined, activeRun: string | undefined;
  storage.brainImports = { ...storage.brainImports,
    active: async () => ({ activeBrainVersion: activeVersion, activeImportRunIds: activeRun ? [activeRun] : [] }),
    getLifecycle: async id => lifecycles.get(id) ?? null, putLifecycle: async row => { lifecycles.set(row.importRunId, structuredClone(row)); }, putLedger: async () => undefined,
    transitionLifecycle: async input => { const row = lifecycles.get(input.importRunId); if (!row || row.state !== input.expectedState) throw Error("CAS mismatch");
      assertGenericBrainLifecycleTransition(row.state, input.toState); const next = { ...row, state: input.toState, revision: row.revision + 1, updatedAt: input.updatedAt, ...(input.validation ? { validation: input.validation } : {}) };
      lifecycles.set(row.importRunId, next); return next; },
    activateReady: async input => { const row = lifecycles.get(input.importRunId); if (!row || row.state !== "READY" || row.validation?.disposition !== "PASSED" || activeRun) throw Error("not qualified READY");
      assertBrainManifestReplayForActivation(row.manifest, hasher); activeVersion = row.brainVersion; activeRun = row.importRunId; row.state = "ACTIVE"; row.revision++;
      return { activeBrainVersion: activeVersion, activeImportRunIds: [activeRun] }; } };
  const sourceUriBase = "fixture://genuine-mixed-repo";
  const plan = validateStoredSourceBrainPlan({ schema: "scce.storedSourceBrainPlan.v1", sourceId: "genuine-mixed-cohort", rootPath: root,
    selectedItems: [
      { canonicalUri: `${sourceUriBase}#path=src%2Fpath-glob.ts`, contentHash: hasher.digestHex(code), sourceFileHash: hasher.digestHex(code), byteLength: code.byteLength,
        projections: [{ sourceSystemId: CORPUS_SOURCE_SYSTEM_IDS.ossCode, projection: "code_surface_tokens", transformId: `${CODE_SURFACE_RECIPE_ID}:code_surface_tokens` },
          { sourceSystemId: CORPUS_SOURCE_SYSTEM_IDS.ossDocs, projection: "code_adjacent_prose" }] },
      { canonicalUri: `${sourceUriBase}#path=README.md`, contentHash: hasher.digestHex(docs), sourceFileHash: hasher.digestHex(docs), byteLength: docs.byteLength,
        projections: [{ sourceSystemId: CORPUS_SOURCE_SYSTEM_IDS.ossDocs, projection: "verbatim" }] },
      { canonicalUri: pathToFileURL(bookPath).href, contentHash: hasher.digestHex(alice), sourceFileHash: hasher.digestHex(alice), byteLength: Buffer.byteLength(alice),
        projections: [{ sourceSystemId: CORPUS_SOURCE_SYSTEM_IDS.gutenberg, transformId: "scce.gutenberg.boilerplate-strip.v1" }] }
    ], reportFiles: [{ path: "oss.json", sha256: "a".repeat(64) }, { path: "books.json", sha256: "b".repeat(64) }] }, true);
  return { root, repo, books, storage, evidence, versions, blobs, plan, lifecycles, code, docs, alice, sourceUriBase, hasher };
}
it("trains genuine code, adjacent prose, documentation and Gutenberg through one explicit physical-file manifest without changing their real owners", async () => {
  const f = await fixture(), settings = { ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64, ngramVocabularyLimit: 128 };
  const oss = await trainOssCorpus({ storage: f.storage, ...settings, rootPath: f.repo, sourceUriBase: f.sourceUriBase, maxFiles: 20, maxFilesPerRun: 20 });
  const books = await trainGutenbergCorpus({ storage: f.storage, ...settings, rootPath: f.books, maxFilesPerRun: 20 });
  expect(oss.filesSkipped).toEqual([]); expect(oss.sourceContractClosure?.complete).toBe(true); expect(books.filesSkipped).toEqual([]);
  expect(oss.reports).toHaveLength(3); expect(books.reports).toHaveLength(1); expect((await f.storage.brainImports.active()).activeImportRunIds).toEqual([]);
  const codeUri = f.plan.selectedItems[0]!.canonicalUri;
  const rawCodeParents = [...f.versions.values()].filter(row => row.role === "original" && row.canonicalUri === codeUri);
  expect(rawCodeParents).toHaveLength(2); expect(new Set(rawCodeParents.map(row => row.sourceVersionId)).size).toBe(2);
  for (const row of rawCodeParents) expect(Buffer.from(await f.storage.blobs.get(row.contentHash))).toEqual(f.code);
  const label = { tenantId: "mixed.owner", principals: ["owner"], compartments: [], exportClass: "restricted" as const, mergePolicy: "isolated" as const };
  const input = { storage: f.storage, informationLabel: label, plan: f.plan, reports: [oss, books], sourceManifestHash: "d".repeat(64) };
  const missing = { ...oss, reports: oss.reports.filter(row => row.sourceSystemId !== CORPUS_SOURCE_SYSTEM_IDS.ossDocs || !row.streamUri.endsWith("src/path-glob.ts")), docsTrained: oss.docsTrained - 1 };
  await expect(completeInitialSourceBrainFromStoredReports({ ...input, reports: [missing, books] })).rejects.toThrow(/projection/);
  await expect(completeInitialSourceBrainFromStoredReports({ ...input, reports: [oss, { ...books, stoppedByHeapSafetyBound: true }] })).rejects.toThrow(/complete normal Gutenberg/);
  const wrong = structuredClone(f.plan); wrong.selectedItems[0]!.projections![0]!.transformId = "foreign-transform";
  await expect(completeInitialSourceBrainFromStoredReports({ ...input, plan: wrong })).rejects.toThrow(/projection/);
  const wrongParent = structuredClone(f.plan); wrongParent.selectedItems[0]!.projections![0]!.originalSourceVersionId = books.reports[0]!.originalSourceVersionId;
  await expect(completeInitialSourceBrainFromStoredReports({ ...input, plan: wrongParent })).rejects.toThrow(/projection/);
  expect(f.lifecycles.size).toBe(0);
  const result = await completeInitialSourceBrainFromStoredReports(input);
  expect(result.active).toBe(true); expect(result.report.checks.every(row => row.passed)).toBe(true);
  expect(result.lifecycle.manifest.content).toMatchObject({ languageShardCount: 4, ngramStateCount: oss.reports.concat(books.reports).reduce((sum, row) => sum + row.ngramModels, 0) });
  expect(rawCodeParents.every(row => result.lifecycle.manifest.replayManifest!.componentIds.includes(String(row.sourceVersionId)))).toBe(true);
  expect((await completeInitialSourceBrainFromStoredReports(input)).idempotent).toBe(true);
});

it("finalizes the ordinary pinned GitHub acquisition envelope from its genuine frozen source bytes and rejects changed commit/inventory", async () => {
  const f = await fixture();
  const provenance = JSON.parse(await readFile(new URL("./fixtures/public-vitest-contract/provenance.json", import.meta.url), "utf8")) as { repository: string; revision: string; files: Array<{ path: string; sha256: string }> };
  const bytes = await readFile(new URL("./fixtures/public-vitest-contract/kernel-answer-primitives.ts.txt", import.meta.url));
  const source = provenance.files.find(row => row.path.endsWith("kernel-answer-primitives.ts"))!;
  expect(f.hasher.digestHex(bytes)).toBe(source.sha256);
  vi.stubEnv("SCCE_ALLOW_AUTOMATIC_WEB", "1");
  const acquired = await acquireAndTrainGithubOssRepository({ storage: f.storage, remoteUrl: `https://github.com/${provenance.repository}`, commitSha: provenance.revision,
    bounds: { maxFiles: 4, maxFileBytes: 20000, maxTotalBytes: 20000, maxDepth: 6 },
    training: { ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64, ngramVocabularyLimit: 128 },
    materializeSnapshot: async input => { const filename = path.join(input.rootPath, source.path); await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, bytes); } });
  expect(acquired.training.reports).toHaveLength(2);
  const uri = `${acquired.training.sourceUriBase}#path=${encodeURIComponent(source.path)}`;
  const plan = validateStoredSourceBrainPlan({ schema: "scce.storedSourceBrainPlan.v1", sourceId: "genuine-github-cohort", rootPath: acquired.remoteUrl,
    selectedItems: [{ canonicalUri: uri, contentHash: source.sha256, sourceFileHash: source.sha256, byteLength: bytes.byteLength,
      projections: [{ sourceSystemId: CORPUS_SOURCE_SYSTEM_IDS.ossCode, projection: "code_surface_tokens" }, { sourceSystemId: CORPUS_SOURCE_SYSTEM_IDS.ossDocs, projection: "code_adjacent_prose" }] }],
    reportFiles: [{ path: "github.json", sha256: "a".repeat(64) }] }, true);
  const input = { storage: f.storage, informationLabel: { tenantId: "mixed.owner", principals: ["owner"], compartments: [], exportClass: "restricted" as const, mergePolicy: "isolated" as const },
    plan, reports: [acquired], sourceManifestHash: "e".repeat(64) };
  await expect(completeInitialSourceBrainFromStoredReports({ ...input, reports: [{ ...acquired, commitSha: "0".repeat(40) }] })).rejects.toThrow(/pinned GitHub/);
  const changed = structuredClone(acquired); changed.files[0]!.byteLength++;
  await expect(completeInitialSourceBrainFromStoredReports({ ...input, reports: [changed] })).rejects.toThrow(/snapshot inventory/);
  expect(f.lifecycles.size).toBe(0);
  const result = await completeInitialSourceBrainFromStoredReports(input);
  expect(result.active).toBe(true); expect(result.report.disposition).toBe("PASSED");
  expect(result.lifecycle.manifest.content.languageShardCount).toBe(2);
  expect((await completeInitialSourceBrainFromStoredReports(input)).idempotent).toBe(true);
});
