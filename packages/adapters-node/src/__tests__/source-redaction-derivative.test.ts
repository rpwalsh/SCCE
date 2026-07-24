import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createClock,
  createEvidenceExtractor,
  createHasher,
  createIdFactory,
  createLanguageAcquisitionEngine
} from "@scce/kernel";
import { NodeFileIngestAdapter } from "../files.js";
import type { ScceRuntimeConfig } from "../config.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("source redaction derivatives", () => {
  it("preserves original bytes while binding evidence to exact derivative bytes and interval maps", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scce-source-derivative-"));
    roots.push(root);
    const sourcePath = path.join(root, "private-notes.txt");
    const originalText = [
      "Intro 🔒",
      "password = correct-horse-battery-staple",
      "Middle",
      "postgres://alice:secret@db.example.test/scce",
      "Tail marker"
    ].join("\n");
    await writeFile(sourcePath, originalText, "utf8");

    const events = [];
    for await (const event of new NodeFileIngestAdapter(configFor(root)).streamPath(sourcePath)) {
      events.push(event);
    }
    const fileEvent = events.find(event => event.type === "file");
    if (!fileEvent || fileEvent.type !== "file") throw new Error("fixture file was not emitted");
    const derivative = fileEvent.file.evidenceDerivative;
    if (!derivative) throw new Error("redacted evidence derivative was not emitted");

    expect(Buffer.from(fileEvent.file.bytes).toString("utf8")).toBe(originalText);
    expect(Buffer.from(derivative.bytes).toString("utf8")).toBe(derivative.text);
    expect(derivative.text).not.toContain("correct-horse-battery-staple");
    expect(derivative.text).not.toContain("alice:secret");
    expect(derivative.redactionMap).toHaveLength(2);
    for (const interval of derivative.redactionMap) {
      expect(Buffer.from(fileEvent.file.bytes)
        .subarray(interval.originalByteStart, interval.originalByteEnd)
        .toString("utf8")).not.toBe(interval.replacement);
      expect(Buffer.from(derivative.bytes)
        .subarray(interval.derivativeByteStart, interval.derivativeByteEnd)
        .toString("utf8")).toBe(interval.replacement);
      expect([...originalText].slice(interval.originalCharStart, interval.originalCharEnd).join("")).not.toBe(interval.replacement);
      expect([...derivative.text].slice(interval.derivativeCharStart, interval.derivativeCharEnd).join("")).toBe(interval.replacement);
    }

    const clock = createClock({ fixedTime: 1_000 });
    const hasher = createHasher();
    const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
    const originalSourceVersionId = ids.sourceVersionId(fileEvent.file.bytes);
    const derivativeSourceVersionId = ids.sourceVersionId(derivative.bytes);
    expect(derivativeSourceVersionId).not.toBe(originalSourceVersionId);
    const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({
      sourceVersionId: derivativeSourceVersionId,
      text: derivative.text,
      createdAt: clock.now()
    });
    const extracted = createEvidenceExtractor({ idFactory: ids, hasher }).extract({
      sourceId: ids.sourceId(fileEvent.file.namespace, fileEvent.file.uri),
      sourceVersionId: derivativeSourceVersionId,
      namespace: fileEvent.file.namespace,
      uri: fileEvent.file.uri,
      mediaType: "text/plain; charset=utf-8",
      text: derivative.text,
      languageProfile: profile,
      sourceTrust: {
        identity: 1, integrity: 1, parserReliability: 1, directness: 1,
        authority: 1, freshness: 1, independenceGroup: "fixture:redaction",
        accessScope: "owner_private", licenseStatus: "owner_authorized"
      },
      observedAt: clock.now(),
      maxChunkBytes: 4096,
      metadata: fileEvent.file.metadata,
      exactSourceText: true
    });
    expect(extracted.spans.length).toBeGreaterThan(0);
    for (const span of extracted.spans) {
      expect(span.sourceVersionId).toBe(derivativeSourceVersionId);
      expect(Buffer.from(derivative.bytes)
        .subarray(span.byteStart, span.byteEnd)
        .toString("utf8")).toBe(span.text);
    }
  });
});

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
