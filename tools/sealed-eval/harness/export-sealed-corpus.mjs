#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Builds a sealed corpus of any size from the live brain's own bytes.
//
// The existing sealed corpus is four documents and 218 KB. That is enough to check that an answer is a verbatim span
// and enough to check refusal, and it is not enough for anything else: retrieval over four documents is nearly free,
// so a lexical baseline ties, and a corpus-learned language faculty has four documents to be relevant to. Neither the
// architecture's claims nor a fair comparison against a model can be measured on it.
//
// Every document is read from the canonical blob addressed by the source version's own `content_hash`, and each file
// is re-hashed after writing and refused if it does not match. That identity is what lets the evaluation adapter's
// `evidenceSourceAllowlist` bind the run to exactly these bytes: a document that does not hash to its manifest entry
// cannot silently enter the run, and a corpus that drifts fails the harness's own seal check rather than scoring.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { readFileSync } from "node:fs";
import { createCanonicalCorpusReader } from "../../lib/canonical-corpus-read.mjs";

const require = createRequire(path.resolve("packages/adapters-node/src/postgres.ts"));
const { Client } = require("pg");

const args = new Map(process.argv.slice(2).filter(a => a.startsWith("--")).map(a => {
  const at = a.indexOf("=");
  return at < 0 ? [a.slice(2), "true"] : [a.slice(2, at), a.slice(at + 1)];
}));
const outDir = args.get("out") ?? "tools/sealed-eval/artifacts/run-20260906-large";
const limit = Math.max(1, Math.min(5_000, Number(args.get("documents") ?? 200)));
const minBytes = Math.max(1, Number(args.get("min-bytes") ?? 8_000));
const maxBytes = Math.max(minBytes, Number(args.get("max-bytes") ?? 120_000));
const corpusId = args.get("corpus-id") ?? `scce-sealed-${new Date().toISOString().slice(0, 10)}-${limit}`;
const configPath = args.get("config") ?? "scce.config.local.json";
const schema = args.get("schema") ?? "scce3_runtime";
const seed = args.get("seed") ?? "sealed-corpus-v1";
const requestedOutputRoot = path.resolve(outDir);

const config = JSON.parse(readFileSync(configPath, "utf8"));
const client = new Client({ connectionString: config.database.url });
await client.connect();
const corpus = createCanonicalCorpusReader(client, schema);

// Deterministic selection: ordered by a hash of the seed and the source version id, so the same seed selects the same
// documents from the same brain and a reviewer can regenerate the corpus rather than trust this run's output.
const rows = await client.query(
  `select sv.id, sv.content_hash, sv.byte_length, sv.media_type, s.canonical_uri
   from ${schema}.source_versions sv
   join ${schema}.sources s on s.id = sv.source_id
   join ${schema}.blobs b on b.content_hash = sv.content_hash
   where sv.byte_length between $1 and $2
     and s.canonical_uri like 'wikipedia://%'
     and exists (select 1 from ${schema}.evidence_spans e where e.source_version_id = sv.id and e.status = 'promoted')
   order by md5($3 || sv.id)
   limit $4`,
  [minBytes, maxBytes, seed, limit]
);

if (!rows.rowCount) {
  await client.end();
  process.stderr.write("no source versions matched; widen --min-bytes/--max-bytes or check the schema\n");
  process.exit(1);
}

await mkdir(requestedOutputRoot, { recursive: true });
const outputRoot = await realpath(requestedOutputRoot);
const stagingRoot = await mkdtemp(path.join(outputRoot, ".corpus-export-"));
assertContained(outputRoot, stagingRoot);
const corpusDir = path.join(stagingRoot, "corpus");
await mkdir(corpusDir);

