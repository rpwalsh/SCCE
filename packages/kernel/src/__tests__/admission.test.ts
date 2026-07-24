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
    const decision = createSourceAdmissionController().decide({
      source,
      evidence,
      context: {
        sourceClass: "owner_local",
        intendedUse: "quarantine_only",
        promotionAuthority: "owner"
      },
      metadata: { diagnostics: { charLength: 800, parserCount: 1 } }
    });
    expect(decision.disposition).toBe("quarantine");
    expect(decision.activeInfluence).toEqual({ graph: false, language: false });
    expect(decision.safetyRails.length).toBeGreaterThan(0);
    expect(decision.evidenceActions[0]?.action).toBe("lower-alpha");
  });

  it("promotes runtime web evidence from typed automatic admission without namespace allowlists", () => {
    const source = sourceVersion("runtime-acquisition", "https://example.test/paper", 0.9);
    const evidence = [span(source, "alpha graph proof with source provenance and benchmark evidence", 0.72)];
    const decision = createSourceAdmissionController().decide({
      source,
      evidence,
      context: {
        sourceClass: "runtime_web",
        intendedUse: "direct_evidence",
        promotionAuthority: "automatic"
      },
      metadata: { diagnostics: { charLength: 1200, parserCount: 2 } }
    });
    expect(decision.disposition).toBe("promote");
    expect(decision.activeInfluence).toEqual({ graph: true, language: false });
    expect(Object.values(decision.trustChecks).every(Boolean)).toBe(true);
  });

  it("limits a promoted language-only corpus to language influence", () => {
    const source = sourceVersion("training", "corpus://language", 0.9);
    const evidence = [span(source, "learned multilingual surface construction", 0.72)];
    const decision = createSourceAdmissionController().decide({
      source,
      evidence,
      context: {
        sourceClass: "trusted_corpus",
        intendedUse: "language_only",
        promotionAuthority: "training"
      },
      metadata: { diagnostics: { charLength: 1200, parserCount: 2 }, licenseHint: "Apache-2.0" }
    });
    expect(decision.disposition).toBe("promote");
    expect(decision.activeInfluence).toEqual({ graph: false, language: true });
  });

  it("gates factual authority as its own dimension instead of averaging trust", () => {
    const source = sourceVersion("runtime-acquisition", "https://example.test/unverified", 0.95);
    source.sourceTrust = { ...source.sourceTrust, authority: 0.2 };
    const evidence = [span(source, "unverified factual assertion", 0.72)];
    const decision = createSourceAdmissionController().decide({
      source,
      evidence,
      context: {
        sourceClass: "runtime_web",
        intendedUse: "direct_evidence",
        promotionAuthority: "automatic"
      },
      metadata: { diagnostics: { charLength: 1200, parserCount: 2 } }
    });
    expect(decision.disposition).toBe("quarantine");
    expect(decision.trustChecks.authority).toBe(false);
    expect(decision.trustChecks.integrity).toBe(true);
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
      sourceTrust: {
        identity: trust,
        integrity: trust,
        parserReliability: trust,
        directness: trust,
        authority: trust,
        freshness: trust,
        independenceGroup: `fixture:${namespace}`,
        accessScope: "fixture",
        licenseStatus: "fixture"
      },
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
      trustVector: { sourceTrust: source.sourceTrust },
      provenance: {},
      features: [...text.split(/\s+/).map(symbol => `sym:${symbol.toLowerCase()}`), ...features],
      status: "quarantined",
      alpha,
      observedAt: clock.now()
    };
  }
});
