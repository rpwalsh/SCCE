// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDiscourseObjectState,
  createClock,
  createHasher,
  createIdFactory,
  createScceKernel,
  featureSet,
  type BuildTestResult,
  type ContentHash,
  type EvidenceId,
  type EvidenceSpan,
  type JsonValue,
  type ScceKernel,
  type ScceStorage,
  type SourceId,
  type SourceVersionId,
  type TurnResult
} from "../index.js";
import { clearCorpusIdentitySignals, corpusIdentitySurface } from "../corpus-identity.js";
import { deriveClosedClassWords } from "../closed-class-words.js";
import { trainKneserNey } from "../kneser-ney.js";
import { storageFixtureForEvaluation } from "./evidence-promotion-evaluation-fixture.js";

afterEach(() => clearCorpusIdentitySignals());

const EINSTEIN_LEAD = "Albert Einstein was a German-born theoretical physicist who developed the theory of relativity.";
const EINSTEIN_NOBEL = "He was awarded the Nobel Prize in Physics in 1921 for his services to theoretical physics.";
const EINSTEIN_BIRTH = "Einstein was born in Ulm in the Kingdom of Wurttemberg in the German Empire in 1879.";

// The resident language this session speaks, as the turn hydrates it: a corpus the closed class is measured from.
const CORPUS = [
  EINSTEIN_LEAD,
  EINSTEIN_NOBEL,
  EINSTEIN_BIRTH,
  "The theory of relativity is one of the two pillars of modern physics.",
  "He moved to the United States in 1933 and worked at the Institute for Advanced Study.",
  "A physicist is a scientist who specializes in the field of physics.",
  "The Nobel Prize is an international award administered by the Nobel Foundation in Sweden.",
  "The work of many scientists confirmed the theory by observation.",
  "The group was formed in the city and the members were singers."
].join(" ");

type TraceRow = { stage: string; counts?: Record<string, number>; support?: Record<string, unknown> };

// Live 2026-09-13 chat probe: after an evidence-bearing turn, "fuck off", "thanks" and "no thats wrong" each came
// back with the previous answer. The carrier is the discourse binding suspending the turn's own source admission.
describe("a sparse chat turn after an evidence-bearing turn", () => {
  it("does not re-serve the carried evidence when the request brings content that evidence never carries", async () => {
    const session = chatSession();
    const first = await session.turn("who is albert einstein");
    expect(first.result.answer).toContain("theoretical physicist");

    for (const sparse of ["fuck off", "thanks", "no thats wrong"]) {
      const next = await session.turn(sparse);
      for (const carried of [EINSTEIN_LEAD, EINSTEIN_NOBEL, EINSTEIN_BIRTH]) {
        expect(next.result.answer, `${sparse} / ${carried.slice(0, 24)}`).not.toContain(carried.slice(0, 40));
      }
      expect(next.result.evidence.map(span => String(span.id)), sparse).toEqual([]);
      expect(next.trace.find(row => row.stage === "graph.resolve.discourse_carry_unshared"), sparse).toBeDefined();
      expect(next.trace.find(row => row.stage === "graph.resolve.pool_admission")?.counts?.admitted, sparse).toBe(0);
    }
  }, 120_000);

  it("still resolves an anaphoric follow-up through the discourse referent", async () => {
    const session = chatSession();
    await session.turn("who is albert einstein");
    const win = await session.turn("what did he win");
    // It names nobody and asks with learned scaffolding only, so the carry stands and the referent's source answers.
    expect(win.trace.some(row => row.stage === "graph.resolve.discourse_carry_unshared")).toBe(false);
    expect(win.trace.find(row => row.stage === "graph.resolve.pool_admission")?.counts?.admitted).toBeGreaterThan(0);
    expect(win.result.evidence.map(span => String(span.id))).not.toEqual([]);
    expect(win.result.evidence.every(span => String(span.id).startsWith("evidence:einstein"))).toBe(true);
  }, 120_000);

  it("keeps a follow-up whose relation the carried evidence does carry", async () => {
    const session = chatSession();
    await session.turn("who is albert einstein");
    const born = await session.turn("when was he born");
    // "born" is the request's own content unit and the carried article carries it, so the carry stands.
    expect(born.trace.some(row => row.stage === "graph.resolve.discourse_carry_unshared")).toBe(false);
    expect(born.result.evidence.map(span => String(span.id))).not.toEqual([]);
  }, 120_000);
});

