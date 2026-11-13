// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { CAPABILITY_DEMONSTRATION_SCHEMA, capabilityBindingForRequest, compileCapabilityDemonstrations } from "../capability-construction.js";
import { createHasher } from "../primitives.js";
import type { ScceStorage } from "../storage.js";
import type { EvidenceSpan } from "../types.js";
import { capabilityRuntimeFixture } from "./fixtures/capability-runtime.js";

const demonstration = (swapped = false) => ({ request: "α «𝒜» β «한국어»", capabilityId: "outlook.create_draft",
  payload: { subject: swapped ? "한국어" : "𝒜", body: swapped ? "𝒜" : "한국어", to: ["owner@example.invalid"] },
  bindings: swapped ? [{ path: ["body"], startCodePoint: 3, endCodePoint: 4 }, { path: ["subject"], startCodePoint: 9, endCodePoint: 12 }]
    : [{ path: ["subject"], startCodePoint: 3, endCodePoint: 4 }, { path: ["body"], startCodePoint: 9, endCodePoint: 12 }] });

async function fixture(ambiguous = false) {
  const durable = capabilityRuntimeFixture();
  const text = JSON.stringify({ schema: CAPABILITY_DEMONSTRATION_SCHEMA, examples: [demonstration(), ...(ambiguous ? [demonstration(true)] : [])] });
  const contentHash = await durable.blobs.put(new TextEncoder().encode(text), "application/json");
  const evidence = [{ id: "evidence.action", sourceId: "source.action", sourceVersionId: "version.action", contentHash,
    text, charStart: 0, charEnd: [...text].length, status: "promoted" }] as unknown as EvidenceSpan[];
  const owner = { sourceId: evidence[0]!.sourceId, sourceVersionId: evidence[0]!.sourceVersionId, contentHash, profileId: "profile.action" };
  const patterns = compileCapabilityDemonstrations({ sourceText: text, owner, evidence, hasher: createHasher(), updatedAt: 1 });
  const storage = { blobs: durable.blobs, evidence: { getEvidenceBatch: async () => evidence },
    languageMemory: { listLanguagePatterns: async () => patterns } } as unknown as ScceStorage;
  return { durable, text, contentHash, owner, evidence, patterns, storage };
}

describe("source-owned capability constructions", () => {
  it("rejects competing parameter meanings for the same learned surface", async () => {
    const f = await fixture(true);
    expect(f.patterns).toHaveLength(1);
    expect(await capabilityBindingForRequest({ storage: f.storage, requestText: "α «new subject» β «new body»" })).toBeUndefined();
  });

  it("requires the current source's promoted evidence and exact canonical bytes", async () => {
    const f = await fixture();
    expect(await capabilityBindingForRequest({ storage: f.storage, requestText: "α «fresh» β «内容»" })).toMatchObject({
      payload: { subject: "fresh", body: "内容", to: ["owner@example.invalid"] }
    });
    expect(await capabilityBindingForRequest({ storage: f.storage, requestText: "α «fresh» β «内容»", sourceVersionAllowlist: ["other.version"] })).toBeUndefined();
    f.evidence[0]!.status = "quarantined";
    expect(await capabilityBindingForRequest({ storage: f.storage, requestText: "α «fresh» β «内容»" })).toBeUndefined();
    f.evidence[0]!.status = "promoted";
    f.durable.values.set(f.contentHash, new TextEncoder().encode(f.text + " "));
    await expect(capabilityBindingForRequest({ storage: f.storage, requestText: "α «fresh» β «内容»" })).rejects.toThrow(/hash verification/);
  });

  it("stores source references and learned family identity without copying the demonstration payload", async () => {
    const f = await fixture();
    const encoded = JSON.stringify(f.patterns[0]!.patternJson);
    expect(encoded).not.toContain(demonstration().request);
    expect(encoded).not.toContain("owner@example.invalid");
    expect(encoded).not.toContain("한국어");
    expect(compileCapabilityDemonstrations({ sourceText: f.text, owner: f.owner, evidence: f.evidence, hasher: createHasher(), updatedAt: 2 }).map(row => row.id))
      .toEqual(f.patterns.map(row => row.id));
  });

  it("refuses annotations that disagree with the source request or name absent payload fields", async () => {
    const f = await fixture();
    const corpus = { schema: CAPABILITY_DEMONSTRATION_SCHEMA, examples: [{ ...demonstration(), bindings: [{ path: ["subject"], startCodePoint: 9, endCodePoint: 12 }] }] };
    const text = JSON.stringify(corpus);
    expect(() => compileCapabilityDemonstrations({ sourceText: text, owner: { ...f.owner, contentHash: `sha256_${createHasher().digestHex(text)}` as typeof f.contentHash },
      evidence: f.evidence, hasher: createHasher(), updatedAt: 1 })).toThrow(/parameter differs/);
  });
});
