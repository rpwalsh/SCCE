// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IngestionCheckpoint } from "@scce/kernel";
import { createWikipediaV3Ingestor } from "../wikipedia-v3-ingestor.js";
import { resolveWikipediaCorpusTarget, streamWikipediaMultistream } from "../wikipedia.js";
import * as corpusTrainer from "../language-corpus-trainer.js";

const blocks = [
  "QlpoOTFBWSZTWZzIxvAAACMfgEAB4AUBAAQAP+ffQDAA+AKAAaAAAoABoAAAqpo1JibSnpMam1PKIPZqfDYbHBJBY8l6UvrTWqKr/taUyzXmLd0oTh2pHJy+iTgg4LGgzLFSCTwPBjCLi5YqYGaVTI3Ugbknl7dGBiYnJienzk7GTI7LELnSno0Nz2KkDbaqnR0eCcMzQzJnuZ0NUNTWpJ3/lTLKRWuDE3LjEf4u5IpwoSE5kY3g",
  "QlpoOTFBWSZTWZCMf2MAACMbgEAB8AUMAD/n30AwAPgCgAAAABQAAAAAKqaEap4NUybFGnlEHBc/DwPB7KkFD0bSlreW10TbZTlLKbX9imiqFcMZR0dPkqeyD2UNDKCCKEEFTyPJaEb7DYqTMTNVMyOUoHJU3cuzAsWOixu6MCyxgoQ0O0vRmT4NxQgXvNLfs7PBhjkamZWuhmLoXIKH8gxxzE54MTg0Fh/i7kinChISEY/sYA=="
].map(value => Buffer.from(value, "base64"));
// Compressed XML fixtures are two independent streams, with ordinary source
// pages long enough to pass the production minimum-text admission.

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "scce-wiki-recovery-"));
  const dumpPath = path.join(root, "enwiki-latest-pages-articles-multistream.xml.bz2");
  const indexPath = path.join(root, "index.txt");
  await writeFile(dumpPath, Buffer.concat(blocks));
  await writeFile(indexPath, `0:1:First\n${blocks[0]!.length}:2:Second\n`);
  const config = { runtime: { tempRoot: root, corpora: { wikipedia: {
    enabled: true, dumpPath, indexPath, maxPagesPerRun: 100, maxBlocksPerRun: 0,
    ngramShardChars: 100000, memorySafetyBoundMb: 100000
  } } } } as any;
  return { root, dumpPath, indexPath, config, async close() {
    if (path.dirname(root) !== path.resolve(tmpdir())) throw new Error("unexpected fixture path");
    await rm(root, { recursive: true, force: true });
  } };
}

async function sameBlockFixture(repeats = 8, leadingBlock = false) {
  const root = await mkdtemp(path.join(tmpdir(), "scce-wiki-recovery-same-block-"));
  const dumpPath = path.join(root, "enwiki-same-block.xml.bz2");
  const indexPath = path.join(root, "index.txt");
  const page = (id: number, title: string) => `<page><title>${title}</title><ns>0</ns><id>${id}</id><revision><id>${id}9</id><text xml:space="preserve">${"This is source evidence for same-block cursor recovery. ".repeat(repeats)}</text></revision></page>`;
  const xml = Buffer.from(`<mediawiki>${page(1, "First")}\n${page(2, "Second")}</mediawiki>`);
  const compressed = execFileSync("python", ["-c", "import bz2,sys; sys.stdout.buffer.write(bz2.compress(sys.stdin.buffer.read()))"], { input: xml, windowsHide: true });
  const offset = leadingBlock ? blocks[0]!.length : 0;
  await writeFile(dumpPath, leadingBlock ? Buffer.concat([blocks[0]!, compressed]) : compressed);
  await writeFile(indexPath, `${leadingBlock ? "0:1:First\n" : ""}${offset}:1:First\n${offset}:2:Second\n`);
  const config = { runtime: { tempRoot: root, corpora: { wikipedia: {
    enabled: true, dumpPath, indexPath, maxPagesPerRun: 100, maxBlocksPerRun: 0,
    ngramShardChars: 100000, memorySafetyBoundMb: 100000
  } } } } as any;
  return { root, dumpPath, config, async close() {
    if (path.dirname(root) !== path.resolve(tmpdir())) throw new Error("unexpected fixture path");
    await rm(root, { recursive: true, force: true });
  } };
}

