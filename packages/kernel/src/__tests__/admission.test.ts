import { describe, expect, it } from "vitest";
import { createSourceAdmissionController } from "../admission.js";
import { createClock, createHasher } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import type { EvidenceSpan, SourceVersion } from "../types.js";

describe("source admission", () => {
  const clock = createClock({ fixedTime: 1 });
  const hasher = createHasher();
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true });

  it("quarantines sensitive unpromoted material and caps evidence alpha", () => {
    const source = sourceVersion("clinical-note", "note.md", 0.8);
    const evidence = [span(source, "structured owner-private clinical observation", 0.91, ["safety:clinical_distress"])];
    const decision = createSourceAdmissionController().decide({ source, evidence, metadata: { diagnostics: { charLength: 800, parserCount: 1 } } });
    expect(decision.disposition).toBe("quarantine");
    expect(decision.safetyRails.length).toBeGreaterThan(0);
    expect(decision.evidenceActions[0]?.action).toBe("lower-alpha");
  });

  it("promotes explicitly allowed namespace when trust and risk pass", () => {
    const source = sourceVersion("approved", "approved://paper", 0.9);
    const evidence = [span(source, "alpha graph proof with source provenance and benchmark evidence", 0.72)];
    const decision = createSourceAdmissionController({ promoteNamespaces: ["approved"] }).decide({ source, evidence, metadata: { diagnostics: { charLength: 1200, parserCount: 2 } } });
    expect(decision.disposition).toBe("promote");
    expect(decision.trust).toBeGreaterThan(0.5);
  });

  function sourceVersion(namespace: string, uri: string, trust: number): SourceVersion {
    const bytes = Buffer.from(uri);
    const sourceId = ids.sourceId(namespace, uri);
    return {
      sourceId,
      sourceVersionId: ids.sourceVersionId(bytes),
      namespace,
      canonicalUri: uri,
      contentHash: ids.contentHash(bytes),
      mediaType: "text/plain",
      observedAt: clock.now(),
      byteLength: bytes.length,
      trust,
      metadata: {}
    };
  }

  function span(source: SourceVersion, text: string, alpha: number, features: string[] = []): EvidenceSpan {
    const bytes = Buffer.from(text);
    const contentHash = ids.contentHash(bytes);
    const chunkId = ids.chunkId({ sourceVersionId: source.sourceVersionId, byteStart: 0, byteEnd: bytes.length, chunkHash: contentHash });
    return {
      id: ids.evidenceId({ sourceVersionId: source.sourceVersionId, byteStart: 0, byteEnd: bytes.length, spanHash: contentHash }),
      sourceId: source.sourceId,
      sourceVersionId: source.sourceVersionId,
      chunkId,
      contentHash,
      mediaType: source.mediaType,
      byteStart: 0,
      byteEnd: bytes.length,
      charStart: 0,
      charEnd: text.length,
      text,
      textPreview: text,
      languageHints: {},
      scriptHints: {},
      trustVector: { sourceTrust: source.trust },
      provenance: {},
      features: [...text.split(/\s+/).map(symbol => `sym:${symbol.toLowerCase()}`), ...features],
      status: "quarantined",
      alpha,
      observedAt: clock.now()
    };
  }
});