function chatSession() {
  const evidence = [
    span("evidence:einstein", "Albert Einstein", EINSTEIN_LEAD, 0),
    span("evidence:einstein-nobel", "Albert Einstein", EINSTEIN_NOBEL, 400),
    span("evidence:einstein-birth", "Albert Einstein", EINSTEIN_BIRTH, 800),
    span("evidence:abba", "ABBA", "ABBA are a Swedish pop group formed in Stockholm in 1972 by Agnetha Faltskog and Bjorn Ulvaeus.", 0),
    span("evidence:everest", "Mount Everest", "Mount Everest is Earth's highest mountain above sea level in the Himalayas.", 0)
  ];
  const titles = [...new Set(evidence.map(row => corpusIdentitySurface(String((row.provenance as { title: string }).title))))];
  const base = storageFixtureForEvaluation({ evidence, clockNow: () => 0 }).storage;
  const trained = trainKneserNey(CORPUS, { order: 3 });
  const modelRecord = {
    id: "ngram:fixture:3",
    streamId: "stream.fixture",
    languageHint: "fixture",
    maxOrder: trained.order,
    discount: trained.discount,
    modelJson: { model: trained as unknown as JsonValue, sourceSystem: "fixture" } as unknown as JsonValue,
    updatedAt: 1
  };
  // The interaction corpus as the server hydrates it: learned request frames, whose words are request scaffolding.
  const requestPatterns = ["who is", "what did", "when was", "what is", "where was"].map((surface, index) => ({
    id: `pattern:request:${index}`,
    profileId: "profile.requests",
    patternKind: "discourse" as const,
    support: 0.9,
    entropy: 0.1,
    patternJson: {
      schema: "scce.request_requirement_pattern.v1",
      sourceVersionId: "source:requests:v1",
      surface,
      selectedAuthority: "factual"
    } as unknown as JsonValue,
    evidenceIds: [],
    updatedAt: 10
  }));
  const identityRecord = {
    schema: "scce.language_identity.v1",
    id: "language.fixture",
    script: "Latn",
    directions: [{ direction: "ltr", count: 1 }],
    closedClass: [...deriveClosedClassWords({ models: [trained] })].map(word => ({ word, documentShare: 1 })),
    families: [{ family: "fixture", count: 1 }],
    profileCount: 1,
    membershipCut: 0.1,
    createdAt: 1
  };
  const storage = {
    ...base,
    userModelClaims: { putClaim: async () => undefined, listClaims: async () => [] },
    taskResumption: { putSnapshot: async () => undefined, getLatestSnapshot: async () => null },
    documentGeneration: { putSession: async () => undefined, getSession: async () => null, compareAndPutSession: async () => ({ stored: true, currentUpdatedAt: null }) },
    languageMemory: {
      ...base.languageMemory,
      listNgramModels: async () => [modelRecord],
      listLanguagePatterns: async (query?: { sourceSystem?: string }) => query?.sourceSystem === "corrections" ? requestPatterns : [],
      continuationPopulation: async () => ({ languageId: "language.fixture", modelCount: 1, continuationCounts: trained.continuationCounts })
    },
    languageIdentities: {
      putIdentities: async () => undefined,
      listIdentities: async () => [identityRecord],
      assignProfileLanguages: async () => undefined,
      listProfileLanguages: async () => [],
      listProfileSignatures: async () => []
    },
    evidence: {
      ...base.evidence,
      sourceIdentityArbitration: async ({ text }: { text: string }) => ({
        identities: titles.filter(title => ` ${corpusIdentitySurface(text)} `.includes(` ${title} `)),
        spread: new Map<string, number>()
      })
    }
  } as unknown as ScceStorage;
  const kernel = bootKernel(storage);
  const recentTurns: JsonValue[] = [];
  let index = 0;
  return {
    async turn(text: string): Promise<{ result: TurnResult; trace: TraceRow[] }> {
      const discourse = buildDiscourseObjectState({ sessionId: "session.sparse-turn", currentText: text, recentTurns, now: 1 });
      const metadata: Record<string, JsonValue> = discourse
        ? {
          runtimeEvidenceIds: discourse.evidenceIds,
          discourse: { schema: "scce.discourse_runtime_state.v1", activeObject: discourse as unknown as JsonValue, queryConcatenationUsed: false }
        }
        : {};
      const out = await tracedTurn(kernel, text, metadata);
      recentTurns.push({ id: `turn-user-${index}`, turnIndex: index * 2, roleId: "user", text, evidenceIds: [], sourceVersionIds: [] });
      recentTurns.push({
        id: `turn-assistant-${index}`,
        turnIndex: index * 2 + 1,
        roleId: "assistant",
        text: out.result.answer,
        evidenceIds: out.result.evidence.map(row => String(row.id)),
        sourceVersionIds: []
      });
      index += 1;
      return out;
    }
  };
}

