// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { chmod, mkdtemp, rename, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
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
    expect(await wikipediaInputSourcesStillMatch(second, { hashFile })).toBe(true);
    expect(hashCalls).toBe(2);
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
    // Some filesystems expose coarse timestamp resolution: an immediate same-size
    // rewrite can otherwise retain the exact stat signature used by the cache key.
    const changedMtime = new Date(Date.now() + 2_000);
    await utimes(paths.dumpPath, changedMtime, changedMtime);
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

  it("separates executable attestation from physical identity and semantic resume eligibility", async () => {
    const paths = await fixture();
    const base = await createWikipediaInputManifest(options(paths));
    let hashCalls = 0;
    const changedCompiler = await createWikipediaInputManifest(options(paths, { compilerIdentity: "wiki-compiler/v8", hashFile: async (...args) => { hashCalls++; return hashWikipediaInputFile(args[0], { chunkSize: args[1] }); } }));
    expect(hashCalls).toBe(0);
    expect(changedCompiler.identity).toBe(base.identity);
    expect(changedCompiler.sourceSetDigest).toBe(base.sourceSetDigest);
    expect(changedCompiler.semantics.compilerIdentity).not.toBe(base.semantics.compilerIdentity);
    const changedNormalization = await createWikipediaInputManifest(options(paths, { normalizationIdentity: "wiki-normalize/v4" }));
    expect(changedNormalization.identity).not.toBe(base.identity);
    expect(changedNormalization.sourceSetDigest).toBe(base.sourceSetDigest);
    const changedConfig = await createWikipediaInputManifest(options(paths, { semanticConfig: { wikiCode: "dewiki", namespaces: [0], redirectPolicy: "follow" } }));
    expect(changedConfig.identity).not.toBe(base.identity);
    expect(changedConfig.sourceSetDigest).toBe(base.sourceSetDigest);
    await writeFile(paths.indexPath, "different-index-content\n", "utf8");
    const changedIndex = await createWikipediaInputManifest(options(paths));

    expect(changedIndex.identity).not.toBe(base.identity);
    expect(changedIndex.sourceSetDigest).not.toBe(base.sourceSetDigest);
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

async function changeMetadataOnly(filePath: string, mode: 0o444 | 0o666 = 0o444) {
  const before=await stat(filePath,{bigint:true});
  await expect.poll(async()=>{
    await chmod(filePath,mode===0o444?0o666:0o444);
    await chmod(filePath,mode);
    return (await stat(filePath,{bigint:true})).ctimeNs;
  }).not.toBe(before.ctimeNs);
  const after=await stat(filePath,{bigint:true});
  expect(after.ctimeNs).not.toBe(before.ctimeNs);
  expect([after.size,after.mtimeNs,after.dev,after.ino]).toEqual([before.size,before.mtimeNs,before.dev,before.ino]);
}
it("accepts real ctime-only metadata changes only after hashing pinned bytes, then caches refreshed stats without changing provenance",async()=>{
  const paths=await fixture(),manifest=await createWikipediaInputManifest(options(paths)),original=JSON.stringify(manifest);
  await changeMetadataOnly(paths.dumpPath);await changeMetadataOnly(paths.indexPath);
  let calls=0;
  const hashFile=async(filePath:string,chunkSize:number)=>{calls++;return hashWikipediaInputFile(filePath,{chunkSize});};
  expect(await wikipediaInputSourcesStillMatch(manifest,{chunkSize:2,hashFile})).toBe(true);
  expect(calls).toBe(2);expect(JSON.stringify(manifest)).toBe(original);
  expect(await wikipediaInputSourcesStillMatch(manifest,{hashFile})).toBe(true);expect(calls).toBe(2);
  await chmod(paths.dumpPath,0o666);await chmod(paths.indexPath,0o666);
});
it("rejects same-size changed bytes with restored mtime rather than treating ctime as harmless",async()=>{
  const paths=await fixture("aaaa\n"),time=new Date(1700000000000);await utimes(paths.dumpPath,time,time);
  const manifest=await createWikipediaInputManifest(options(paths,{indexPath:undefined}));
  await writeFile(paths.dumpPath,"bbbb\n");await utimes(paths.dumpPath,time,time);
  const actual=await stat(paths.dumpPath,{bigint:true});expect(actual.mtimeNs.toString()).toBe(manifest.inputs.dump.stat.mtimeNs);
  let calls=0;const hashFile=async(filePath:string,chunkSize:number)=>{calls++;return hashWikipediaInputFile(filePath,{chunkSize});};
  expect(await wikipediaInputSourcesStillMatch(manifest,{hashFile})).toBe(false);expect(calls).toBe(1);
  expect(await wikipediaInputSourcesStillMatch(manifest,{hashFile})).toBe(false);expect(calls).toBe(2);
});
it("refuses a metadata race during rehash and never installs its unverified refreshed stat",async()=>{
  const paths=await fixture(),manifest=await createWikipediaInputManifest(options(paths,{indexPath:undefined}));
  await changeMetadataOnly(paths.dumpPath);let calls=0;
  const raced=await wikipediaInputSourcesStillMatch(manifest,{hashFile:async(filePath,chunkSize)=>{
    calls++;const result=await hashWikipediaInputFile(filePath,{chunkSize});await changeMetadataOnly(filePath,0o666);return result;
  }});
  expect(raced).toBe(false);expect(calls).toBe(1);
  expect(await wikipediaInputSourcesStillMatch(manifest,{hashFile:async(filePath,chunkSize)=>{calls++;return hashWikipediaInputFile(filePath,{chunkSize});}})).toBe(true);
  expect(calls).toBe(2);
});

it("shares one ctime-only full-file verification across concurrent source guards",async()=>{
  const paths=await fixture(),manifest=await createWikipediaInputManifest(options(paths,{indexPath:undefined}));
  await changeMetadataOnly(paths.dumpPath);let calls=0,release!:()=>void,started!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),start=new Promise<void>(resolve=>{started=resolve;});
  const hashFile=async(filePath:string,chunkSize:number)=>{calls++;started();await gate;return hashWikipediaInputFile(filePath,{chunkSize});};
  const first=wikipediaInputSourcesStillMatch(manifest,{hashFile});await start;
  const second=wikipediaInputSourcesStillMatch(manifest,{hashFile});release();
  expect(await Promise.all([first,second])).toEqual([true,true]);expect(calls).toBe(1);
  await chmod(paths.dumpPath,0o666);
});
it("refuses changed physical metadata without spending a content hash",async()=>{
  const paths=await fixture(),manifest=await createWikipediaInputManifest(options(paths,{indexPath:undefined}));let calls=0;
  const hashFile=async(filePath:string,chunkSize:number)=>{calls++;return hashWikipediaInputFile(filePath,{chunkSize});};
  await writeFile(paths.dumpPath,"longer replacement bytes");
  expect(await wikipediaInputSourcesStillMatch(manifest,{hashFile})).toBe(false);expect(calls).toBe(0);
});
