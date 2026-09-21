// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createEvidenceExtractor,
  createHasher,
  createIdFactory,
  createClock,
  createLanguageAcquisitionEngine,
  propositionAssertionalStance,
  resolveSourceArtifactRole,
  resolveSpanAssertionalStance,
  type EvidenceSpan,
  type JsonValue,
  type ScceStorage
} from "@scce/kernel";
import { NodeFileIngestAdapter } from "../files.js";
import { trainOssCorpus } from "../oss-corpus.js";
import { blobContentHash } from "../postgres.js";
import type { ScceRuntimeConfig } from "../config.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/**
 * The declared glob names no conventional test token, so an implementation that recognises tests by
 * name rather than by the project's own declaration cannot satisfy this file.
 */
const DECLARED_TEST_GLOB = "lib/**/*.probe.ts";
const EXHIBITED_SENTENCE = "Apollo 11 landed on the Moon on July 20, 1969.";

describe("repository artifact role is declared, not guessed", () => {
  it("resolves the role the project's own test-runner manifest declares, from a glob carrying no test-name convention", async () => {
    const root = await fixtureRoot("declared");
    await writeFile(path.join(root, "vitest.config.ts"), [
      `import { defineConfig } from "vitest/config";`,
      `export default defineConfig({ test: { include: ["${DECLARED_TEST_GLOB}"] } });`
    ].join("\n"), "utf8");
    await mkdir(path.join(root, "lib"), { recursive: true });
    await writeFile(path.join(root, "lib", "widget.ts"), productionSource(), "utf8");
    await writeFile(path.join(root, "lib", "widget.probe.ts"), exhibitingSource(), "utf8");

    // The property this file exists for: neither the declared glob nor the declared path carries a
    // conventional test token, so path name-matching cannot produce the expected answer.
    expect(DECLARED_TEST_GLOB.toLocaleLowerCase()).not.toMatch(/test|spec/u);
    expect("lib/widget.probe.ts").not.toMatch(/test|spec/u);

    const walked = await walk(root);
    const declared = walked.get("lib/widget.probe.ts");
    const production = walked.get("lib/widget.ts");
    if (!declared || !production) throw new Error(`fixture files were not both walked: ${[...walked.keys()].join(",")}`);

    expect(resolveSourceArtifactRole(declared)).toMatchObject({ role: "test_source", declaredBy: "project_manifest" });
    expect(resolveSourceArtifactRole(production).role).not.toBe("test_source");
  });

  it("reports an undeclared repository as unknown rather than as production source", async () => {
    const root = await fixtureRoot("undeclared");
    await writeFile(path.join(root, "widget.ts"), productionSource(), "utf8");

    const walked = await walk(root);
    const resolution = resolveSourceArtifactRole(walked.get("widget.ts")!);
    expect(resolution.role).toBe("unknown");
    expect(resolution.declaredBy).toBe("none");
  });

  it("never lets a path convention alone stand as a declaration", async () => {
    const root = await fixtureRoot("convention-only");
    await mkdir(path.join(root, "__tests__"), { recursive: true });
    await writeFile(path.join(root, "__tests__", "widget.test.ts"), exhibitingSource(), "utf8");

    const walked = await walk(root);
    const resolution = resolveSourceArtifactRole(walked.get("__tests__/widget.test.ts")!);
    // The path observation may be carried as evidence; it may never be the declaration.
    expect(resolution.declaredBy).not.toBe("project_manifest");
    expect(resolution.role).toBe("unknown");
  });
});