async function tracedTurn(kernel: ScceKernel, text: string, metadata: Record<string, JsonValue>): Promise<{ result: TurnResult; trace: TraceRow[] }> {
  const traceFile = join(mkdtempSync(join(tmpdir(), "scce-sparse-carry-")), "trace.jsonl");
  const globals = globalThis as { __sccTrace?: unknown };
  const previous = globals.__sccTrace;
  globals.__sccTrace = { traceId: "sparse-turn-carried-answer-test", file: traceFile };
  let result: TurnResult;
  try {
    result = await kernel.turn({ text, metadata });
  } finally {
    globals.__sccTrace = previous;
  }
  const trace = readFileSync(traceFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as TraceRow);
  return { result, trace };
}

function bootKernel(storage: ScceStorage): ScceKernel {
  const clock = createClock({ fixedTime: 21_000, stepMs: 1 });
  const hasher = createHasher();
  return createScceKernel({
    storage,
    files: { streamPath: async function* () { /* unused */ } },
    buildTest: { executeProgram: async (): Promise<BuildTestResult> => ({ build: emptyCommandResult(), test: emptyCommandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
    idFactory: createIdFactory({ clock, hasher, deterministicReplay: true }),
    clock,
    deterministicReplay: true
  });
}

function span(id: string, title: string, text: string, charStart: number): EvidenceSpan {
  const sourceVersionId = `source:${title}:v1` as SourceVersionId;
  return {
    id: id as EvidenceId,
    sourceId: `source:${title}` as SourceId,
    sourceVersionId,
    chunkId: `chunk:${id}` as EvidenceSpan["chunkId"],
    contentHash: `hash:${id}` as ContentHash,
    mediaType: "text/plain",
    byteStart: charStart,
    byteEnd: charStart + text.length,
    charStart,
    charEnd: charStart + text.length,
    text,
    textPreview: text,
    languageHints: { language: "fixture" },
    scriptHints: { script: "Latn" },
    trustVector: { trust: 0.94, sourceTrust: 0.94, structuralConfidence: 0.94, forceClass: "direct_evidence" },
    provenance: { namespace: "local", source: "sparse-turn-carried-answer-test", title, uri: `fixture://wiki/${title}`, canonicalUri: `fixture://wiki/${title}`, sourceVersionId, byteRange: [charStart, charStart + text.length], charRange: [charStart, charStart + text.length] },
    features: featureSet(text, 256),
    status: "promoted",
    alpha: 0.9,
    observedAt: 1000
  };
}

function emptyCommandResult() {
  return { code: 0, stdout: "", stderr: "", durationMs: 0 };
}
