// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { canonicalStringify, createClock, createHasher, createIdFactory, createUniversalCreativeEventConstructionCompiler,
  CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA, hydrateLanguageConstructionPatterns, requestSeedLanguagePattern,
  type EvidenceSpan, type JsonValue, type LanguagePatternRecord } from "@scce/kernel";
import { DURABLE_CREATIVE_EVENT_STORAGE_SCHEMA, encodeDurableCreativeEvents } from "../durable-creative-event-storage.js";
import { decodeDurableJoinPrograms, DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY, DURABLE_JOIN_PROGRAM_BYTE_LEDGER_SCHEMA,
  durableJoinProgramJsonByteLengths, encodeDurableJoinPrograms } from "../durable-join-program-storage.js";

const cold = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
const hasher = createHasher();
const digest = (value: unknown): string => hasher.digestHex(canonicalStringify(value));
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("expected object");
  return value as Record<string, unknown>;
};
const page = (events: unknown[]) => ({ schema: CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA, contentDigest: "unchanged",
  bundle: { schema: CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA, compilerId: "compiler.owned", profileId: "profile.owned",
    sourceVersionIds: ["version.owned"], evidenceIds: ["evidence.owned"], evidenceContentHashes: ["content.owned"],
    sourcePage: { recipe: "recipe.owned", compilationId: "compilation.owned", index: 0, pageCount: 1, windows: [] }, events } });

function repetitivePage() {
  const extension = JSON.parse('{"__proto__":{"retained":true},"constructor":"owned","empty":"","null":null,"number":12.5,"values":[true,false,null,12.5],"text":"雪🧭é\\u0000\\n\\t\\r\\\"\\\\"}');
  return page(Array.from({ length: 32 }, (_, index) => ({ id: `event.${index}`, owner: "source.current.owned", extension })));
}

function packedMarker(value = repetitivePage()): Record<string, unknown> {
  const packed = encodeDurableJoinPrograms(value);
  const marker = record(record(packed).bundle).events;
  expect(record(marker).schema).toBe(DURABLE_CREATIVE_EVENT_STORAGE_SCHEMA);
  return record(marker);
}