function mockPipeline(config: any) {
  let checkpoints = new Map<string, IngestionCheckpoint>();
  let transactionDepth = 0;
  const storage = {
    events: { append: vi.fn(async () => {}) },
    ingestion: {
      put: vi.fn(async (row: IngestionCheckpoint) => { checkpoints.set(row.id, row); }),
      get: vi.fn(async (id: string) => checkpoints.get(id) ?? null),
      list: vi.fn(async (query: any) => [...checkpoints.values()].filter(row => row.rootUri === query.rootUri
        && (!query.status || row.status === query.status) && (!query.phase || row.phase === query.phase)
        && (!query.itemUriPrefix || row.itemUri.startsWith(query.itemUriPrefix)))
        .sort((a, b) => b.offsetBytes - a.offsetBytes).slice(0, query.limit))
    },
    transaction: async (fn: () => Promise<unknown>) => {
      const before = new Map(checkpoints);
      transactionDepth++;
      try { return await fn(); } catch (error) { checkpoints = before; throw error; }
      finally { transactionDepth--; }
    }
  } as any;
  const ingestor = createWikipediaV3Ingestor({ storage, config });
  const counts = { sources: 1, evidence: 0, graphNodes: 0, graphEdges: 0, graphHyperedges: 0, languageProfiles: 0,
    ngramObservations: 0, ngramModels: 1, languageUnits: 0, languagePatterns: 0,
    semanticFrames: 0, relationCandidates: 0, promotedRelations: 0, warnings: [] };
  const page = vi.spyOn(ingestor as any, "ingestPage").mockImplementation(async (...args: any[]) => ({ ...counts,
      languageSample: { uri: args[0].uri, title: "source", text: args[0].text, evidence: [], sourceVersionId: "fixture", createdAt: 0,
        languageAliases: [], semanticCandidates: [] }
  }));
  const train = vi.spyOn(ingestor as any, "ingestLanguageShard").mockImplementation(async (...args: any[]) =>
    storage.transaction(async () => {
      trainedShards.push({ shardUri: args[1], samples: args[0].map((sample: any) => ({ title: sample.title, text: sample.text, sourceVersionId: sample.sourceVersionId })) });
      await args[4](counts); return counts;
    }));
  const activate = vi.spyOn(ingestor as any, "registerActiveWikipediaImport").mockResolvedValue(undefined);
  const trainedShards: Array<{ shardUri: string; samples: Array<{ title: string; text: string; sourceVersionId: string }> }> = [];
  return { storage, ingestor, page, train, activate, counts, trainedShards, rows: () => [...checkpoints.values()], depth: () => transactionDepth };
}

