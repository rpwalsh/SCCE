// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { canonicalStringify, createHasher, hydrateLanguageConstructionPatterns, type EvidenceSpan, type LanguagePatternRecord, type SourceVersion } from "@scce/kernel";
import { bindSourceConstructionComponents } from "../language-corpus-trainer.js";
import { constructionDecisionCodecFixture } from "./fixtures/construction-decision-codec.js";

const actual = JSON.parse(readFileSync(new URL("./fixtures/actual-dolly-source-relation.json", import.meta.url), "utf8")) as {
  pattern: LanguagePatternRecord; source: SourceVersion; evidence: EvidenceSpan[]; sourceGaps: Array<{ byteStart: number; text: string }>;
};
const hasher = createHasher();
const record = (value: unknown) => value as Record<string, unknown>;

it("binds genuine retained-source compiler output to immutable components and cold-restores through the production codec", async () => {
  const original = canonicalStringify(actual.pattern), source = canonicalStringify(actual.source);
  const bytes = Buffer.alloc(actual.source.byteLength);
  for (const span of actual.evidence) {
    expect(`sha256_${hasher.digestHex(span.text)}`).toBe(span.contentHash);
    expect(Buffer.byteLength(span.text)).toBe(span.byteEnd - span.byteStart);
    expect([...span.text].length).toBe(span.charEnd - span.charStart);
    Buffer.from(span.text).copy(bytes, span.byteStart);
  }
  for (const gap of actual.sourceGaps) Buffer.from(gap.text).copy(bytes, gap.byteStart);
  expect(`sha256_${hasher.digestHex(bytes)}`).toBe(actual.source.contentHash);
  const input = { storage: { evidence: { sourceVersionsForEvidence: async () => [actual.source] } } as Parameters<typeof bindSourceConstructionComponents>[0]["storage"],
    patterns: [actual.pattern], source: actual.source, profileId: actual.pattern.profileId, evidence: actual.evidence, hasher };
  const bound = await bindSourceConstructionComponents(input);
  expect(bound).toHaveLength(1);
  expect(bound[0]!.id).not.toBe(actual.pattern.id);
  expect(record(bound[0]!.patternJson).sourceCompilationId).toBeUndefined();
  expect(record(bound[0]!.patternJson).sourceConstructionComponent).toMatchObject({ sourceId: actual.source.sourceId,
    sourceVersionId: actual.source.sourceVersionId, sourceContentHash: actual.source.contentHash, profileId: actual.pattern.profileId });
  expect(record(bound[0]!.patternJson).bundle).toEqual(record(actual.pattern.patternJson).bundle);
  const codec = constructionDecisionCodecFixture(() => actual.evidence);
  await expect(codec.roundTrip([actual.pattern])).rejects.toThrow("missing_source_compilation_owner");
  const decoded = await codec.roundTrip(bound);
  expect(decoded).toEqual(bound);
  expect(codec.physical.size).toBe(1);
  expect(record(codec.physical.get(bound[0]!.id)).sourceCompilationId).toBeUndefined();
  expect(record(codec.physical.get(bound[0]!.id)).sourceConstructionComponent).toEqual(record(bound[0]!.patternJson).sourceConstructionComponent);
  const hydrated = hydrateLanguageConstructionPatterns({ patterns: decoded, evidence: actual.evidence, hasher });
  expect(hydrated.rejected).toEqual([]);
  expect(hydrated.bundles).toHaveLength(1);
  const physical = canonicalStringify([...codec.physical]), pages = canonicalStringify([...codec.pages]);
  expect(await bindSourceConstructionComponents(input)).toEqual(bound);
  await codec.roundTrip(await bindSourceConstructionComponents(input));
  expect(canonicalStringify([...codec.physical])).toBe(physical);
  expect(canonicalStringify([...codec.pages])).toBe(pages);
  expect(canonicalStringify(actual.pattern)).toBe(original);
  expect(canonicalStringify(actual.source)).toBe(source);
});

it("rejects missing promoted or accessible source ports before binding a component", async () => {
  const input = { storage: { evidence: { sourceVersionsForEvidence: async () => [] } } as Parameters<typeof bindSourceConstructionComponents>[0]["storage"],
    patterns: [actual.pattern], source: actual.source, profileId: actual.pattern.profileId, evidence: actual.evidence, hasher };
  await expect(bindSourceConstructionComponents(input)).rejects.toThrow("accessible canonical source");
  await expect(bindSourceConstructionComponents({ ...input, evidence: [] })).rejects.toThrow("promoted source evidence");
});