describe("durable creative-event page representation", () => {
  it("packs every original human event and preserves frozen public artifacts, current ownership and complete hydration", () => {
    const text = (JSON.parse(readFileSync(new URL("../../../kernel/src/__tests__/fixtures/dolly-human-16.json", import.meta.url), "utf8")) as { text: string }).text;
    expect(Buffer.byteLength(text)).toBe(17248);
    expect(hasher.digestHex(text)).toBe("307c6758d4173c6dd87d0b77460c74fafe62c3e58d934eabbf5e05268de3dadc");
    const ids = createIdFactory({ hasher, clock: createClock({ fixedTime: 1 }), deterministicReplay: true, namespace: "creative-storage" });
    const sourceVersionId = ids.sourceVersionId(text), contentHash = ids.contentHash(text), length = Buffer.byteLength(text);
    const evidence: EvidenceSpan = { id: ids.evidenceId({ sourceVersionId, byteStart: 0, byteEnd: length, spanHash: contentHash }),
      sourceId: ids.sourceId("fixture", "fixture://dolly-human-16"), sourceVersionId,
      chunkId: ids.chunkId({ sourceVersionId, byteStart: 0, byteEnd: length, chunkHash: contentHash }), contentHash,
      mediaType: "text/plain", byteStart: 0, byteEnd: length, charStart: 0, charEnd: [...text].length, text, textPreview: text,
      languageHints: {}, scriptHints: {}, trustVector: {}, provenance: {}, features: [], status: "promoted", alpha: 1, observedAt: 1 };
    const compiled = createUniversalCreativeEventConstructionCompiler().compile({ profileId: "profile.human.16", evidence: [evidence], hasher, updatedAt: 1 });
    expect(compiled.status).toBe("compiled");
    if (compiled.status !== "compiled") throw Error("expected unchanged human compiler output");
    const patterns = (compiled.patterns ?? [compiled.pattern]).filter(pattern => record(pattern.patternJson).bundle);
    expect(patterns).toHaveLength(4);
    expect(patterns.map(pattern => digest(pattern.patternJson))).toEqual([
      "276b6d71295d407e5b3af41d9b96a836fc9df707287a8444a380a246860d99f4",
      "53617978d2684ddd9659709a6de541c4af5fb352ba9d299f488613bc25de2151",
      "10417e62f3a4e15eafb0c09417900f9d3d51b05a2d555ad853597814e38e4986",
      "83839aaad7ccf2b321ff5d1f08836f3151712d6c2e81ea497f5d23e10020d58c"
    ]);
    const restored: LanguagePatternRecord[] = [];
    const measurements = patterns.map(pattern => {
      const original = pattern.patternJson, encoded = encodeDurableJoinPrograms(original);
      const marker = record(record(encoded).bundle).events;
      expect(record(marker).schema).toBe(DURABLE_CREATIVE_EVENT_STORAGE_SCHEMA);
      expect(bytes(encoded)).toBeLessThan(bytes(original) / 2);
      expect(encodeDurableJoinPrograms(encoded)).toBe(encoded);
      const decoded = decodeDurableJoinPrograms<JsonValue>(cold(encoded));
      expect(decoded).toEqual(original);
      expect(digest(decoded)).toBe(digest(original));
      restored.push({ ...pattern, patternJson: decoded });
      const ledger = record(record(encoded)[DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]);
      expect(ledger).toEqual({ schema: DURABLE_JOIN_PROGRAM_BYTE_LEDGER_SCHEMA, ...durableJoinProgramJsonByteLengths(original) });
      expect(ledger.decodedJsonBytes).toBe(bytes(original));
      expect(requestSeedLanguagePattern({ ...pattern, patternJson: encoded as JsonValue })).toEqual(requestSeedLanguagePattern(pattern));
      const originalBundle = record(record(original).bundle), packedBundle = record(record(encoded).bundle);
      const { events: _events, ...headers } = originalBundle, { events: _packedEvents, ...packedHeaders } = packedBundle;
      expect(packedHeaders).toEqual(headers);
      return { events: (originalBundle.events as unknown[]).length, beforeBytes: bytes(original), encodedBytes: bytes(encoded),
        beforeDeflateBytes: deflateRawSync(JSON.stringify(original)).length, encodedDeflateBytes: deflateRawSync(JSON.stringify(encoded)).length };
    });
    const originalHydration = hydrateLanguageConstructionPatterns({ patterns, evidence: [evidence], hasher });
    const hydration = hydrateLanguageConstructionPatterns({ patterns: restored, evidence: [evidence], hasher });
    expect(hydration.bundles).toHaveLength(4);
    expect(hydration).toEqual(originalHydration);
    const eventIds = hydration.bundles.flatMap(bundle => bundle.creativeEvents?.map(event => event.id) ?? []);
    expect(measurements.reduce((sum, page) => sum + page.events, 0)).toBe(2605);
    expect(eventIds).toHaveLength(2559);
    expect(new Set(eventIds).size).toBe(eventIds.length);
    for (const invalid of [{ ...evidence, status: "quarantined" as const }, { ...evidence, contentHash: ids.contentHash("changed") },
      { ...evidence, sourceVersionId: ids.sourceVersionId("foreign") }]) {
      expect(hydrateLanguageConstructionPatterns({ patterns: restored, evidence: [invalid], hasher }).bundles).toEqual([]);
    }
    expect(hydrateLanguageConstructionPatterns({ patterns: restored.map(pattern => ({ ...pattern, profileId: "foreign" })), evidence: [evidence], hasher }).bundles).toEqual([]);
    const changed = cold(restored[0]!);
    record((record(record(changed.patternJson).bundle).events as unknown[])[0]).sourceLabel = "forged";
    expect(hydrateLanguageConstructionPatterns({ patterns: [changed], evidence: [evidence], hasher }).bundles).toEqual([]);
    console.log(JSON.stringify({ schema: "scce.creative_event_storage_fixture.v1", sourceBytes: length, pages: measurements }));
  });

  it("preserves every JSON field, Unicode, escaped NUL and prototype-like names through nested aggregate cold storage", () => {
    const original = repetitivePage(), aggregate = { events: [{ payload: original }], model: { patternJson: original } };
    const encoded = encodeDurableJoinPrograms(aggregate);
    expect(bytes(encoded)).toBeLessThan(bytes(aggregate) / 2);
    const restored = decodeDurableJoinPrograms<typeof aggregate>(cold(encoded));
    expect(restored).toEqual(aggregate);
    expect(JSON.stringify(restored)).toBe(JSON.stringify(aggregate));
    expect(JSON.stringify(restored)).toContain("\\u0000");
    const ledger = record(record(encoded)[DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]);
    expect(ledger.decodedJsonBytes).toBe(bytes(aggregate));
    const jsonbBytes = (value: unknown): number => {
      if (!value || typeof value !== "object") return bytes(value);
      const entries = Array.isArray(value) ? value.map(jsonbBytes) : Object.entries(value).map(([key, child]) => bytes(key) + 2 + jsonbBytes(child));
      return entries.reduce((sum, size) => sum + size, 2 + Math.max(0, entries.length - 1) * 2);
    };
    expect(ledger.decodedJsonbBytes).toBe(jsonbBytes(aggregate));
  });

  it("keeps tiny pages, unrelated schemas, unsupported non-JSON values and caller ledger collisions unchanged", () => {
    const tiny = page([null]);
    expect(encodeDurableJoinPrograms(tiny)).toBe(tiny);
    const unrelated = { ...repetitivePage(), bundle: { ...repetitivePage().bundle, schema: "unrelated" } };
    expect(encodeDurableJoinPrograms(unrelated)).toBe(unrelated);
    for (const value of [undefined, NaN, Infinity, -0, new Date(0), 1n, () => 1]) {
      const original = repetitivePage(); Object.assign(original.bundle.events[0]!, { unsupported: value });
      expect(encodeDurableCreativeEvents(original.bundle.events), `unsupported ${String(value)}`).toBeUndefined();
    }
    const collision = { ...repetitivePage(), [DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]: { retained: true } };
    expect(encodeDurableJoinPrograms(collision)).toBe(collision);
    expect(decodeDurableJoinPrograms(cold(collision))).toEqual(collision);
  });

  it("keeps the original representation unless savings include the complete root byte ledger", () => {
    for (let count = 1; count <= 32; count++) {
      const original = page(Array.from({ length: count }, () => ({ surface: "shared", roles: ["opaque.role"] })));
      const encoded = encodeDurableJoinPrograms(original);
      if (encoded !== original) expect(bytes(encoded)).toBeLessThan(bytes(original));
      expect(decodeDurableJoinPrograms(cold(encoded))).toEqual(original);
    }
  });

  it("counts escaped NUL keys and values using their exact public JSON bytes", () => {
    const value = { ["key\u0000"]: "雪🧭\u0000\ud800" };
    expect(durableJoinProgramJsonByteLengths(value)).toEqual({ decodedJsonBytes: bytes(value), decodedJsonbBytes: bytes(value) + 1 });
  });

  it("rejects malformed tables, tags, references and extensions instead of interpreting a changed event", () => {
    const good = packedMarker();
    const corruptions: Array<(value: Record<string, unknown>) => void> = [
      value => { value.strings = [null]; }, value => { value.strings = ["duplicate", "duplicate"]; },
      value => { value.shapes = [["key", "key"]]; }, value => { value.shapes = [[0]]; },
      value => { value.values = {}; }, value => { value.extension = true; },
      ...[-1, 1e100, "raw", [9], [0, 1, 2], [0, Infinity], [2, 1000000], [2, 0], [1, "raw"]]
        .map(invalid => (value: Record<string, unknown>) => { value.values = [invalid]; })
    ];
    for (const corrupt of corruptions) {
      const invalid = cold(good); corrupt(invalid);
      expect(() => decodeDurableJoinPrograms({ nested: invalid })).toThrow("invalid durable creative-event storage marker");
    }
  });
});
