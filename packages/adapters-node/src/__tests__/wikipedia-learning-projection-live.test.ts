// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalStringify } from "@scce/kernel";
import { readScceRuntimeConfig } from "../config.js";
import { createPostgresStorageAdapter } from "../postgres.js";
import { createWikipediaV3Ingestor } from "../wikipedia-v3-ingestor.js";

const url = process.env.SCCE_TEST_DATABASE_URL?.trim();

describe("live Wikipedia learning projection", () => {
  (url ? it : it.skip)("commits a gallery page and cold-replays its projected witnesses while preserving evidence", async () => {
    const schema = `wp_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const root = await mkdtemp(path.join(tmpdir(), "scce-wiki-projection-"));
    const config = await readScceRuntimeConfig("scce.config.json");
    const informationAccess = config.security?.informationAccess;
    if (!informationAccess) throw new Error("test configuration requires information access");
    config.database = { url: url!, schema };
    config.runtime.workspaceRoot = root;
    config.runtime.allowedRoots = [root];
    delete config.runtime.corpusSegmentation;
    const dumpPath = path.join(root, "enwiki-latest-pages-articles.xml.bz2");
    config.runtime.corpora = { ...config.runtime.corpora, wikipedia: {
      ...config.runtime.corpora?.wikipedia, enabled: true, dumpPath, indexPath: undefined,
      maxPagesPerRun: 1, maxBlocksPerRun: 0, python: "python3"
    } };
    const prose = "Workers visit flowers and carry pollen to their colony. ".repeat(8);
    const wikitext = `${prose}\n<gallery>\nBee 🐝.jpg | A worker visiting a flower.\n</gallery>\n${prose}`;
    const escaped = wikitext.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const xml = `<mediawiki><page><title>Archive projection fixture</title><ns>0</ns><id>1</id><revision><id>2</id><text xml:space="preserve">${escaped}</text></revision></page></mediawiki>`;
    await writeFile(dumpPath, execFileSync("bzip2", ["-c"], { input: xml }));
    let storage = createPostgresStorageAdapter({ ...config.database, informationAccess });
    try {
      await storage.migrate();
      const result = await createWikipediaV3Ingestor({ storage, config }).ingest({ dumpPath, fresh: true, maxPages: 1 });
      expect(result.pages).toBe(1);
      expect(result.ngramModels).toBeGreaterThan(0);
      expect(result.languagePatterns).toBeGreaterThan(0);
      const pages = await storage.query<{ source_version_id: string }>(`SELECT DISTINCT source_version_id FROM ${storage.table("evidence_spans")}`);
      const parentId = pages[0]!.source_version_id as never;
      const pageProfiles = await storage.model.listLanguageProfiles({ sourceVersionIds: [parentId], referencedByLanguageMemory: true, limit: 32 });
      expect(pageProfiles).toHaveLength(1);
      expect(pageProfiles[0]!.sourceVersionId).not.toBe(parentId);
      expect(pageProfiles[0]!.pooledSourceBinding?.parents).toContain(parentId);
      const canonical = await storage.query<{ text_content: string }>(`SELECT text_content FROM ${storage.table("evidence_spans")} ORDER BY char_start`);
      expect(canonical.map(row => row.text_content).join("")).toContain("Bee 🐝.jpg");
      const headers = await storage.query<{ id: string; reference: { textView?: string } }>(
        `SELECT id,pattern_json->'_scceSegmentationWitnessArchive' AS reference FROM ${storage.table("language_patterns")}
         WHERE pattern_schema='scce.source_segmentation_witness.v2' ORDER BY id`
      );
      expect(headers.some(row => row.reference.textView === "learning")).toBe(true);
      const read = () => storage.languageMemory.listLanguagePatterns({ patternIds: headers.map(row => row.id),
        limit: headers.length, maxTotalJsonBytes: 64 * 1024 * 1024, requireComplete: true });
      const warm = await read();
      expect(warm.some(row => canonicalStringify(row.patternJson).includes("A worker visiting a flower."))).toBe(true);
      expect(warm.every(row => !canonicalStringify(row.patternJson).includes("Bee 🐝.jpg"))).toBe(true);
      await storage.close();
      storage = createPostgresStorageAdapter({ ...config.database, informationAccess });
      expect(await storage.model.listLanguageProfiles({ sourceVersionIds: [parentId], referencedByLanguageMemory: true, limit: 32 })).toEqual(pageProfiles);
      expect(canonicalStringify(await read())).toBe(canonicalStringify(warm));
      expect(await storage.query(`SELECT text_content FROM ${storage.table("evidence_spans")} ORDER BY char_start`)).toEqual(canonical);
      await storage.query(`UPDATE ${storage.table("evidence_spans")} SET status='quarantined' WHERE source_version_id=$1`, [parentId]);
      expect(await storage.model.listLanguageProfiles({ sourceVersionIds: [parentId], referencedByLanguageMemory: true, limit: 32 })).toEqual([]);
      await storage.query(`UPDATE ${storage.table("evidence_spans")} SET status='promoted' WHERE source_version_id=$1`, [parentId]);
      // A derivative's readable label does not authorize fetching a newly restricted original to replay it.
      await storage.query(`UPDATE ${storage.table("source_versions")} SET information_label=jsonb_set(information_label,
        '{compartments}',information_label->'compartments' || '["fixture.original.restricted"]'::jsonb)
        WHERE metadata_json#>>'{_scceSourceVersion,role}'='original'`);
      await storage.close();
      storage = createPostgresStorageAdapter({ ...config.database, informationAccess });
      await expect(read()).rejects.toThrow(/requires its original source/u);
    } finally {
      try { await storage.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await storage.close(); await rm(root, { recursive: true, force: true }); }
    }
  }, 120_000);
});