describe("assertional stance is a span-level axis and refuses no file", () => {
  it("marks a world-fact sentence held in a code literal as exhibited while the file's code stays asserted", async () => {
    const root = await fixtureRoot("stance");
    await writeFile(path.join(root, "vitest.config.ts"), [
      `import { defineConfig } from "vitest/config";`,
      `export default defineConfig({ test: { include: ["${DECLARED_TEST_GLOB}"] } });`
    ].join("\n"), "utf8");
    await mkdir(path.join(root, "lib"), { recursive: true });
    await writeFile(path.join(root, "lib", "widget.probe.ts"), exhibitingSource(), "utf8");

    const walked = await walk(root);
    const metadata = walked.get("lib/widget.probe.ts")!;
    const spans = spansFor("lib/widget.probe.ts", exhibitingSource(), metadata);
    const carrying = spans.find(span => span.text.includes(EXHIBITED_SENTENCE));
    if (!carrying) throw new Error("no span carried the exhibited sentence");

    expect(propositionAssertionalStance(carrying, EXHIBITED_SENTENCE)).toBe("exhibited");
    // Same span, a proposition drawn from the file's own code rather than from a literal.
    expect(propositionAssertionalStance(carrying, "export function widgetName(")).not.toBe("exhibited");
    // A whole file is never refused: the span's own stance is not a file-level verdict.
    expect(resolveSpanAssertionalStance(carrying.provenance).stance).not.toBe("exhibited");
  });

  it("gives each span only the exhibited intervals that fall inside it", async () => {
    const root = await fixtureRoot("narrowing");
    // Two paragraphs, each holding its own literal and each over the production chunk size, so the file's
    // intervals outnumber any one span's under the same chunking the ingestor uses.
    const filler = Array.from({ length: 420 }, (_value, index) => `const pad${index} = ${index};`).join("\n");
    const text = [
      `const first = "${EXHIBITED_SENTENCE}";`,
      filler,
      ``,
      `const second = "A different exhibited sentence entirely.";`,
      filler,
      ``
    ].join("\n");
    await writeFile(path.join(root, "widget.ts"), text, "utf8");

    const walked = await walk(root);
    const fileRanges = exhibitedRanges((walked.get("widget.ts") as { metadata: JsonValue }).metadata);
    const spans = spansFor("widget.ts", text, walked.get("widget.ts")!);
    expect(fileRanges.length).toBeGreaterThan(1);
    expect(spans.length).toBeGreaterThan(1);
    for (const span of spans) {
      const carried = exhibitedRanges((span.provenance as { metadata: JsonValue }).metadata);
      expect(carried.length).toBeLessThan(fileRanges.length);
      const range = (span.provenance as { charRange: [number, number] }).charRange;
      for (const [start, end] of carried) expect(start < range[1] && end > range[0]).toBe(true);
    }
  });

  it("leaves a documentary sentence unexhibited in a source the project declares nothing about", async () => {
    const root = await fixtureRoot("documentary");
    await writeFile(path.join(root, "NOTES.md"), `${EXHIBITED_SENTENCE}\n\nA second paragraph.\n`, "utf8");

    const walked = await walk(root);
    const metadata = walked.get("NOTES.md")!;
    const spans = spansFor("NOTES.md", `${EXHIBITED_SENTENCE}\n\nA second paragraph.\n`, metadata);
    const carrying = spans.find(span => span.text.includes(EXHIBITED_SENTENCE))!;
    expect(propositionAssertionalStance(carrying, EXHIBITED_SENTENCE)).not.toBe("exhibited");
  });
});

describe("the OSS corpus lane carries both axes onto the spans it promotes", () => {
  it("declares the role from each repository's own manifest and reports the stance unmeasured where a projection moved the offsets", async () => {
    const corpus = await fixtureRoot("oss");
    // Laid out as the OSS snapshot is: one directory holding several independent repositories.
    const declaring = path.join(corpus, "declaring-repo");
    const silent = path.join(corpus, "silent-repo");
    await mkdir(path.join(declaring, "lib"), { recursive: true });
    await mkdir(path.join(silent, "lib"), { recursive: true });
    await writeFile(path.join(declaring, "vitest.config.ts"), [
      `import { defineConfig } from "vitest/config";`,
      `export default defineConfig({ test: { include: ["${DECLARED_TEST_GLOB}"] } });`
    ].join("\n"), "utf8");
    await writeFile(path.join(declaring, "lib", "widget.probe.ts"), exhibitingSource(), "utf8");
    await writeFile(path.join(silent, "lib", "widget.probe.ts"), exhibitingSource(), "utf8");

    const recorded = recordingStorage();
    await trainOssCorpus({ storage: recorded.storage, rootPath: corpus, maxFiles: 20, maxFileBytes: 100_000, ngramMaxOrder: 3, ngramMaxCountersPerOrder: 64 });

    const byPath = new Map<string, JsonValue>();
    for (const span of recorded.evidence) {
      const provenance = span.provenance as Record<string, JsonValue>;
      const relativePath = String((provenance as { relativePath?: unknown }).relativePath ?? "");
      const projection = String((provenance as { projection?: unknown }).projection ?? "");
      byPath.set(`${relativePath}#${projection}`, span.provenance);
    }
    const declared = [...byPath.entries()].filter(([key]) => key.startsWith("declaring-repo/lib/widget.probe.ts#"));
    const undeclared = [...byPath.entries()].filter(([key]) => key.startsWith("silent-repo/lib/widget.probe.ts#"));
    // The manifest itself is not one of the files it declares.
    for (const [key, provenance] of [...byPath.entries()].filter(([key]) => key.startsWith("declaring-repo/vitest.config.ts#"))) {
      expect(resolveSourceArtifactRole(provenance).role, key).not.toBe("test_source");
    }
    if (!declared.length || !undeclared.length) throw new Error(`no spans for one of the repositories: ${[...byPath.keys()].join(",")}`);

    for (const [key, provenance] of declared) {
      expect(resolveSourceArtifactRole(provenance), key).toMatchObject({ role: "test_source", declaredBy: "project_manifest" });
    }
    for (const [key, provenance] of undeclared) {
      expect(resolveSourceArtifactRole(provenance).role, key).toBe("unknown");
    }
    // Every projection in this lane rewrites the text, so no interval measured on the file describes the span.
    for (const [key, provenance] of [...declared, ...undeclared]) {
      const stance = resolveSpanAssertionalStance(provenance);
      expect(stance.measured, key).toBe(false);
      expect(stance.unmeasuredReason, key).not.toBe("");
    }
  });
});