describe("Wikipedia recovery boundaries", () => {
  it.each(["aggregate", "rows"])("propagates a failed relation-prior %s read instead of treating it as no evidence", async failedRead => {
    const unavailable = async () => { throw new Error("prior storage unavailable"); };
    const ingestor = createWikipediaV3Ingestor({ config: { runtime: {} } as any, storage: {
      relationObservations: { list: unavailable, ...(failedRead === "aggregate" ? { sourceFamilyCountsForSeeds: unavailable } : {}) }
    } as any });
    const candidate = { id: "candidate", relationSeedId: "relation", sourceId: "source", channel: "fixture", participants: [],
      qualifiers: {}, provenance: { sourceIndependence: { dependencyGroupIds: ["fixture-family"] } } };
    await expect((ingestor as any).priorRelationObservations([candidate])).rejects.toThrow("prior storage unavailable");
  });

  it("prepares language outside the transaction and commits it before progress inside one transaction", async () => {
    const f = await fixture();
    try {
      const p = mockPipeline(f.config);
      p.train.mockRestore();
      const stages: string[] = [];
      vi.spyOn(corpusTrainer, "prepareLanguageCorpusTraining").mockImplementation(async () => {
        expect(p.depth()).toBe(0); stages.push("prepare"); return {} as any;
      });
      vi.spyOn(corpusTrainer, "commitLanguageCorpusTraining").mockImplementation(async () => {
        expect(p.depth()).toBe(1); stages.push("commit"); return p.counts as any;
      });
      const put = p.storage.ingestion.put;
      p.storage.ingestion.put = async (row: IngestionCheckpoint) => {
        if (row.phase === "stored" && row.itemUri.includes("/block/")) {
          expect(p.depth()).toBe(1); expect(stages.at(-1)).toBe("commit");
        }
        await put(row);
      };
      await p.ingestor.ingest({ dumpPath: f.dumpPath });
      expect(stages).toEqual(["prepare", "commit"]);
      expect(p.rows().filter(row => row.phase === "stored" && row.itemUri.includes("/block/"))).toHaveLength(2);
    } finally { vi.restoreAllMocks(); await f.close(); }
  });

  it("resumes after a committed first block at byte zero when the run cap changes", async () => {
    const f = await fixture();
    try {
      const p = mockPipeline(f.config);
      const first = await p.ingestor.ingest({ dumpPath: f.dumpPath, maxBlocks: 1 });
      expect(first.pages).toBe(1);
      // The first block remains uncheckpointed while its under-budget language batch is open;
      // its samples survive in the journal, preserving batch membership without reimporting the block.
      expect(p.rows().filter(row => row.phase === "stored" && row.itemUri.endsWith("/block/0"))).toHaveLength(0);
      const next = await p.ingestor.ingest({ dumpPath: f.dumpPath, maxBlocks: 2 });
      expect(next.pages).toBe(1);
      expect(next.resumedFromOffset).toBe(0);
      expect(next.inputManifestId).toBe(first.inputManifestId);
      expect(p.rows().filter(row => row.phase === "stored" && row.itemUri.includes("/block/"))).toHaveLength(1);
    } finally { vi.restoreAllMocks(); await f.close(); }
  });

  it("keeps learned shard inputs equivalent across a bounded run and resume", async () => {
    const fullFixture = await fixture();
    const boundedFixture = await fixture();
    try {
      const full = mockPipeline(fullFixture.config);
      await full.ingestor.ingest({ dumpPath: fullFixture.dumpPath });

      const bounded = mockPipeline(boundedFixture.config);
      await bounded.ingestor.ingest({ dumpPath: boundedFixture.dumpPath, maxBlocks: 1 });
      await bounded.ingestor.ingest({ dumpPath: boundedFixture.dumpPath, maxBlocks: 2 });

      expect(bounded.trainedShards).toEqual(full.trainedShards);
    } finally {
      vi.restoreAllMocks();
      await fullFixture.close();
      await boundedFixture.close();
    }
  });

  it("advances a repeated page-bounded resume through a partially processed block", async () => {
    const f = await sameBlockFixture();
    try {
      const p = mockPipeline(f.config);
      const first = await p.ingestor.ingest({ dumpPath: f.dumpPath, maxPages: 1 });
      const second = await p.ingestor.ingest({ dumpPath: f.dumpPath, maxPages: 1 });
      expect(first.pages).toBe(1);
      expect(second.pages).toBe(1);
      expect(second.resumedFromOffset).toBe(0);
      expect(p.trainedShards).toHaveLength(1);
      expect(p.trainedShards[0]!.samples).toHaveLength(2);
      const completed = await p.ingestor.ingest({ dumpPath: f.dumpPath, maxPages: 1 });
      expect(completed.pages).toBe(0);
      expect(p.trainedShards).toHaveLength(1);
    } finally { vi.restoreAllMocks(); await f.close(); }
  });

  it("uses block-local ordinals when resuming a later partially processed block", async () => {
    const f = await sameBlockFixture(8, true);
    try {
      const p = mockPipeline(f.config);
      const page = p.page.getMockImplementation()!;
      p.page.mockImplementation(async (...args: any[]) => {
        const imported = await page(...args);
        await p.storage.ingestion.put({ ...args[1], phase: "stored", status: "complete" });
        return imported;
      });
      expect((await p.ingestor.ingest({ dumpPath: f.dumpPath, maxPages: 2 })).pages).toBe(2);
      const pageCheckpointBeforeReplay = p.rows().find(row => row.phase === "stored" && !row.itemUri.includes("/block/") && !row.itemUri.endsWith("/language-batch"));
      expect(pageCheckpointBeforeReplay).toBeDefined();
      expect((await p.ingestor.ingest({ dumpPath: f.dumpPath, maxPages: 1 })).pages).toBe(1);
      expect(p.rows().find(row => row.id === pageCheckpointBeforeReplay!.id)?.phase).toBe("stored");
      expect(p.trainedShards.flatMap(shard => shard.samples)).toHaveLength(3);
    } finally { vi.restoreAllMocks(); await f.close(); }
  });

  it("does not skip an overflow page after the preceding batch committed and execution failed", async () => {
    const f = await sameBlockFixture(1200);
    try {
      const p = mockPipeline(f.config);
      const train = p.train.getMockImplementation()!;
      p.train.mockImplementationOnce(async (...args: any[]) => {
        await train(...args);
        // Simulates a lost acknowledgement after the database transaction committed.
        throw new Error("lost commit acknowledgement");
      });
      await expect(p.ingestor.ingest({ dumpPath: f.dumpPath })).rejects.toThrow("lost commit acknowledgement");
      const journal = (p.rows().find(row => row.itemUri.endsWith("/language-batch"))!.metadata as any).languageBatch;
      expect(journal.lastProcessedPageOrdinal).toBe(1);
      expect(journal.pendingSamples).toHaveLength(0);
      expect((await p.ingestor.ingest({ dumpPath: f.dumpPath })).pages).toBe(1);
      expect(p.trainedShards.map(shard => shard.samples.length)).toEqual([1, 1]);
    } finally { vi.restoreAllMocks(); await f.close(); }
  });

  it("retains training omissions across EOF-only resumes and refuses an explicit rewind", async () => {
    const f = await sameBlockFixture();
    try {
      f.config.runtime.corpora.wikipedia.languageTrainingDocumentLimit = 1;
      const p = mockPipeline(f.config);
      await p.ingestor.ingest({ dumpPath: f.dumpPath });
      const statuses: any[] = [];
      const next = await p.ingestor.ingest({ dumpPath: f.dumpPath, onStatus: async status => { statuses.push(status); } });
      expect(next.pages).toBe(0);
      expect(statuses.at(-1).fullTrainingComplete).toBe(false);
      expect(next.warnings).toContain("1 page(s) were not language-trained because languageTrainingDocumentLimit was reached");
      await expect(p.ingestor.ingest({ dumpPath: f.dumpPath, fresh: true })).rejects.toThrow(/refusing fresh/);
    } finally { vi.restoreAllMocks(); await f.close(); }
  });

  it("retains cumulative manifest counts when manifest publication fails before retry", async () => {
    const f = await fixture();
    try {
      const p = mockPipeline(f.config);
      const register = vi.spyOn(p.ingestor as any, "registerActiveWikipediaImport")
        .mockRejectedValueOnce(new Error("injected manifest publication failure"))
        .mockResolvedValue(undefined);
      await expect(p.ingestor.ingest({ dumpPath: f.dumpPath })).rejects.toThrow("injected manifest publication failure");
      await p.ingestor.ingest({ dumpPath: f.dumpPath, resume: true });
      const retried = (register.mock.calls.at(-1)?.[0] as any)?.result;
      expect(retried.pages).toBe(2);
      expect(retried.sources).toBe(2);
      expect(retried.ngramModels).toBe(3);
    } finally { vi.restoreAllMocks(); await f.close(); }
  });

  it("retains cumulative counts after an owner stop and validates the resumed manifest", async () => {
    const f = await fixture();
    const stopFile = path.join(f.root, "owner.stop");
    try {
      const p = mockPipeline(f.config);
      const register = vi.spyOn(p.ingestor as any, "registerActiveWikipediaImport").mockResolvedValue(undefined);
      await writeFile(stopFile, "stop");
      const stopped = await p.ingestor.ingest({ dumpPath: f.dumpPath, stopFile });
      expect(stopped.stoppedByOwner).toBe(true);
      await rm(stopFile, { force: true });
      await p.ingestor.ingest({ dumpPath: f.dumpPath, resume: true });
      const resumed = (register.mock.calls.at(-1)?.[0] as any)?.result;
      expect(resumed.pages).toBe(2);
      expect(resumed.sources).toBe(2);
      expect(resumed.stoppedByOwner).toBe(false);
    } finally { vi.restoreAllMocks(); await f.close(); }
  });

  it("refuses an explicit rewind after a completed idle journal", async () => {
    const f = await fixture();
    try {
      const p = mockPipeline(f.config);
      await p.ingestor.ingest({ dumpPath: f.dumpPath });
      await expect(p.ingestor.ingest({ dumpPath: f.dumpPath, fresh: true })).rejects.toThrow(/refusing fresh/);
    } finally { vi.restoreAllMocks(); await f.close(); }
  });

  it("uses the completed idle journal cursor when an older block checkpoint lags", async () => {
    const f = await fixture();
    try {
      const p = mockPipeline(f.config);
      await p.ingestor.ingest({ dumpPath: f.dumpPath });
      for (const row of p.rows().filter(row => row.itemUri.includes("/block/") && row.phase === "stored")) {
        row.offsetBytes = 0;
        row.metadata = { ...(row.metadata as any), blockOffset: 0 };
      }
      const resumed = await p.ingestor.ingest({ dumpPath: f.dumpPath, resume: true });
      expect(resumed.pages).toBe(0);
    } finally { vi.restoreAllMocks(); await f.close(); }
  });

  it.each(["dump", "index", "semantic-config", "legacy"] as const)("refuses resume after a %s identity change before any writes", async change => {
    const f = await fixture();
    try {
      const p = mockPipeline(f.config);
      await p.ingestor.ingest({ dumpPath: f.dumpPath, maxBlocks: 1 });
      if (change === "dump") await writeFile(f.dumpPath, Buffer.concat([...blocks].reverse()));
      if (change === "index") await writeFile(f.indexPath, `0:999:Changed\n${blocks[0]!.length}:2:Second\n`);
      if (change === "semantic-config") f.config.runtime.corpora.wikipedia.ngramMaxOrder = 3;
      if (change === "legacy") for (const row of p.rows()) row.metadata = {};
      p.storage.ingestion.put.mockClear();
      p.storage.events.append.mockClear();
      await expect(p.ingestor.ingest({ dumpPath: f.dumpPath })).rejects.toThrow(/identity differs or is missing/);
      expect(p.storage.ingestion.put).not.toHaveBeenCalled();
      expect(p.storage.events.append).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); await f.close(); }
  });

  it("refuses checkpoint advancement and activation if an input changes during training", async () => {
    const f = await fixture();
    try {
      const p = mockPipeline(f.config);
      p.train.mockImplementation(async (...args: any[]) => p.storage.transaction(async () => {
        await writeFile(f.indexPath, "changed while training"); await args[4](p.counts); return p.counts;
      }));
      await expect(p.ingestor.ingest({ dumpPath: f.dumpPath })).rejects.toThrow(/input changed during ingestion/);
      expect(p.rows().some(row => row.phase === "stored")).toBe(false);
      expect(p.activate).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); await f.close(); }
  });

  it("distinguishes actual EOF from page and block caps using real compressed input", async () => {
    const f = await fixture();
    try {
      const corpus = resolveWikipediaCorpusTarget(f.config, f.dumpPath)!;
      for (const [bounds, reachedEnd] of [[{}, true], [{ maxPagesPerRun: 1 }, false], [{ maxBlocksPerRun: 1 }, false]] as const) {
        const seen = [];
        for await (const item of streamWikipediaMultistream({ ...corpus, ...bounds })) seen.push(item);
        const last = seen.at(-1)!.checkpoint;
        expect((last.metadata as any).reachedEnd).toBe(reachedEnd);
      }
    } finally { await f.close(); }
  });

  it("fails on a corrupt compressed index instead of claiming EOF", async () => {
    const f = await fixture();
    try {
      const badIndex = path.join(f.root, "bad-index.txt.bz2");
      await writeFile(badIndex, "corrupt");
      const corpus = resolveWikipediaCorpusTarget(f.config, f.dumpPath)!;
      await expect((async () => {
        for await (const item of streamWikipediaMultistream({ ...corpus, indexPath: badIndex })) {
          expect((item.checkpoint.metadata as any).reachedEnd).not.toBe(true);
        }
      })()).rejects.toThrow(/index decode failed/);
    } finally { await f.close(); }
  });

  it("does not advance durable resume when buffered language training fails", async () => {
    const f = await fixture();
    try {
      let checkpoints = new Map<string, IngestionCheckpoint>();
      const list = vi.fn(async (query: any) => [...checkpoints.values()].filter(row =>
        row.rootUri === query.rootUri && (!query.status || row.status === query.status) && (!query.phase || row.phase === query.phase) && (!query.itemUriPrefix || row.itemUri.startsWith(query.itemUriPrefix))
      ).sort((a, b) => b.offsetBytes - a.offsetBytes).slice(0, query.limit));
      const storage = {
        events: { append: vi.fn(async () => {}) },
        ingestion: {
          put: async (row: IngestionCheckpoint) => { checkpoints.set(row.id, row); },
          get: async (id: string) => checkpoints.get(id) ?? null,
          list
        },
        transaction: async (fn: () => Promise<unknown>) => {
          const before = new Map(checkpoints);
          try { return await fn(); } catch (error) { checkpoints = before; throw error; }
        }
      } as any;
      const ingestor = createWikipediaV3Ingestor({ storage, config: f.config });
      vi.spyOn(ingestor as any, "ingestPage").mockImplementation(async (...args: any[]) => ({
        sources: 1, evidence: 0, graphNodes: 0, graphEdges: 0, graphHyperedges: 0, languageProfiles: 0,
        ngramObservations: 0, ngramModels: 0, languageUnits: 0, languagePatterns: 0,
        semanticFrames: 0, relationCandidates: 0, promotedRelations: 0, warnings: [],
        languageSample: { uri: args[0].uri, title: "source", text: args[0].text, evidence: [], sourceVersionId: "fixture", createdAt: 0 }
      }));
      const trainedCounts = { languageProfiles: 1, ngramObservations: 0, ngramModels: 1,
        languageUnits: 0, languagePatterns: 0, semanticFrames: 0, relationCandidates: 0,
        promotedRelations: 0, graphHyperedges: 0, warnings: [] };
      const train = vi.spyOn(ingestor as any, "ingestLanguageShard").mockImplementation(async (...args: any[]) => {
        expect([...checkpoints.values()].some(row => row.itemUri.includes("/block/") && row.phase === "stored")).toBe(false);
        // The progress callback runs inside the same transaction as learned writes. Force a failure after
        // it writes both the block checkpoint and language-batch journal so the test proves both roll back.
        await storage.transaction(async () => {
          await args[4](trainedCounts);
          throw new Error("injected training persistence failure");
        });
      });
      await expect(ingestor.ingest({ dumpPath: f.dumpPath })).rejects.toThrow("injected training persistence failure");
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ phase: "stored", itemUriPrefix: expect.stringContaining("/block/"), orderBy: "offsetBytes", limit: 1 }));
      expect([...checkpoints.values()].some(row => row.phase === "stored")).toBe(false);
      expect([...checkpoints.values()].some(row => row.itemUri.endsWith("/language-batch"))).toBe(false);
      train.mockImplementation(async (...args: any[]) => storage.transaction(async () => {
        await args[4](trainedCounts);
        return trainedCounts;
      }));
      vi.spyOn(ingestor as any, "registerActiveWikipediaImport").mockResolvedValue(undefined);
      const recovered = await ingestor.ingest({ dumpPath: f.dumpPath });
      expect(recovered.pages).toBe(2);
      expect(recovered.resumedFromOffset).toBe(0);
      expect([...checkpoints.values()].filter(row => row.itemUri.includes("/block/") && row.phase === "stored")).toHaveLength(2);
    } finally { vi.restoreAllMocks(); await f.close(); }
  });
});
