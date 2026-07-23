import { describe, expect, it } from "vitest";
import {
  createClock,
  createHasher,
  createIdFactory,
  createEvaluationCondition,
  createScceKernel,
  featureSet,
  verifyEvaluationTrace,
  type AlphaTrace,
  type BuildTestResult,
  type ContentHash,
  type EvidenceId,
  type EvidenceSpan,
  type GraphSlice,
  type JsonValue,
  type ModelState,
  type ScceEvent,
  type ScceStorage,
  type SemanticFrameRecord,
  type SourceId,
  type SourceVersionId,
  type EvaluationConditionId,
  type EvaluationTraceEvent
} from "../index.js";

describe("kernel local evidence source anchoring", () => {
  it("answers a locally present named source from its matching evidence instead of a generic A page", async () => {
    const clock = createClock({ fixedTime: 6000, stepMs: 1 });
    const hasher = createHasher();
    const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
    const genericA = evidenceSpan({
      id: "evidence:generic-a",
      sourceVersionId: "source:generic-a:v1" as SourceVersionId,
      title: "A",
      uri: "fixture://wiki/A",
      text: "A is the first letter of the Latin alphabet. This generic A page is not a biography source.",
      alpha: 0.99
    });
    const ada = evidenceSpan({
      id: "evidence:ada-lovelace",
      sourceVersionId: "source:ada-lovelace:v1" as SourceVersionId,
      title: "Ada Lovelace",
      uri: "fixture://wiki/Ada_Lovelace",
      text: "Ada Lovelace was a mathematician who wrote notes about Charles Babbage's Analytical Engine.",
      alpha: 0.9
    });
    const fixture = storageFixture({ evidence: [genericA, ada] });
    const kernel = createScceKernel({
      storage: fixture.storage,
      files: { streamPath: async function* () { /* unused */ } },
      buildTest: { executeProgram: async (): Promise<BuildTestResult> => ({ build: emptyCommandResult(), test: emptyCommandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
      idFactory: ids,
      clock,
      deterministicReplay: true
    });

    const result = await kernel.turn({ text: "Who was Ada Lovelace?" });

    expect(result.answer).toContain("Ada Lovelace");
    expect(result.answer).toContain("Analytical Engine");
    expect(result.answer).not.toContain("first letter of the Latin alphabet");
    expect(result.evidence.map(span => String(span.id))).toEqual([String(ada.id)]);
    expect(result.assistantForce).toBe("source_grounded_answer");
    expect(result.scoreTraces.length).toBeGreaterThan(0);
    expect(result.evidenceForce).toBe("direct");
    expect(result.guardFlags.sourceBacked).toBe(true);
    expect(result.retrievalRoles?.some(role => role.role === "support")).toBe(true);
    expect(JSON.stringify(result.actionGraph)).toContain('"sourceAnchorRequired":true');
    expect(JSON.stringify(result.actionGraph)).toContain('"sourceAnchorMatched":true');
    expect(JSON.stringify(result.actionGraph)).toContain("ada lovelace");
  });

  it("preserves both requested answer parts from one exact-title evidence span", async () => {
    const clock = createClock({ fixedTime: 6_500, stepMs: 1 });
    const hasher = createHasher();
    const ada = evidenceSpan({
      id: "evidence:ada-multipart",
      sourceVersionId: "source:ada-multipart:v1" as SourceVersionId,
      title: "Ada Lovelace",
      uri: "fixture://wiki/Ada_Lovelace",
      text: "Ada Lovelace was an English mathematician. Her contributions included publishing an algorithm intended for Charles Babbage's Analytical Engine.",
      alpha: 0.94
    });
    const fixture = storageFixture({ evidence: [ada] });
    const kernel = createScceKernel({
      storage: fixture.storage,
      files: { streamPath: async function* () { /* unused */ } },
      buildTest: { executeProgram: async (): Promise<BuildTestResult> => ({ build: emptyCommandResult(), test: emptyCommandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
      idFactory: createIdFactory({ clock, hasher, deterministicReplay: true }),
      clock,
      deterministicReplay: true
    });

    const result = await kernel.turn({ text: "Who was Ada Lovelace, and what did she contribute?" });

    expect(result.answer).toContain("English mathematician");
    expect(result.answer).toContain("publishing an algorithm");
    expect(result.evidence.map(span => String(span.id))).toEqual([String(ada.id)]);
    expect(result.assistantForce).toBe("source_grounded_answer");
    expect(result.guardFlags.sourceBacked).toBe(true);
  });

  it("preserves an explicitly discourse-bound durable source for a sparse pronoun follow-up", async () => {
    const clock = createClock({ fixedTime: 6_625, stepMs: 1 });
    const hasher = createHasher();
    const ada = evidenceSpan({
      id: "evidence:ada-discourse-followup",
      sourceVersionId: "source:ada-discourse-followup:v1" as SourceVersionId,
      title: "Ada Lovelace",
      uri: "fixture://wiki/Ada_Lovelace",
      text: "Ada Lovelace was an English mathematician. She published an algorithm intended for Charles Babbage's Analytical Engine.",
      alpha: 0.94
    });
    const fixture = storageFixture({ evidence: [ada] });
    const kernel = createScceKernel({
      storage: fixture.storage,
      files: { streamPath: async function* () { /* unused */ } },
      buildTest: { executeProgram: async (): Promise<BuildTestResult> => ({ build: emptyCommandResult(), test: emptyCommandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
      idFactory: createIdFactory({ clock, hasher, deterministicReplay: true }),
      clock,
      deterministicReplay: true
    });

    const result = await kernel.turn({
      text: "What about her?",
      metadata: {
        sessionContextEvidence: true,
        runtimeEvidenceIds: [String(ada.id)],
        discourse: {
          activeObject: {
            schema: "scce.discourse_object_state.v1",
            objectId: "discourse_object_ada",
            stateId: "discourse_state_ada_followup",
            selectedTurnId: "turn_assistant_ada",
            mentionIds: ["turn_assistant_ada"],
            evidenceIds: [String(ada.id)],
            sourceVersionIds: [String(ada.sourceVersionId)],
            salienceMass: 0.94,
            decayMass: 0,
            bindingConfidence: 0.92,
            signalIds: [],
            policyId: "disc.policy.fixture",
            surfaceHash: "fixture",
            queryConcatenationUsed: false,
            audit: { source: "focused-test" }
          }
        }
      }
    });

    expect(result.answer).toContain("Ada Lovelace was an English mathematician");
    expect(result.evidence.map(span => String(span.id))).toEqual([String(ada.id)]);
    expect(JSON.stringify(result.events)).toContain('"explicitContextBound":true');
    expect(JSON.stringify(result.events)).toContain('"sessionBound":false');
  });

  it("does not let a broad session-context flag admit an unrelated new topic without bound evidence ids", async () => {
    const clock = createClock({ fixedTime: 6_675, stepMs: 1 });
    const hasher = createHasher();
    const ada = evidenceSpan({
      id: "evidence:ada-unrelated-context",
      sourceVersionId: "source:ada-unrelated-context:v1" as SourceVersionId,
      title: "Ada Lovelace",
      uri: "fixture://wiki/Ada_Lovelace",
      text: "Ada Lovelace wrote notes about the Analytical Engine.",
      alpha: 0.96
    });
    const fixture = storageFixture({ evidence: [ada] });
    const kernel = createScceKernel({
      storage: fixture.storage,
      files: { streamPath: async function* () { /* unused */ } },
      buildTest: { executeProgram: async (): Promise<BuildTestResult> => ({ build: emptyCommandResult(), test: emptyCommandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
      idFactory: createIdFactory({ clock, hasher, deterministicReplay: true }),
      clock,
      deterministicReplay: true
    });

    const result = await kernel.turn({
      text: "What is anarchism?",
      metadata: { sessionContextEvidence: true }
    });

    expect(result.answer).not.toContain("Ada Lovelace");
    expect(result.answer).not.toContain("Analytical Engine");
    expect(result.evidence.map(span => String(span.id))).not.toContain(String(ada.id));
  });

  it("preserves a source-backed relation instead of reducing it to the named entity", async () => {
    const clock = createClock({ fixedTime: 6_750, stepMs: 1 });
    const hasher = createHasher();
    const route = evidenceSpan({
      id: "evidence:pump-route",
      sourceVersionId: "source:pump-route:v1" as SourceVersionId,
      title: "Fixture record",
      uri: "fixture://pump/route",
      text: "Pump alpha is controlled by API route POST /api/pumps/alpha/control.",
      alpha: 0.94
    });
    const fixture = storageFixture({ evidence: [route] });
    const kernel = createScceKernel({
      storage: fixture.storage,
      files: { streamPath: async function* () { /* unused */ } },
      buildTest: { executeProgram: async (): Promise<BuildTestResult> => ({ build: emptyCommandResult(), test: emptyCommandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
      idFactory: createIdFactory({ clock, hasher, deterministicReplay: true }),
      clock,
      deterministicReplay: true
    });

    const result = await kernel.turn({
      text: "What API route controls pump alpha?",
      metadata: {
        sessionContextEvidence: true,
        runtimeEvidenceIds: [String(route.id)]
      }
    });
    expect(result.answer).toContain("POST /api/pumps/alpha/control");
    expect(result.evidence.map(span => span.id)).toContain(route.id);
    expect(result.assistantForce).toBe("source_grounded_answer");
  });

  it("pairs an early temporal counterexample with distinct source-derived development context", async () => {
    const clock = createClock({ fixedTime: 6_900, stepMs: 1 });
    const hasher = createHasher();
    const subject = evidenceSpan({
      id: "evidence:martha-washington",
      sourceVersionId: "source:martha-washington:v1" as SourceVersionId,
      title: "Martha Washington",
      uri: "fixture://wiki/Martha_Washington",
      text: "Martha Washington (1731–1802) was the wife of George Washington.",
      alpha: 0.96
    });
    const historySurface = "In the early 17th century, ships flew flags showing nationality, and those practices evolved into national flags.";
    const counterexampleSurface = "The flag of Denmark, the Dannebrog, is attested in 1478, and is the oldest national flag still in use.";
    const hydratedLead = "A national flag represents and symbolizes a nation. ".repeat(160);
    const longDateSurface = "On 12 April 1606, a flag representing a union between two kingdoms was specified in a decree, according to which two existing standards would be joined.";
    const flagHistory = evidenceSpan({
      id: "evidence:national-flag-history",
      sourceVersionId: "source:national-flag-history:v1" as SourceVersionId,
      title: "National flag",
      uri: "fixture://wiki/National_flag",
      text: `${hydratedLead} [[File:Flag fixture.svg|thumb|decorative fixture]] The first flags aided [[military]] coordination. ${historySurface} ${longDateSurface} The national flag of France was designed in 1794. ${counterexampleSurface} National flags represent nation states.`,
      alpha: 0.94
    });
    expect((flagHistory.text ?? "").length).toBeGreaterThan(6_000);
    const fixture = storageFixture({ evidence: [subject, flagHistory] });
    const kernel = createScceKernel({
      storage: fixture.storage,
      files: { streamPath: async function* () { /* unused */ } },
      buildTest: { executeProgram: async (): Promise<BuildTestResult> => ({ build: emptyCommandResult(), test: emptyCommandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
      idFactory: createIdFactory({ clock, hasher, deterministicReplay: true }),
      clock,
      deterministicReplay: true
    });

    const result = await kernel.turn({
      text: "Did Martha Washington invent the idea of using flags to represent nation states?",
      metadata: {
        sessionContextEvidence: true,
        runtimeEvidenceIds: [String(subject.id), String(flagHistory.id)]
      }
    });
    expect(result.answer).toContain(historySurface);
    expect(result.answer).toContain(counterexampleSurface);
    expect(result.answer.indexOf("1478")).toBeLessThan(result.answer.indexOf("17th century"));
    expect(result.answer).not.toContain("The national flag of France was designed in 1794");
    expect(result.answer).not.toContain("On 12.");
    expect(result.answer).not.toContain("...");
    expect(result.answer).not.toContain("[[");
    expect(result.answer).not.toContain("File:");
    expect(result.answer.match(/ships flew flags showing nationality/gu)).toHaveLength(1);
    expect(result.answer.match(/Dannebrog/gu)).toHaveLength(1);
    expect(result.evidence.map(span => span.id)).toEqual(expect.arrayContaining([subject.id, flagHistory.id]));
    expect((result.selectedCandidate as { force?: string } | undefined)?.force).toBe("inferred");
    expect(result.epistemicForce).toBe("inferred");
    expect(result.truthState.symbolicState).toBe("truth.source_bound_only");
    expect(result.entailment.proof.verdict).toBe("inferred");
    expect(result.entailment.boundaries).toContain("temporal-counterexample-source-bound-inference");
    expect(result.truthState.contradictionMass).toBe(result.entailment.contradiction);
    expect((result.entailment.proof.confidence as Record<string, JsonValue>).originalContradiction).toBe(result.entailment.contradiction);
  });

  it("resolves source titles stored in normal ingest provenance metadata", async () => {
    const nested = evidenceSpan({
      id: "evidence:nested-title",
      sourceVersionId: "source:nested-title:v1" as SourceVersionId,
      title: "Nested Title",
      uri: "fixture://nested/title",
      text: "The Nested Title calibration phrase is cobalt lattice seven.",
      alpha: 0.92
    });
    nested.provenance = {
      uri: "fixture://nested/title",
      metadata: { title: "Nested Title" }
    };
    const fixture = storageFixture({ evidence: [nested] });
    const clock = createClock({ fixedTime: 1_500, stepMs: 1 });
    const hasher = createHasher();
    const kernel = createScceKernel({
      storage: fixture.storage,
      files: { streamPath: async function* () { /* unused */ } },
      buildTest: { executeProgram: async (): Promise<BuildTestResult> => ({ build: emptyCommandResult(), test: emptyCommandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
      idFactory: createIdFactory({ clock, hasher, deterministicReplay: true }),
      clock,
      deterministicReplay: true
    });

    const result = await kernel.turn({ text: "What is Nested Title?" });
    expect(result.assistantForce).not.toBe("insufficient_support");
    expect(result.evidence.map(span => span.id)).toContain(nested.id);
  });

  it("admits different-title evidence only when a matched semantic frame explicitly binds it", async () => {
    const clock = createClock({ fixedTime: 6_800, stepMs: 1 });
    const hasher = createHasher();
    const unrelatedCorpusTail = Array.from({ length: 320 }, (_, index) => `context${index}`).join(" ");
    const kirk = evidenceSpan({
      id: "evidence:star-trek-kirk-frame-bound",
      sourceVersionId: "source:star-trek-kirk-frame-bound:v1" as SourceVersionId,
      title: "List of Star Trek: The Original Series episodes",
      uri: "fixture://wiki/Star_Trek",
      text: `Created by Gene Roddenberry, Star Trek stars William Shatner as Captain James T. Kirk. ${unrelatedCorpusTail}.`,
      alpha: 0.96
    });
    const semanticFrame: SemanticFrameRecord = {
      id: "frame.fixture.captain-kirk.source-anchor",
      frameJson: {
        sourceSystem: "wikipedia",
        preview: "Captain James T. Kirk is the fictional commander of the starship Enterprise."
      },
      embedding: [],
      evidenceIds: [kirk.id],
      alpha: 0.98,
      createdAt: 1
    };
    const fixture = storageFixture({ evidence: [kirk], semanticFrames: [semanticFrame] });
    const kernel = createScceKernel({
      storage: fixture.storage,
      files: { streamPath: async function* () { /* unused */ } },
      buildTest: { executeProgram: async (): Promise<BuildTestResult> => ({ build: emptyCommandResult(), test: emptyCommandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
      idFactory: createIdFactory({ clock, hasher, deterministicReplay: true }),
      clock,
      deterministicReplay: true
    });

    const result = await kernel.turn({ text: "Who was Captain Kirk?" });

    expect(result.evidence.map(span => String(span.id))).toEqual([String(kirk.id)]);
    expect(result.assistantForce).toBe("source_grounded_answer");
    expect(JSON.stringify(result.actionGraph)).toContain('"sourceAnchorMatched":true');
  });

  it("does not admit a different-title content mention without a matched semantic-frame route", async () => {
    const clock = createClock({ fixedTime: 6_825, stepMs: 1 });
    const hasher = createHasher();
    const kirkMention = evidenceSpan({
      id: "evidence:star-trek-kirk-unrouted",
      sourceVersionId: "source:star-trek-kirk-unrouted:v1" as SourceVersionId,
      title: "Star Trek",
      uri: "fixture://wiki/Star_Trek",
      text: "Captain James T. Kirk is the fictional commander of the starship Enterprise in Star Trek.",
      alpha: 0.99
    });
    const fixture = storageFixture({ evidence: [kirkMention], semanticFrames: [] });
    const kernel = createScceKernel({
      storage: fixture.storage,
      files: { streamPath: async function* () { /* unused */ } },
      buildTest: { executeProgram: async (): Promise<BuildTestResult> => ({ build: emptyCommandResult(), test: emptyCommandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
      idFactory: createIdFactory({ clock, hasher, deterministicReplay: true }),
      clock,
      deterministicReplay: true
    });

    const result = await kernel.turn({ text: "Who was Captain Kirk?" });

    expect(result.evidence.map(span => String(span.id))).not.toContain(String(kirkMention.id));
    expect(result.answer).not.toContain("fictional commander");
    expect(result.answer).not.toContain("starship Enterprise");
    expect(JSON.stringify(result.actionGraph)).toContain('"sourceAnchorMatched":false');
  });

  it("uses a resident one-span exact source route without another durable graph read", async () => {
    const clock = createClock({ fixedTime: 6_850, stepMs: 1 });
    const hasher = createHasher();
    const ada = evidenceSpan({
      id: "evidence:ada-hot-one-span",
      sourceVersionId: "source:ada-hot-one-span:v1" as SourceVersionId,
      title: "Ada Lovelace",
      uri: "fixture://wiki/Ada_Lovelace",
      text: "Ada Lovelace was an English mathematician who published work about the Analytical Engine.",
      alpha: 0.97
    });
    const fixture = storageFixture({ evidence: [ada] });
    const kernel = createScceKernel({
      storage: fixture.storage,
      files: { streamPath: async function* () { /* unused */ } },
      buildTest: { executeProgram: async (): Promise<BuildTestResult> => ({ build: emptyCommandResult(), test: emptyCommandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
      idFactory: createIdFactory({ clock, hasher, deterministicReplay: true }),
      clock,
      deterministicReplay: true
    });

    const warmup = await kernel.warmup({ graph: true, language: false, brain: false, profile: false, corrections: false });
    expect(warmup.graph?.loaded).toBe(true);
    expect(fixture.metrics.graphReads).toBe(1);

    const result = await kernel.turn({ text: "Who was Ada Lovelace?" });

    expect(result.evidence.map(span => String(span.id))).toEqual([String(ada.id)]);
    expect(fixture.metrics.graphReads).toBe(1);
  });

  it("keeps the empty-memory acquisition floor non-assertive without inventing facts or templates", async () => {
    const clock = createClock({ fixedTime: 7000, stepMs: 1 });
    const hasher = createHasher();
    const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
    const fixture = storageFixture({
      evidence: [
        evidenceSpan({
          id: "evidence:generic-a",
          sourceVersionId: "source:generic-a:v1" as SourceVersionId,
          title: "A",
          uri: "fixture://wiki/A",
          text: "A is the first letter of the Latin alphabet. This local slice has no Star Trek source.",
          alpha: 0.99
        }),
        evidenceSpan({
          id: "evidence:ada-lovelace",
          sourceVersionId: "source:ada-lovelace:v1" as SourceVersionId,
          title: "Ada Lovelace",
          uri: "fixture://wiki/Ada_Lovelace",
          text: "Ada Lovelace was a mathematician who wrote notes about Charles Babbage's Analytical Engine.",
          alpha: 0.9
        })
      ]
    });
    const kernel = createScceKernel({
      storage: fixture.storage,
      files: { streamPath: async function* () { /* unused */ } },
      buildTest: { executeProgram: async (): Promise<BuildTestResult> => ({ build: emptyCommandResult(), test: emptyCommandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
      idFactory: ids,
      clock,
      deterministicReplay: true
    });

    const result = await kernel.turn({ text: "Who are the main characters in Star Trek?" });

    expect(result.assistantForce).toBe("insufficient_support");
    expect(result.requestedAuthority).toBe("factual");
    expect(result.constructGraph.nodes.some(node => node.kind === "construct:invention")).toBe(false);
    expect(result.answer.toLocaleLowerCase()).toContain("star trek");
    expect(result.answer.trim().length).toBeGreaterThan(0);
    expect(result.answer).not.toBe("Who are the main characters in Star Trek?");
    expect(result.answer.toLocaleLowerCase()).not.toContain("main — characters");
    expect(result.answer).not.toContain("Insufficient support");
    expect(result.answer).not.toContain("enough source-backed evidence");
    expect(result.runtimeMotion).toMatchObject({
      motionId: "motion.learn_hydrate_replan",
      attempt: 1,
      status: "unavailable"
    });
    expect(result.selectedCandidate).toMatchObject({ kind: "dialogue-continuation" });
    expect(result.constructGraph.nodes.some(node => (node.metadata as Record<string, JsonValue>).schema === "scce.runtime_motion_construct.v1")).toBe(true);
    expect(result.answer).not.toContain("[scce:");
    expect(result.evidence).toEqual([]);
    expect(result.guardFlags.missingEvidence).toBe(true);
    expect(result.guardFlags.unsupportedContentBlocked).toBe(true);
    expect(result.truthState.symbolicState).toBe("truth.insufficient_evidence");
    expect(result.answer).not.toContain("Spock");
    expect(result.answer).not.toContain("Kirk");
    expect(result.answer).not.toContain("Ada Lovelace");
    expect(result.answer).not.toContain(";");
    expect(JSON.stringify(result.selectedCandidate)).not.toContain("generated_not_evidence");
    expect(JSON.stringify(result.actionGraph)).toContain('"sourceAnchorRequired":true');
    expect(JSON.stringify(result.actionGraph)).toContain('"sourceAnchorMatched":false');
    expect(result.events.some(event => event.typeId === "SemanticEntailmentChecked")).toBe(true);
    expect(result.events.some(event => event.typeId === "MouthSpoken")).toBe(true);
  });

  it("does not escalate an irrelevant semantic prior into creative output after acquisition is exhausted", async () => {
    const clock = createClock({ fixedTime: 7_250, stepMs: 1 });
    const hasher = createHasher();
    const requestText = "What should the Aurora bridge crew rehearse?";
    const priorSurface = "Coordinate bridge roles through rotating scenario constraints";
    const semanticFrame: SemanticFrameRecord = {
      id: "frame.fixture.aurora.terminal-invention",
      frameJson: {
        continuationSurface: priorSurface,
        surface: requestText,
        semanticRoleId: "role.fixture.aurora.rehearsal",
        requirementCoefficients: {
          noveltyDemand: 4.2,
          inferentialDepth: 1.4,
          uncertaintyTolerance: 1.2
        }
      },
      embedding: [],
      evidenceIds: [],
      alpha: 0.98,
      createdAt: 1
    };
    const fixture = storageFixture({ evidence: [], semanticFrames: [semanticFrame] });
    const kernel = createScceKernel({
      storage: fixture.storage,
      files: { streamPath: async function* () { /* unused */ } },
      buildTest: { executeProgram: async (): Promise<BuildTestResult> => ({ build: emptyCommandResult(), test: emptyCommandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
      idFactory: createIdFactory({ clock, hasher, deterministicReplay: true }),
      clock,
      deterministicReplay: true
    });

    const result = await kernel.turn({ text: requestText, requestedAuthority: "factual" });
    const selectedAudit = JSON.stringify(result.selectedCandidate);

    expect(result.requestedAuthority).toBe("factual");
    expect(result.runtimeMotion).toMatchObject({ attempt: 1, status: "unavailable" });
    expect(result.selectedCandidate).toMatchObject({ kind: "dialogue-continuation", evidenceIds: [] });
    expect(result.assistantForce).not.toBe("creative_answer");
    expect(result.answer.trim().length).toBeGreaterThan(0);
    expect(result.answer).not.toContain(priorSurface);
    expect(result.answer).not.toBe(requestText);
    expect(result.evidence).toEqual([]);
    expect(result.emissionGraph.evidenceIds).toEqual([]);
    expect(result.truthState.symbolicState).toBe("truth.insufficient_evidence");
    expect(selectedAudit).not.toContain("scce.runtime_motion_invention_candidate.v1");
    expect(selectedAudit).not.toContain("policy.runtime_motion.prior_invention_after_exhausted_acquisition.v1");
    expect(selectedAudit).not.toContain("composition_fallback");
  });

  it("searches, fetches, ingests, and replans once through the configured read-only connector", async () => {
    const clock = createClock({ fixedTime: 7_500, stepMs: 1 });
    const hasher = createHasher();
    const acquiredEvidence: EvidenceSpan[] = [];
    const fixture = storageFixture({ evidence: acquiredEvidence });
    const calls: string[] = [];
    const sourceUri = "https://fixture.invalid/pump-alpha-control";
    const kernel = createScceKernel({
      storage: fixture.storage,
      files: { streamPath: async function* () { /* unused */ } },
      buildTest: { executeProgram: async (): Promise<BuildTestResult> => ({ build: emptyCommandResult(), test: emptyCommandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
      connectors: {
        async search(query, limit) {
          calls.push(`search:${query}:${limit}`);
          return [{ uri: sourceUri, title: "Pump Alpha", snippet: "Pump Alpha is controlled by API route POST /api/pumps/alpha/control.", metadata: { provider: "fixture" } }];
        },
        async fetch(uri) {
          calls.push(`fetch:${uri}`);
          return {
            uri,
            mediaType: "text/plain",
            bytes: new TextEncoder().encode("Pump Alpha is controlled by API route POST /api/pumps/alpha/control."),
            metadata: { status: 200 }
          };
        }
      },
      idFactory: createIdFactory({ clock, hasher, deterministicReplay: true }),
      clock,
      deterministicReplay: true
    });

    const result = await kernel.turn({ text: "What controls Pump Alpha?", requestedAuthority: "factual" });

    expect(calls).toEqual([
      "search:What controls Pump Alpha?:3",
      `fetch:${sourceUri}`
    ]);
    expect(result.answer.toLocaleLowerCase()).toContain("pump alpha");
    expect(result.answer).toContain("POST /api/pumps/alpha/control");
    expect(result.answer).toContain(sourceUri);
    expect(result.answer.toLocaleLowerCase()).not.toContain("what — controls");
    expect(result.answer).not.toContain("Insufficient support");
    expect(result.answer).not.toContain("enough source-backed evidence");
    expect(result.runtimeMotion).toMatchObject({
      motionId: "motion.learn_hydrate_replan",
      attempt: 1,
      status: "empty",
      ingestedSourceCount: 1,
      ingestedEvidenceCount: 0,
      sourceUris: [sourceUri]
    });
    expect(acquiredEvidence).toHaveLength(1);
    expect(acquiredEvidence[0]?.status).toBe("quarantined");
    expect(JSON.stringify(acquiredEvidence.map(span => span.provenance))).toContain(sourceUri);
    expect(result.evidence).toEqual([]);
    expect(fixture.events.filter(event => event.typeId === "RuntimeMotionPlanned")).toHaveLength(1);
    expect(fixture.events.filter(event => event.typeId === "RuntimeMotionCompleted")).toHaveLength(1);
  });

  it("answers deterministic arithmetic without requiring source evidence", async () => {
    const clock = createClock({ fixedTime: 8000, stepMs: 1 });
    const hasher = createHasher();
    const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
    const fixture = storageFixture({
      evidence: [
        evidenceSpan({
          id: "evidence:ada-lovelace",
          sourceVersionId: "source:ada-lovelace:v1" as SourceVersionId,
          title: "Ada Lovelace",
          uri: "fixture://wiki/Ada_Lovelace",
          text: "Ada Lovelace was a mathematician who wrote notes about Charles Babbage's Analytical Engine.",
          alpha: 0.9
        })
      ]
    });
    const kernel = createScceKernel({
      storage: fixture.storage,
      files: { streamPath: async function* () { /* unused */ } },
      buildTest: { executeProgram: async (): Promise<BuildTestResult> => ({ build: emptyCommandResult(), test: emptyCommandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
      idFactory: ids,
      clock,
      deterministicReplay: true
    });

    const result = await kernel.turn({ text: "2+2?" });

    expect(result.answer).toBe("2 + 2 = 4.");
    expect(result.assistantForce).toBe("reasoned_answer");
    expect(result.entailment.force).toBe("proved");
    expect(result.evidence).toEqual([]);
    expect(JSON.stringify(result.actionGraph)).toContain("deterministic_arithmetic");
    expect(result.events.some(event => event.typeId === "ComputationEvaluated")).toBe(true);
  });

  it("preserves source entities when an exact promoted target span licenses translation", async () => {
    const clock = createClock({ fixedTime: 8_500, stepMs: 1 });
    const hasher = createHasher();
    const target = evidenceSpan({
      id: "evidence:pump-alpha-es",
      sourceVersionId: "source:pump-alpha-es:v1" as SourceVersionId,
      title: "Pump alpha",
      uri: "fixture://translation/pump-alpha-es",
      text: "Pump alpha es estable.",
      alpha: 0.94
    });
    target.languageHints = { language: "lang.es", script: "Latn" };
    const fixture = storageFixture({ evidence: [target] });
    const kernel = createScceKernel({
      storage: fixture.storage,
      files: { streamPath: async function* () { /* unused */ } },
      buildTest: { executeProgram: async (): Promise<BuildTestResult> => ({ build: emptyCommandResult(), test: emptyCommandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
      idFactory: createIdFactory({ clock, hasher, deterministicReplay: true }),
      clock,
      deterministicReplay: true
    });

    const result = await kernel.turn({
      text: "Pump alpha is stable.",
      metadata: {
        targetLanguage: "lang.es",
        questionId: "translation-candidate-diagnostic",
        sessionContextEvidence: true,
        runtimeEvidenceIds: [String(target.id)],
        turnRequirements: [
          {
            id: "translation.fixture.semantic-preservation",
            dimension: "semanticPreservation",
            value: 1,
            confidence: 1,
            polarity: "required",
            status: "explicit",
            learnedFrameOrPatternId: "translation.fixture",
            sourceActivationId: "translation.fixture.activation",
            trace: { source: "kernel-local-evidence-anchor.test" }
          },
          {
            id: "translation.fixture.surface-transformation",
            dimension: "surfaceTransformation",
            value: 1,
            confidence: 1,
            polarity: "required",
            status: "explicit",
            learnedFrameOrPatternId: "translation.fixture",
            sourceActivationId: "translation.fixture.activation",
            trace: { source: "kernel-local-evidence-anchor.test" }
          }
        ]
      }
    });

    expect(result.selectedCandidate).toMatchObject({ kind: "translation" });
    expect(result.answer.toLowerCase()).toContain("pump alpha");
    expect(result.answer.toLowerCase()).toContain("es estable");
    expect(result.evidence.map(span => span.id)).toContain(target.id);
    expect(result.assistantForce).toBe("translation_answer");
  });

  it("creates and speaks an invention construct from an ordinary creative request", async () => {
    const clock = createClock({ fixedTime: 9_000, stepMs: 1 });
    const hasher = createHasher();
    const fixture = storageFixture({ evidence: [] });
    const kernel = createScceKernel({
      storage: fixture.storage,
      files: { streamPath: async function* () { /* unused */ } },
      buildTest: { executeProgram: async (): Promise<BuildTestResult> => ({ build: emptyCommandResult(), test: emptyCommandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
      idFactory: createIdFactory({ clock, hasher, deterministicReplay: true }),
      clock,
      deterministicReplay: true
    });

    const result = await kernel.turn({ text: "Invent a new indexing algorithm for this graph", requestedAuthority: "creative" });
    const inventionNode = result.constructGraph.nodes.find(node => node.kind === "construct:invention");

    expect(result.requestedAuthority).toBe("creative");
    expect(result.epistemicForce).toBe("invented");
    expect(result.assistantForce).toBe("creative_answer");
    expect(inventionNode).toBeDefined();
    expect(JSON.stringify(inventionNode?.metadata)).toContain("scce.invention_construct.v1");
    expect(JSON.stringify(result.candidateField)).toContain("creative-candidate");
    expect(result.selectedCandidate).toMatchObject({ kind: "creative-candidate" });
    expect(JSON.stringify(result.judge)).toContain("creative-candidate");
    expect(result.emissionGraph.evidenceIds).toEqual([]);
    expect(result.answer.trim().length, JSON.stringify({
      selectedCandidate: result.selectedCandidate,
      construct: result.constructGraph.nodes.find(node => node.kind === "construct:invention"),
      mouth: result.events.find(event => event.typeId === "MouthSpoken")?.payload
    })).toBeGreaterThan(24);
    expect(result.answer.trim().startsWith("{")).toBe(false);
    expect(result.answer).not.toContain("scce.invention_construct");
  });

  it("keeps a source-inspired request creative while retaining only its factual premise evidence", async () => {
    const clock = createClock({ fixedTime: 9_500, stepMs: 1 });
    const hasher = createHasher();
    const premise = evidenceSpan({
      id: "evidence:creative-premise",
      sourceVersionId: "source:creative-premise:v1" as SourceVersionId,
      title: "Ada Lovelace",
      uri: "fixture://wiki/Ada_Lovelace",
      text: "Ada Lovelace wrote notes about Charles Babbage's Analytical Engine.",
      alpha: 0.94
    });
    const fixture = storageFixture({ evidence: [premise] });
    const kernel = createScceKernel({
      storage: fixture.storage,
      files: { streamPath: async function* () { /* unused */ } },
      buildTest: { executeProgram: async (): Promise<BuildTestResult> => ({ build: emptyCommandResult(), test: emptyCommandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
      idFactory: createIdFactory({ clock, hasher, deterministicReplay: true }),
      clock,
      deterministicReplay: true
    });

    const result = await kernel.turn({ text: "Invent a source-inspired graph index using Ada Lovelace's Analytical Engine notes", requestedAuthority: "creative" });

    expect(result.requestedAuthority).toBe("creative");
    expect(result.epistemicForce).toBe("invented");
    expect(result.assistantForce).toBe("creative_answer");
    expect(result.constructGraph.nodes.some(node => node.kind === "construct:invention")).toBe(true);
    expect(result.emissionGraph.evidenceIds).toEqual([premise.id]);
    expect(result.events.some(event => event.typeId === "InventionPlanned")).toBe(true);
  });

  it("uses a learned opaque frame to create an invention without an English command router", async () => {
    const clock = createClock({ fixedTime: 9_800, stepMs: 1 });
    const hasher = createHasher();
    const requestText = "Ω-17 amber lattice two exits review artifact";
    const semanticFrame: SemanticFrameRecord = {
      id: "frame.fixture.opaque.invention.17",
      frameJson: {
        surface: requestText,
        semanticRoleId: "role.fixture.requested_artifact.17",
        requirementCoefficients: {
          noveltyDemand: 4.2,
          inferentialDepth: 2.1,
          executableArtifactDemand: 1.2,
          formatConstraintStrength: 0.7
        }
      },
      embedding: [],
      evidenceIds: [],
      alpha: 0.98,
      createdAt: 1
    };
    const fixture = storageFixture({ evidence: [], semanticFrames: [semanticFrame] });
    const kernel = createScceKernel({
      storage: fixture.storage,
      files: { streamPath: async function* () { /* unused */ } },
      buildTest: { executeProgram: async (): Promise<BuildTestResult> => ({ build: emptyCommandResult(), test: emptyCommandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
      idFactory: createIdFactory({ clock, hasher, deterministicReplay: true }),
      clock,
      deterministicReplay: true
    });

    const result = await kernel.turn({ text: requestText });
    const requirements = result.requirementField as Record<string, unknown>;

    expect(result.requestedAuthority).toBe("creative");
    expect(requirements.activatedFrameIds).toContain(semanticFrame.id);
    expect(result.constructGraph.nodes.some(node => node.kind === "construct:invention")).toBe(true);
    expect(JSON.stringify(result.operatorActivations)).toContain("operator.cognition.invention.v1");
    expect(JSON.stringify(result.cognitiveProposals)).toContain('"basis":"invented"');
    expect(JSON.stringify(result.answerRevision)).toContain("scce.answer_revision.result.v1");
    expect(JSON.stringify(result.requestedAuthorityDecision)).toContain('"lexicalRouterUsed":false');

    const inspection = await kernel.inspect("last");
    const inspectionText = JSON.stringify(inspection.value);
    expect(inspectionText).toContain("scce.inspect.last_turn.v2");
    expect(inspectionText).toContain(semanticFrame.id);
    expect(inspectionText).toContain("operator.cognition.invention.v1");
    expect(inspectionText).toContain("CognitiveProposalsBuilt");
    expect(inspectionText).toContain("creative-candidate");
    expect(inspectionText).toContain("scce.answer_revision.result.v1");
    expect(inspectionText).toContain('"timing":{');
  });
});

describe("kernel evaluation conditions use production component boundaries", () => {
  const clockIso = "2026-07-12T00:00:00.000Z";

  it("executes the full path and removes graph execution rather than relabeling it", async () => {
    const full = await evaluationTurn("full");
    const noGraph = await evaluationTurn("no_graph");

    expect(verifyEvaluationTrace(full.condition, full.trace).valid).toBe(true);
    expect(verifyEvaluationTrace(noGraph.condition, noGraph.trace).valid).toBe(true);
    expect(full.fixture.metrics.graphReads).toBeGreaterThan(0);
    expect(noGraph.fixture.metrics.graphReads).toBe(0);
    expect(full.result.field.seeds.length).toBeGreaterThan(0);
    expect(noGraph.result.field.seeds).toEqual([]);
    expect(noGraph.trace.filter(event => event.event === "componentBypassed").map(event => event.component)).toEqual(expect.arrayContaining([
      "graph",
      "relation-potential",
      "query-diffusion",
      "powerwalk"
    ]));
  });

  it("bypasses PowerWalk at its run boundary and emits an empty deterministic result", async () => {
    const full = await evaluationTurn("full");
    const ablated = await evaluationTurn("no_powerwalk");
    const fullWalkEvent = full.result.events.find(event => event.typeId === "GraphUpdated" && JSON.stringify(event.payload).includes('"powerWalk"'));
    const ablatedWalkEvent = ablated.result.events.find(event => event.typeId === "GraphUpdated" && JSON.stringify(event.payload).includes('"powerWalk"'));

    expect(verifyEvaluationTrace(ablated.condition, ablated.trace).valid).toBe(true);
    expect(JSON.stringify(fullWalkEvent?.payload)).not.toContain('"walks":0');
    expect(JSON.stringify(ablatedWalkEvent?.payload)).toContain('"walks":0');
    expect(ablated.trace).toContainEqual(expect.objectContaining({ event: "componentBypassed", component: "powerwalk", boundary: "graph.resolve.powerwalk" }));
  });

  it("adds a structurally similar PPMI seed only when production PowerWalk executes", async () => {
    const full = await structuralPowerWalkTurn("full");
    const ablated = await structuralPowerWalkTurn("no_powerwalk");
    const structuralNodeId = "node:structural-twin";
    const fullPowerWalkEvent = full.result.events.find(event => event.typeId === "GraphUpdated" && JSON.stringify(event.payload).includes('"seedExpansion"'));
    const ablatedPowerWalkEvent = ablated.result.events.find(event => event.typeId === "GraphUpdated" && JSON.stringify(event.payload).includes('"seedExpansion"'));

    expect(
      full.result.field.seeds.some(seed => String(seed.nodeId) === structuralNodeId && seed.feature.startsWith("powerwalk:ppmi-cosine:")),
      JSON.stringify({ seeds: full.result.field.seeds, event: fullPowerWalkEvent?.payload })
    ).toBe(true);
    expect(ablated.result.field.seeds.some(seed => String(seed.nodeId) === structuralNodeId)).toBe(false);
    expect(JSON.stringify(fullPowerWalkEvent?.payload)).toContain('"method":"query_anchor_ppmi_cosine"');
    expect(JSON.stringify(fullPowerWalkEvent?.payload)).toContain('"expandedSeedCount":');
    expect(JSON.stringify(ablatedPowerWalkEvent?.payload)).toContain('"expandedSeedCount":0');
  });

  it("does not execute the support engines under no_support_engine", async () => {
    const full = await evaluationTurn("full");
    const ablated = await evaluationTurn("no_support_engine");

    expect(verifyEvaluationTrace(ablated.condition, ablated.trace).valid).toBe(true);
    expect(full.result.entailment.support).toBeGreaterThan(0);
    expect(ablated.result.entailment.support).toBe(0);
    expect(ablated.result.entailment.evidenceIds).toEqual([]);
    expect(ablated.result.entailment.boundaries).toContain("support-engine-disabled");
    expect(ablated.trace).toContainEqual(expect.objectContaining({ event: "componentBypassed", component: "support-engine", boundary: "proof.support-engine" }));
  });

  it("uses the deterministic realizer without learned Mouth or language-memory inspect refs", async () => {
    const ablated = await evaluationTurn("deterministic_mouth");
    const mouth = ablated.result.mouth as { trace?: { languageMemory?: { bypassed?: boolean } }; inspectRefs?: Array<{ kind?: string }> };

    expect(verifyEvaluationTrace(ablated.condition, ablated.trace).valid).toBe(true);
    expect(ablated.trace).toContainEqual(expect.objectContaining({ event: "componentBypassed", component: "learned-mouth", boundary: "mouth.realize" }));
    expect(mouth.trace?.languageMemory?.bypassed).toBe(true);
    expect(mouth.inspectRefs?.some(ref => ref.kind === "language-memory")).toBe(false);
  });

  it("finalizes honest branch-complete traces for early arithmetic turns", async () => {
    const full = await evaluationTurn("full", "2+2?");
    const noGraph = await evaluationTurn("no_graph", "2+2?");

    expect(verifyEvaluationTrace(full.condition, full.trace).valid).toBe(true);
    expect(verifyEvaluationTrace(noGraph.condition, noGraph.trace).valid).toBe(true);
    expect(full.trace).toContainEqual(expect.objectContaining({ event: "componentBypassed", component: "graph", reason: "not-applicable" }));
    expect(noGraph.trace).toContainEqual(expect.objectContaining({ event: "componentBypassed", component: "graph", reason: "condition-disabled" }));
    expect(noGraph.fixture.metrics.graphReads).toBe(0);
  });

  it("produces verifier-valid traces for every declared condition", async () => {
    const conditions: EvaluationConditionId[] = [
      "full",
      "no_relation_potential",
      "no_query_diffusion",
      "no_powerwalk",
      "no_graph",
      "lexical_only",
      "no_support_engine",
      "deterministic_mouth",
      "no_language_memory",
      "no_incremental_learning",
      "no_shard_router"
    ];
    for (const conditionId of conditions) {
      const turn = await evaluationTurn(conditionId);
      expect(verifyEvaluationTrace(turn.condition, turn.trace), conditionId).toMatchObject({ valid: true, violations: [] });
      if (conditionId === "no_language_memory") expect(turn.fixture.metrics.languageMemoryReads).toBe(0);
    }
  });

  async function evaluationTurn(conditionId: EvaluationConditionId, text = "Who was Ada Lovelace?") {
    const clock = createClock({ fixedTime: 9000, stepMs: 1 });
    const hasher = createHasher();
    const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
    const ada = evidenceSpan({
      id: "evidence:ada-evaluation",
      sourceVersionId: "source:ada-evaluation:v1" as SourceVersionId,
      title: "Ada Lovelace",
      uri: "fixture://wiki/Ada_Lovelace",
      text: "Ada Lovelace was a mathematician who wrote notes about Charles Babbage's Analytical Engine.",
      alpha: 0.9
    });
    const fixture = storageFixture({ evidence: [ada] });
    const condition = createEvaluationCondition({
      conditionId,
      seed: "kernel-evaluation-test",
      clockIso,
      ...(conditionId === "no_shard_router" ? { scope: "performance-recovery" as const } : {})
    });
    const kernel = createScceKernel({
      storage: fixture.storage,
      files: { streamPath: async function* () { /* unused */ } },
      buildTest: { executeProgram: async (): Promise<BuildTestResult> => ({ build: emptyCommandResult(), test: emptyCommandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
      idFactory: ids,
      clock,
      deterministicReplay: true,
      evaluationCondition: condition,
      evaluationRunId: "kernel-evaluation-integration"
    });
    const result = await kernel.turn({ text, metadata: { questionId: `question-${conditionId}` } });
    const trace = result.evaluationTrace as unknown as EvaluationTraceEvent[];
    return { condition, fixture, result, trace };
  }

  async function structuralPowerWalkTurn(conditionId: "full" | "no_powerwalk") {
    const clock = createClock({ fixedTime: 10_000, stepMs: 1 });
    const hasher = createHasher();
    const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
    const evidence = evidenceSpan({
      id: "evidence:quartz-actuator",
      sourceVersionId: "source:quartz-actuator:v1" as SourceVersionId,
      title: "Quartz Actuator",
      uri: "fixture://manual/quartz-actuator",
      text: "The quartz actuator uses a paired regulator topology for stable control.",
      alpha: 0.94
    });
    const graph = structuralPowerWalkGraph(evidence);
    const fixture = storageFixture({ evidence: [evidence], graph });
    const condition = createEvaluationCondition({
      conditionId,
      seed: "kernel-powerwalk-structural-test",
      clockIso
    });
    const kernel = createScceKernel({
      storage: fixture.storage,
      files: { streamPath: async function* () { /* unused */ } },
      buildTest: { executeProgram: async (): Promise<BuildTestResult> => ({ build: emptyCommandResult(), test: emptyCommandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
      idFactory: ids,
      clock,
      deterministicReplay: true,
      evaluationCondition: condition,
      evaluationRunId: "kernel-powerwalk-structural-integration"
    });
    const result = await kernel.turn({ text: "What is the Quartz Actuator?", metadata: { questionId: `powerwalk-${conditionId}` } });
    return { result, fixture };
  }
});

function evidenceSpan(input: { id: string; sourceVersionId: SourceVersionId; title: string; uri: string; text: string; alpha: number }): EvidenceSpan {
  const contentHash = `hash:${input.id}` as ContentHash;
  return {
    id: input.id as EvidenceId,
    sourceId: `source:${input.id}` as SourceId,
    sourceVersionId: input.sourceVersionId,
    chunkId: `chunk:${input.id}` as EvidenceSpan["chunkId"],
    contentHash,
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: input.text.length,
    charStart: 0,
    charEnd: input.text.length,
    text: input.text,
    textPreview: input.text,
    languageHints: { language: "fixture" },
    scriptHints: { script: "Latn" },
    trustVector: { trust: 0.94, sourceTrust: 0.94, structuralConfidence: 0.94, forceClass: "direct_evidence" },
    provenance: { namespace: "local", source: "kernel-local-evidence-anchor-test", title: input.title, uri: input.uri, canonicalUri: input.uri },
    features: featureSet(input.text, 256),
    status: "promoted",
    alpha: input.alpha,
    observedAt: 1000
  };
}

function storageFixture(input: { evidence: EvidenceSpan[]; graph?: GraphSlice; semanticFrames?: SemanticFrameRecord[] }): { storage: ScceStorage; events: ScceEvent[]; metrics: { graphReads: number; languageMemoryReads: number } } {
  const events: ScceEvent[] = [];
  const metrics = { graphReads: 0, languageMemoryReads: 0 };
  const currentGraph = () => input.graph ?? graphSlice(input.evidence);
  const storage = {
    events: {
      append: async (event: ScceEvent) => { events.push(event); },
      appendBatch: async (rows: ScceEvent[]) => { events.push(...rows); },
      readEpisode: async () => events,
      readRange: async () => events,
      latestLedgerHash: async () => events.at(-1)?.hash ?? ""
    },
    conversation: {
      putTurn: async () => undefined,
      listTurns: async () => []
    },
    graph: {
      upsertNode: async () => undefined,
      upsertEdge: async () => undefined,
      upsertHyperedge: async () => undefined,
      getSlice: async () => { metrics.graphReads++; return currentGraph(); },
      getTemporalSlice: async () => ({ ...currentGraph(), temporalQuery: {} }),
      materializeAlphaGraph: async () => emptyAlphaTrace()
    },
    evidence: {
      putSourceVersion: async () => undefined,
      putEvidenceSpan: async (span: EvidenceSpan) => {
        if (!input.evidence.some(existing => String(existing.id) === String(span.id))) input.evidence.push(span);
      },
      promoteEvidence: async () => input.evidence.length,
      getEvidence: async (id: EvidenceId) => input.evidence.find(span => String(span.id) === String(id)) ?? null,
      getEvidenceBatch: async (ids: EvidenceId[]) => input.evidence.filter(span => ids.map(String).includes(String(span.id))),
      searchEvidence: async () => input.evidence.map(span => ({ span, score: span.alpha, reason: "fixture" })),
      sourceVersionsForEvidence: async () => []
    },
    quarantine: {
      put: async () => undefined,
      get: async () => null,
      listPending: async () => [],
      markDecision: async () => undefined
    },
    model: {
      readModel: async (): Promise<ModelState> => ({ languageProfiles: [], latentConcepts: [], learnedProgramPatterns: [], learningGoals: [], trainingSteps: 0 }),
      writeModel: async () => undefined,
      putLanguageProfile: async () => undefined,
      listLanguageProfiles: async () => []
    },
    languageMemory: {
      putNgramObservation: async () => undefined,
      putNgramObservationsBatch: async () => undefined,
      putNgramModel: async () => undefined,
      putLanguageUnit: async () => undefined,
      putLanguagePattern: async () => undefined,
      putSemanticFrame: async () => undefined,
      putTranslationAlignment: async () => undefined,
      listNgramModels: async () => { metrics.languageMemoryReads++; return []; },
      listNgramObservations: async () => { metrics.languageMemoryReads++; return []; },
      listLanguageUnits: async () => { metrics.languageMemoryReads++; return []; },
      listLanguagePatterns: async () => { metrics.languageMemoryReads++; return []; },
      listSemanticFrames: async () => { metrics.languageMemoryReads++; return input.semanticFrames ?? []; },
      listTranslationAlignments: async () => { metrics.languageMemoryReads++; return []; }
    },
    stats: async () => ({ tables: [
      { table: "graph_nodes", rows: currentGraph().nodes.length },
      { table: "graph_edges", rows: currentGraph().edges.length },
      { table: "evidence_spans", rows: input.evidence.length },
      { table: "source_versions", rows: input.evidence.length },
      { table: "semantic_proofs", rows: 0 }
    ] }),
    init: async () => undefined,
    migrate: async () => undefined,
    verify: async () => ({ ok: true, tables: [], errors: [] }),
    close: async () => undefined,
    blobs: unusedStore(),
    ingestion: unusedStore(),
    proofs: unusedStore(),
    constructs: unusedStore(),
    capabilities: unusedStore(),
    forecasts: {
      putState: async () => undefined,
      putForecast: async () => undefined,
      getSeries: async () => []
    },
    benchmarks: unusedStore(),
    brainImports: {
      active: async () => ({ activeImportRunIds: [] }),
      summarize: async () => ({
        activeImportRunIds: [],
        importedLanguagePriorCount: 0,
        importedGraphPriorCount: 0,
        importedDirectEvidenceCount: 0,
        profileExcerptEvidenceCount: 0,
        importedLearnedPriorCount: 0,
        importedProgramPriorCount: 0,
        unknownPriorCount: 0,
        runs: []
      })
    },
    corrections: {
      putRule: async () => undefined,
      listRules: async () => []
    },
    localization: unusedStore(),
    flowCache: unusedStore(),
    selfRewrite: unusedStore(),
    workspace: unusedStore()
  } as unknown as ScceStorage;
  return { storage, events, metrics };
}

function structuralPowerWalkGraph(evidence: EvidenceSpan): GraphSlice {
  const node = (id: string, surface: string): GraphSlice["nodes"][number] => ({
    id: id as GraphSlice["nodes"][number]["id"],
    typeId: "type:mechanism" as GraphSlice["nodes"][number]["typeId"],
    representation: { label: surface },
    alpha: 0.9,
    evidenceIds: [evidence.id],
    features: featureSet(surface, 256),
    createdAt: 1_000,
    updatedAt: 1_000,
    metadata: {}
  });
  const nodes = [
    node("node:query-anchor", "quartz actuator"),
    node("node:structural-twin", "concealed mirrored regulator"),
    node("node:shared-context-a", "shared control context alpha"),
    node("node:shared-context-b", "shared control context beta"),
    node("node:distractor-a", "unrelated hydraulic inlet"),
    node("node:distractor-b", "unrelated hydraulic outlet"),
    node("node:distractor-c", "unrelated thermal inlet"),
    node("node:distractor-d", "unrelated thermal outlet")
  ];
  const relationId = "relation:paired-topology" as GraphSlice["edges"][number]["relationId"];
  const edge = (id: string, source: string, target: string): GraphSlice["edges"][number] => ({
    id: id as GraphSlice["edges"][number]["id"],
    source: source as GraphSlice["edges"][number]["source"],
    target: target as GraphSlice["edges"][number]["target"],
    relationId,
    alpha: 1,
    weight: 1,
    temporalScope: { validFrom: 1_000 },
    evidenceIds: [evidence.id],
    createdAt: 1_000,
    updatedAt: 1_000,
    metadata: {}
  });
  const edges = [
    edge("edge:anchor-a", "node:query-anchor", "node:shared-context-a"),
    edge("edge:anchor-b", "node:query-anchor", "node:shared-context-b"),
    edge("edge:twin-a", "node:structural-twin", "node:shared-context-a"),
    edge("edge:twin-b", "node:structural-twin", "node:shared-context-b"),
    edge("edge:a-anchor", "node:shared-context-a", "node:query-anchor"),
    edge("edge:a-twin", "node:shared-context-a", "node:structural-twin"),
    edge("edge:b-anchor", "node:shared-context-b", "node:query-anchor"),
    edge("edge:b-twin", "node:shared-context-b", "node:structural-twin"),
    edge("edge:distractor-ab", "node:distractor-a", "node:distractor-b"),
    edge("edge:distractor-ba", "node:distractor-b", "node:distractor-a"),
    edge("edge:distractor-cd", "node:distractor-c", "node:distractor-d"),
    edge("edge:distractor-dc", "node:distractor-d", "node:distractor-c")
  ];
  return { bounded: true, query: {}, nodes, edges, hyperedges: [] };
}

function graphSlice(evidence: readonly EvidenceSpan[]): GraphSlice {
  return {
    bounded: true,
    query: {},
    nodes: evidence.map(span => ({
      id: `node:${span.id}` as GraphSlice["nodes"][number]["id"],
      typeId: "type:evidence" as GraphSlice["nodes"][number]["typeId"],
      representation: { label: span.textPreview },
      alpha: span.alpha,
      evidenceIds: [span.id],
      features: span.features,
      createdAt: span.observedAt,
      updatedAt: span.observedAt,
      metadata: {}
    })),
    edges: [],
    hyperedges: []
  };
}

function emptyAlphaTrace(): AlphaTrace {
  return {
    alpha: 0,
    thresholds: { virtual: 0, visible: 0, bonded: 0, structural: 0 },
    relations: [],
    adjacency: { nodes: [], values: [] },
    laplacian: { nodes: [], values: [] },
    normalizedLaplacian: { nodes: [], values: [] },
    surfaces: { pressure: 0, drift: 0, contradiction: 0, bond: 0, risk: 0, actionability: 0 },
    contradictionMass: 0,
    bondedLeakage: 0
  };
}

function emptyCommandResult() {
  return { code: 0, stdout: "", stderr: "", durationMs: 0 };
}

function unusedStore(): Record<string, (...args: never[]) => Promise<JsonValue>> {
  return new Proxy({}, {
    get: () => async () => null
  }) as Record<string, (...args: never[]) => Promise<JsonValue>>;
}