/** The smallest storage `trainOssCorpus` runs against, recording only the spans it writes. */
function recordingStorage(): { storage: ScceStorage; evidence: EvidenceSpan[] } {
  const evidence: EvidenceSpan[] = [];
  const store = (overrides: Record<string, unknown>) => new Proxy({}, {
    get: (_target, key) => overrides[String(key)] ?? (async () => (String(key).startsWith("list") ? [] : null))
  });
  const storage = new Proxy({}, {
    get: (_target, key) => {
      if (key === "transaction") return async (fn: () => Promise<unknown>) => fn();
      if (key === "evidence") {
        return store({
          putEvidenceSpans: async (spans: readonly EvidenceSpan[]) => { evidence.push(...spans); },
          putEvidenceSpan: async (span: EvidenceSpan) => { evidence.push(span); },
          searchEvidence: async () => [],
          sourceVersionsForEvidence: async () => []
        });
      }
      if (key === "events") return store({ readEpisode: async () => [], readRange: async () => [], latestLedgerHash: async () => "" });
      if (key === "graph") return store({ getSlice: async () => ({ nodes: [], edges: [], hyperedges: [], bounded: true, query: {} }) });
      if (key === "blobs") return store({ put: async (bytes: Uint8Array) => blobContentHash(bytes) });
      if (key === "model") {
        return store({
          readModel: async () => ({ languageProfiles: [], latentConcepts: [], learnedProgramPatterns: [], learningGoals: [], trainingSteps: 0 })
        });
      }
      if (typeof key === "string" && ["init", "migrate", "close"].includes(key)) return async () => undefined;
      return store({});
    }
  }) as unknown as ScceStorage;
  return { storage, evidence };
}

function exhibitedRanges(metadata: JsonValue): Array<[number, number]> {
  const record = metadata as Record<string, JsonValue>;
  const block = record.exhibitedContent as Record<string, JsonValue> | undefined;
  const ranges = block?.ranges;
  return Array.isArray(ranges) ? ranges.map(range => [Number((range as number[])[0]), Number((range as number[])[1])]) : [];
}

function productionSource(): string {
  return [
    `export function widgetName(): string {`,
    `  return "widget";`,
    `}`,
    ``
  ].join("\n");
}

function exhibitingSource(): string {
  return [
    `import { widgetName } from "./widget.js";`,
    ``,
    `const article = "${EXHIBITED_SENTENCE}";`,
    ``,
    `export function widgetName(): string {`,
    `  return article.length ? widgetName() : "";`,
    `}`,
    ``
  ].join("\n");
}

async function fixtureRoot(label: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `scce-artifact-role-${label}-`));
  roots.push(root);
  return root;
}

/** Every file the production walk emitted, by repository-relative uri, with the metadata it stamped. */
async function walk(root: string): Promise<Map<string, JsonValue>> {
  const out = new Map<string, JsonValue>();
  for await (const event of new NodeFileIngestAdapter(configFor(root)).streamPath(root)) {
    if (event.type === "file") out.set(event.file.uri, { metadata: event.file.metadata } as JsonValue);
  }
  return out;
}

function spansFor(uri: string, text: string, provenance: JsonValue): EvidenceSpan[] {
  const clock = createClock({ fixedTime: 1_000 });
  const hasher = createHasher();
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
  const metadata = (provenance as { metadata: JsonValue }).metadata;
  const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({
    sourceVersionId: ids.sourceVersionId(Buffer.from(text, "utf8")),
    text,
    createdAt: 1_000
  });
  return createEvidenceExtractor({ idFactory: ids, hasher }).extract({
    sourceId: ids.sourceId("local-file", uri),
    sourceVersionId: ids.sourceVersionId(Buffer.from(text, "utf8")),
    namespace: "local-file",
    uri,
    mediaType: "text/plain",
    text,
    languageProfile: profile,
    sourceTrust: {
      identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1,
      independenceGroup: "fixture", accessScope: "owner_private", licenseStatus: "owner_authorized"
    },
    observedAt: 1_000,
    maxChunkBytes: 4096,
    metadata,
    exactSourceText: true
  }).spans;
}

function configFor(root: string): ScceRuntimeConfig {
  return {
    server: { url: "http://127.0.0.1:3873" },
    database: { url: "postgresql://fixture:fixture@127.0.0.1:5432/fixture", schema: "fixture" },
    runtime: {
      workspaceRoot: root,
      tempRoot: path.join(root, ".tmp"),
      maxFileBytes: 1024 * 1024,
      maxChunkBytes: 64 * 1024,
      allowedRoots: [root],
      excludedPaths: [],
      spreadsheet: { maxParseMs: 10_000, maxHeapMb: 192 },
      tools: {}
    },
    connectors: {},
    policy: {} as ScceRuntimeConfig["policy"]
  };
}