const documents = [];
const usedSlugs = new Set();
let rejected = 0;
try { for (const row of rows.rows) {
  const bytes = await corpus.bytes(row.content_hash);
  const digest = createHash("sha256").update(bytes).digest("hex");
  // The declared hash carries the store's own prefix; compare the hex, and refuse anything that disagrees.
  if (`sha256_${digest}` !== row.content_hash || bytes.length !== Number(row.byte_length)) {
    rejected++;
    continue;
  }
  const slug = uniqueSlug(titleFromUri(row.canonical_uri), usedSlugs);
  const relative = `corpus/${slug}.txt`;
  await writeFile(path.join(stagingRoot, relative), bytes);
  const written = createHash("sha256").update(readFileSync(path.join(stagingRoot, relative))).digest("hex");
  if (written !== digest) {
    rejected++;
    continue;
  }
  documents.push({
    documentId: `doc-${slug}`,
    path: relative,
    sha256: digest,
    sizeBytes: bytes.length,
    mediaType: String(row.media_type ?? "text/plain"),
    metadata: { canonicalUri: String(row.canonical_uri), sourceVersionId: String(row.id) }
  });
}} catch (error) {
  await client.end().catch(() => undefined);
  assertContained(outputRoot,await realpath(stagingRoot));
  await rm(stagingRoot,{recursive:true,force:true});
  throw error;
}
await client.end();

const manifest = {
  schemaVersion: "1.0",
  corpusId,
  description: `Sealed corpus exported from the live brain, ${documents.length} documents, byte-identical to their ingested source versions.`,
  createdAt: new Date().toISOString(),
  documents: documents.sort((left, right) => left.documentId.localeCompare(right.documentId))
};
await writeFile(path.join(stagingRoot, "corpus-manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`, "utf8");
await publishStagedExport();

const totalBytes = documents.reduce((sum, document) => sum + document.sizeBytes, 0);
process.stdout.write(`wrote ${documents.length} documents (${(totalBytes / 1_000_000).toFixed(1)} MB) to ${outDir}\n`);
if (rejected) process.stdout.write(`refused ${rejected} whose bytes did not match their declared content hash\n`);

function assertContained(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("sealed export staging and publication paths must stay within the chosen output directory");
  }
}

async function publishStagedExport() {
  const targetCorpus = path.join(outputRoot, "corpus"), targetManifest = path.join(outputRoot, "corpus-manifest.json");
  const stagedManifest = path.join(stagingRoot, "corpus-manifest.json");
  const previousCorpus = path.join(stagingRoot, "previous-corpus"), previousManifest = path.join(stagingRoot, "previous-manifest.json");
  for (const target of [stagingRoot,corpusDir,stagedManifest,targetCorpus,targetManifest,previousCorpus,previousManifest]) assertContained(outputRoot,target);
  const present = async (target, directory) => {
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error("sealed export refuses symbolic link targets");
      if (directory ? !info.isDirectory() : !info.isFile()) throw new Error("sealed export target has an unexpected file type");
      assertContained(outputRoot,await realpath(target));
      return true;
    } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  };
  await present(corpusDir,true); await present(stagedManifest,false);
  const hadCorpus = await present(targetCorpus,true), hadManifest = await present(targetManifest,false);
  let savedCorpus = false, savedManifest = false, installedCorpus = false, installedManifest = false;
  try {
    if (hadCorpus) { await rename(targetCorpus,previousCorpus); savedCorpus = true; }
    if (hadManifest) { await rename(targetManifest,previousManifest); savedManifest = true; }
    await rename(corpusDir,targetCorpus); installedCorpus = true;
    await rename(stagedManifest,targetManifest); installedManifest = true;
  } catch (error) {
    const failures = [error];
    const restore = async work => { try { await work(); } catch (failure) { failures.push(failure); } };
    if (installedManifest) await restore(() => rename(targetManifest,stagedManifest));
    if (installedCorpus) await restore(() => rename(targetCorpus,corpusDir));
    if (savedManifest) await restore(() => rename(previousManifest,targetManifest));
    if (savedCorpus) await restore(() => rename(previousCorpus,targetCorpus));
    if (failures.length > 1) throw new AggregateError(failures, `sealed export rollback failed; retained files in ${stagingRoot}`);
    throw error;
  }
  assertContained(outputRoot,await realpath(stagingRoot));
  await rm(stagingRoot,{recursive:true,force:true});
}

function titleFromUri(uri) {
  const tail = String(uri).split("/").filter(Boolean).at(-1) ?? "document";
  return tail
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase()
    .slice(0, 60) || "document";
}

function uniqueSlug(base, used) {
  let slug = base;
  let index = 2;
  while (used.has(slug)) slug = `${base}-${index++}`;
  used.add(slug);
  return slug;
}
