// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function validatePinnedArtifact(bytes, pin) {
  assert.equal(bytes.length, pin.bytes, "source differs from its pinned byte size");
  assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), pin.gitBlobSha1, "source differs from its pinned Git blob");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), pin.sha256, "source differs from its pinned SHA-256");
}

export async function acquireCoreferenceSources(cachePath) {
  assert(cachePath, "an explicit cache directory outside the repository is required");
  const cacheRoot = resolve(cachePath);
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const inRepository = relative(repositoryRoot, cacheRoot);
  assert(inRepository && (inRepository === ".." || inRepository.startsWith(`..${sep}`) || isAbsolute(inRepository)), "source cache must be outside the repository");
  const catalog = JSON.parse(await readFile(new URL("./source-catalog.json", import.meta.url), "utf8"));
  const records = [];
  for (const source of catalog.sources) {
    assert.match(source.repository, /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/u);
    assert.match(source.commit, /^[a-f0-9]{40}$/u);
    const directory = join(cacheRoot, source.repository.replaceAll("/", "__"), source.commit);
    await mkdir(directory, { recursive: true });
    for (const pin of source.files) {
      assert.match(pin.file, /^[A-Za-z0-9_.-]+$/u);
      const path = join(directory, pin.file);
      const url = `https://raw.githubusercontent.com/${source.repository}/${source.commit}/${pin.file}`;
      let bytes = await readFile(path).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
      if (!bytes) {
        const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        assert.equal(response.status, 200, "pinned source could not be fetched");
        assert.equal(new URL(response.url).hostname, "raw.githubusercontent.com");
        assert(response.body, "pinned source returned no body");
        const chunks = [];
        let length = 0;
        for await (const chunk of response.body) {
          length += chunk.length;
          assert(length <= pin.bytes, "source exceeds its pinned byte size");
          chunks.push(chunk);
        }
        bytes = Buffer.concat(chunks, length);
        validatePinnedArtifact(bytes, pin);
        await writeFile(path, bytes, { flag: "wx" });
      }
      validatePinnedArtifact(bytes, pin);
      if (pin.role === "license") assert(bytes.toString("utf8").includes("https://creativecommons.org/licenses/by/4.0/legalcode"), "pinned source license declaration changed");
      const { files: _files, ...ownership } = source;
      records.push({ ...ownership, ...pin, path, url, sourceOrigin: "human-corpus" });
    }
  }
  const receipt = { schema: "scce.coreference-source-acquisition.v1", retrievedAt: new Date().toISOString(), records };
  await writeFile(join(cacheRoot, "ancora-acquisition.json"), JSON.stringify(receipt, null, 2));
  return receipt;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert.equal(process.argv[2], "--cache", "usage: node tools/coreference/acquire-sources.mjs --cache <external-directory>");
  assert.equal(process.argv.length, 4, "exactly one explicit source cache is required");
  const receipt = await acquireCoreferenceSources(process.argv[3]);
  console.log(JSON.stringify({ schema: receipt.schema, records: receipt.records.length, bytes: receipt.records.reduce((sum, row) => sum + row.bytes, 0), cache: resolve(process.argv[3]) }));
}
