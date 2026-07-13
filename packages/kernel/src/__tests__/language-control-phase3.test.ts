import { describe, expect, it } from "vitest";
import {
  boundaryProfileFor,
  classifyParagraphRoleStructurally,
  createClock,
  createCorrectionMemory,
  createHasher,
  createIdFactory,
  createLanguageInductionEngine,
  createMultilingualAcquisitionEngine,
  detailPolicyForProfile,
  featureSet,
  classifyIngestionLane,
  inferConstructForces,
  legacyDetailProfileIdFromSignal,
  resolveDetailProfileId
} from "../index.js";
import type { EvidenceSpan, LanguageProfile } from "../index.js";
import type { SpeakInput } from "../mouth.js";

describe("language control plane profiles", () => {
  const clock = createClock({ fixedTime: 8000, stepMs: 1 });
  const hasher = createHasher();
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true });

  it("quarantines legacy detail labels before runtime planning", () => {
    const compact = legacyDetailProfileIdFromSignal("brief");
    const expanded = legacyDetailProfileIdFromSignal("detailed");
    expect(compact).toBeDefined();
    expect(expanded).toBeDefined();
    if (!compact || !expanded) throw new Error("legacy detail boundary fixture failed");
    const runtimeCompact = resolveDetailProfileId({ explicitProfileId: compact });
    const runtimeExpanded = resolveDetailProfileId({ explicitProfileId: expanded });
    expect(runtimeCompact).toBe(compact);
    expect(runtimeExpanded).toBe(expanded);
    const compactPolicy = detailPolicyForProfile(compact, undefined);
    const expandedPolicy = detailPolicyForProfile(expanded, undefined);

    expect(compact).not.toBe("brief");
    expect(expanded).not.toBe("detailed");
    expect(compactPolicy.maxSentenceCount).toBeLessThan(expandedPolicy.maxSentenceCount);
    expect(JSON.stringify(compactPolicy.audit)).toContain(compact);
  });

  it("keeps free-form owner feedback observational unless structured correction metadata exists", () => {
    const memory = createCorrectionMemory({ idFactory: ids, hasher });
    const episodeId = ids.episodeId();
    const ownerFeedbackEventId = ids.eventId();
    const observed = memory.observeFeedback({
      episodeId,
      ownerFeedbackEventId,
      now: clock.now(),
      metadata: { ownerFeedbackText: "please change how this feels" }
    });

    expect(observed.rules).toEqual([]);
    expect(observed.observations).toHaveLength(1);
    expect(observed.observations[0]?.requiresInterpretation).toBe(true);
    expect(observed.observations[0]?.forceClass).toBe("owner_feedback_observation");

    const structured = memory.observeFeedback({
      episodeId,
      ownerFeedbackEventId,
      now: clock.now(),
      metadata: {
        corrections: [{
          kind: "verbosity_preference",
          styleVector: [0.92, 0.1],
          weight: 0.84
        }]
      }
    });
    const influence = memory.styleFromRules({ rules: structured.rules });
    expect(structured.rules).toHaveLength(1);
    expect(structured.observations[0]?.requiresInterpretation).toBe(false);
    expect(influence.detailProfileId).toContain("surface.detail.profile.");
    expect(influence.detailProfileId).not.toBe("detailed");
  });

  it("derives typed-ingest language roles from document shape rather than metadata labels", () => {
    const left = classifyParagraphRoleStructurally("## Runtime Boundary");
    const right = classifyParagraphRoleStructurally("## Όριο Εκτέλεσης");
    const paragraph = classifyParagraphRoleStructurally("Runtime state carries imported graph activation across the field. It preserves source identity.");

    expect(left.role).toBe("heading");
    expect(right.role).toBe("heading");
    expect(paragraph.role).toBe("prose");
    expect(left.features).toHaveProperty("terminalMarks", 0);
  });

  it("routes ingestion lanes from source ids and media structure rather than filename words", () => {
    expect(classifyIngestionLane({ sourceKind: "developer_intelligence" })).toBe("developer_intelligence");
    expect(classifyIngestionLane({ adapterId: "github_repo" })).toBe("developer_intelligence");
    expect(classifyIngestionLane({ mediaType: "text/csv" })).toBe("local_engineering_corpus");
    expect(classifyIngestionLane({ uri: "notes/github discussion.txt" })).toBe("bulk_corpus");
    expect(classifyIngestionLane({ uri: "src/main.ts" })).toBe("developer_intelligence");
  });

  it("infers construct forces from structured graph/proof/field signals", () => {
    const result = inferConstructForces(speakInput());
    const rows = result.rows.map(row => row.id);

    expect(rows).toContain("FactualConstruct");
    expect(rows).toContain("ProgramConstruct");
    expect(JSON.stringify(result.audit)).toContain("structured_signals");
    expect(JSON.stringify(result.audit)).not.toContain("prompt-router");
  });

  it("builds boundary profiles from script/profile data", () => {
    const profile = boundaryProfileFor({ scriptId: "Arab" });
    expect(profile.id).toContain("surface.boundary.profile.");
    expect(profile.boundarySource).toBe("profile");
    expect(profile.sentenceForms.length).toBeGreaterThan(0);
    expect(profile.inlineForms.length).toBeGreaterThan(0);
  });

  it("keys multilingual acquisition by Unicode scripts instead of English language labels", () => {
    const engine = createMultilingualAcquisitionEngine({ hashText: text => hasher.digestHex(text).slice(0, 16) });
    const hangul = "\uC815\uB958\uC7A5 \uC13C\uC11C\uB294 \uC548\uC815\uC801\uC774\uB2E4.";
    const arabic = "\u0645\u062D\u0637\u0629 \u0627\u0644\u0627\u062E\u062A\u0628\u0627\u0631 \u0645\u0633\u062A\u0642\u0631\u0629.";
    const text = `${hangul} ${arabic}`;

    const report = engine.analyze({
      text,
      profiles: [profileForScript("arabic-fixture", "script:Arab", arabic)],
      evidence: [evidenceSpan("evidence:phase3:multi", text)]
    });

    expect(report.segments.map(segment => segment.script)).toEqual(expect.arrayContaining(["script:Hang", "script:Arab"]));
    expect(report.acquisitionNeeds.find(need => need.script === "script:Hang")?.evidenceIds).toContain("evidence:phase3:multi");
    expect(JSON.stringify(report.audit)).not.toContain("born in");
    expect(JSON.stringify(report.audit)).not.toContain("English");
  });

  it("induces non-demo language structure from source surfaces without seeded English predicates", () => {
    const engine = createLanguageInductionEngine({ hasher, vocabularyLimit: 512 });
    const hangul = "\uC815\uB958\uC7A5 \uC13C\uC11C \uC548\uC815 \uC2E0\uD638 42. \uC815\uB958\uC7A5 \uC13C\uC11C \uC548\uC815 \uC2E0\uD638 43.";
    const arabic = "\u0645\u062D\u0637\u0629 \u062D\u0633\u0627\u0633 \u0645\u0633\u062A\u0642\u0631 42. \u0645\u062D\u0637\u0629 \u062D\u0633\u0627\u0633 \u0645\u0633\u062A\u0642\u0631 43.";

    const model = engine.induce({
      order: 3,
      maxNgrams: 64,
      maxFrames: 16,
      documents: [
        { id: "hangul-station", text: hangul, sourceVersionId: ids.sourceVersionId("hangul-station"), evidenceIds: ["evidence:phase3:hangul" as never], languageHint: "source:hangul", trust: 0.86 },
        { id: "arabic-station", text: arabic, sourceVersionId: ids.sourceVersionId("arabic-station"), evidenceIds: ["evidence:phase3:arabic" as never], languageHint: "source:arabic", trust: 0.84 }
      ]
    });

    expect(model.scripts.map(script => script.script)).toEqual(expect.arrayContaining(["hangul", "arabic"]));
    expect(model.semanticFrames.some(frame => /[\uAC00-\uD7AF\u0600-\u06FF]/u.test(frame.predicate))).toBe(true);
    expect(JSON.stringify(model.semanticFrames)).not.toContain("born");
    expect(JSON.stringify(model.semanticFrames)).not.toContain("English");
  });

  function speakInput(): SpeakInput {
    return {
      construct: {
        id: ids.constructId("phase3"),
        episodeId: ids.episodeId(),
        forceVector: {},
        nodes: [{ id: "construct:program", kind: "construct:program", label: "phase3.program", metadata: {} }],
        edges: [],
        artifacts: [],
        program: {
          id: "program:phase3",
          files: [],
          commands: [],
          diagnostics: [],
          provenance: {}
        }
      },
      field: {
        active: [],
        ranked: [],
        ppf: [],
        powerWalk: [],
        alphaTrace: {
          alpha: 0.7,
          contradictionMass: 0,
          surfaces: { actionability: 0.8, drift: 0.12, novelty: 0.2, coherence: 0.8 },
          dimensions: {}
        },
        diagnostics: {},
        ppfDiagnostics: {}
      },
      languageProfile: {
        id: "phase3-language",
        sourceVersionId: ids.sourceVersionId("phase3"),
        scripts: [{ script: "Latn", mass: 1 }],
        symbolShapes: [],
        charNgrams: [],
        direction: "ltr",
        entropy: 0.7,
        createdAt: clock.now()
      },
      evidence: [],
      entailment: {
        verdict: "entailed",
        semanticVerdict: "entailed",
        force: "proved",
        claim: { id: "claim:phase3", text: "phase3 claim", atoms: [], features: [] },
        support: 0.9,
        contradiction: 0,
        evidenceIds: ["evidence:phase3" as never],
        missing: [],
        counterexamples: [],
        obligations: [],
        proof: { id: "proof:phase3", steps: [], scores: {} },
        boundaries: [],
        audit: {}
      },
      languageMemory: {
        id: "memory:phase3",
        importRunIds: [],
        streamIds: [],
        importedLanguagePriorCount: 0,
        importedNgramModels: [],
        importedObservations: [],
        importedUnits: [],
        importedPatterns: [],
        importedSemanticFrames: []
      }
    } as unknown as SpeakInput;
  }

  function evidenceSpan(id: string, text: string): EvidenceSpan {
    return {
      id: id as EvidenceSpan["id"],
      sourceId: "source:phase3:multilingual" as EvidenceSpan["sourceId"],
      sourceVersionId: ids.sourceVersionId(id),
      chunkId: `${id}:chunk` as EvidenceSpan["chunkId"],
      contentHash: hasher.digestHex(text) as EvidenceSpan["contentHash"],
      mediaType: "text/plain",
      byteStart: 0,
      byteEnd: Buffer.byteLength(text, "utf8"),
      charStart: 0,
      charEnd: [...text].length,
      text,
      textPreview: text,
      languageHints: {},
      scriptHints: {},
      trustVector: {},
      provenance: {},
      features: featureSet(text, 512),
      status: "promoted",
      alpha: 0.82,
      observedAt: clock.now()
    };
  }

  function profileForScript(id: string, script: string, text: string): LanguageProfile {
    return {
      id,
      sourceVersionId: ids.sourceVersionId(id),
      scripts: [{ script, mass: 1 }],
      symbolShapes: [{ shape: script, count: [...text].length }],
      charNgrams: profileCharNgrams(text).map(([ngram, count]) => ({ ngram, count })),
      direction: script === "script:Arab" ? "rtl" : "ltr",
      entropy: 0.7,
      createdAt: clock.now()
    };
  }

  function profileCharNgrams(text: string): Array<[string, number]> {
    const chars = [...text.normalize("NFC").replace(/\s+/g, "")];
    const counts = new Map<string, number>();
    for (let i = 0; i <= chars.length - 3; i++) {
      const ngram = chars.slice(i, i + 3).join("");
      counts.set(ngram, (counts.get(ngram) ?? 0) + 1);
    }
    return [...counts.entries()].slice(0, 96);
  }
});
