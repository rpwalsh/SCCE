// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWikipediaInputManifest,
  hashWikipediaInputFile,
  wikipediaInputSourcesStillMatch,
  type WikipediaInputManifestOptions
} from "../wikipedia-input-manifest.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(dumpText = "dump-content\n", indexText = "index-content\n") {
  const root = await mkdtemp(path.join(os.tmpdir(), "scce-wikipedia-input-manifest-"));
  roots.push(root);
  const dumpPath = path.join(root, "dump.xml.bz2");
  const indexPath = path.join(root, "index.txt.bz2");
  const cacheDir = path.join(root, "cache");
  await writeFile(dumpPath, dumpText, "utf8");
  await writeFile(indexPath, indexText, "utf8");
  return { root, dumpPath, indexPath, cacheDir };
}

function options(paths: Awaited<ReturnType<typeof fixture>>, overrides: Partial<WikipediaInputManifestOptions> = {}): WikipediaInputManifestOptions {
  return {
    dumpPath: paths.dumpPath,
    indexPath: paths.indexPath,
    cacheDir: paths.cacheDir,
    normalizationIdentity: "wiki-normalize/v3",
    compilerIdentity: "wiki-compiler/v7",
    semanticConfig: { wikiCode: "enwiki", namespaces: [0], redirectPolicy: "follow" },
    ...overrides
  };
}

describe("Wikipedia input manifest", () => {
  it("reuses verified file hashes from the cache and keeps source checks stat-only", async () => {
    const paths = await fixture();
    let hashCalls = 0;
    const hashFile = async (filePath: string, chunkSize: number) => {
      hashCalls++;
      return hashWikipediaInputFile(filePath, { chunkSize });
    };
    const first = await createWikipediaInputManifest(options(paths, { hashFile }));
    const second = await createWikipediaInputManifest(options(paths, { hashFile }));

    expect(hashCalls).toBe(2);
    expect(second.identity).toBe(first.identity);
    expect(Object.isFrozen(second)).toBe(true);
    expect(await wikipediaInputSourcesStillMatch(second)).toBe(true);
  });

  it("rehashes same-size changed content", async () => {
    const paths = await fixture("aaaa\n");
    let hashCalls = 0;
    const hashFile = async (filePath: string, chunkSize: number) => {
      hashCalls++;
      return hashWikipediaInputFile(filePath, { chunkSize });
    };
    const first = await createWikipediaInputManifest(options(paths, { indexPath: undefined, hashFile }));
    await writeFile(paths.dumpPath, "bbbb\n", "utf8");
    const second = await createWikipediaInputManifest(options(paths, { indexPath: undefined, hashFile }));

    expect(hashCalls).toBe(2);
    expect(second.inputs.dump.sha256).not.toBe(first.inputs.dump.sha256);
    expect(await wikipediaInputSourcesStillMatch(first)).toBe(false);
  });

  it("does not reuse a hash after the source file is replaced", async () => {
    const paths = await fixture("old\n");
    let hashCalls = 0;
    const hashFile = async (filePath: string, chunkSize: number) => {
      hashCalls++;
      return hashWikipediaInputFile(filePath, { chunkSize });
    };
    const first = await createWikipediaInputManifest(options(paths, { indexPath: undefined, hashFile }));
    const replacement = path.join(paths.root, "replacement.xml.bz2");
    await writeFile(replacement, "new\n", "utf8");
    await unlink(paths.dumpPath);
    await rename(replacement, paths.dumpPath);
    const second = await createWikipediaInputManifest(options(paths, { indexPath: undefined, hashFile }));

    expect(hashCalls).toBe(2);
    expect(second.inputs.dump.sha256).not.toBe(first.inputs.dump.sha256);
    expect(await wikipediaInputSourcesStillMatch(first)).toBe(false);
  });

  it("binds index content, compiler identity, and semantic config to the manifest identity", async () => {
    const paths = await fixture();
    const base = await createWikipediaInputManifest(options(paths));
    await writeFile(paths.indexPath, "different-index-content\n", "utf8");
    const changedIndex = await createWikipediaInputManifest(options(paths));
    const changedCompiler = await createWikipediaInputManifest(options(paths, { compilerIdentity: "wiki-compiler/v8" }));
    const changedConfig = await createWikipediaInputManifest(options(paths, { semanticConfig: { wikiCode: "dewiki", namespaces: [0], redirectPolicy: "follow" } }));

    expect(changedIndex.identity).not.toBe(base.identity);
    expect(changedCompiler.identity).not.toBe(base.identity);
    expect(changedConfig.identity).not.toBe(base.identity);
  });

  it("does not serialize credential-like semantic config fields", async () => {
    const paths = await fixture();
    const manifest = await createWikipediaInputManifest(options(paths, {
      semanticConfig: {
        wikiCode: "enwiki",
        password: "do-not-write-me",
        nested: { apiKey: "also-do-not-write-me", namespaces: [0] }
      }
    }));
    const serialized = JSON.stringify(manifest);

    expect(serialized).not.toContain("do-not-write-me");
    expect(serialized).not.toContain("also-do-not-write-me");
    expect(manifest.semantics.config).toEqual({ wikiCode: "enwiki", nested: { namespaces: [0] } });
  });
});
