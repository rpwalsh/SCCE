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
import { sourceOwnedAnswerhoodLanguage } from "./fixtures/source-owned-answerhood-language.js";
import { measureRequestCorpusSubject } from "../corpus-identity-runtime.js";
import { sourceOwnedDiscourseGrammar } from "./fixtures/source-owned-discourse-grammar.js";

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
    const session = await chatSession();
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

  it("searches the corpus after rejecting a carried subject that the new request does not name", async () => {
    const alice = span("evidence:alice", "Alice in Wonderland", "Alice's cat was Dinah.", 0);
    const session = await chatSession({ additionalEvidence: [alice],
      formExamples: "einstein r0. einstein's r0. newton r0. newton's r0. curie r0. curie's r0. alice r0. alice's r0." });
    const first = await session.turn("who is albert einstein");
    expect(first.result.answer).toContain("theoretical physicist");
    const next = await session.turn("what is alice's cat");
    expect(next.trace.some(row => row.stage === "graph.resolve.discourse_carry_unshared")).toBe(true);
    expect(next.trace.find(row => row.stage === "graph.resolve.discourse_retrieval")?.counts?.evidence).toBeGreaterThan(0);
    expect(next.result.evidence.map(row => row.id)).toContain(alice.id);
    expect(next.result.answer).toContain("Dinah");
    expect(next.result.answer).not.toContain("theoretical physicist");
  }, 120_000);

  it("still resolves an anaphoric follow-up through the discourse referent", async () => {
    const session = await chatSession();
    await session.turn("who is albert einstein");
    const win = await session.turn("what did he win");
    expect(win.trace.find(row => row.stage === "turn.lexical_semantics")?.counts?.grammaticalEntries).toBeGreaterThan(0);
    const read = session.lexicalReads.at(-1)!;
    expect(read.query.requireComplete).toBe(true);
    expect(Number.isSafeInteger(read.query.limit) && read.query.limit! > 0).toBe(true);
    expect(read.query.maxTotalJsonBytes).toBe(32 * 1024 * 1024);
    expect(read.evidenceIds.length).toBeGreaterThan(0);
    expect(read.evidenceBatches).toEqual([read.evidenceIds]);
    expect(read.ownerBatches).toEqual([read.evidenceIds]);
    expect(read.sourceIds).toEqual([session.grammarSourceVersionId]);
    // It names nobody and asks with learned scaffolding only, so the carry stands and the referent's source answers.
    expect(win.trace.some(row => row.stage === "graph.resolve.discourse_carry_unshared")).toBe(false);
    expect(win.trace.find(row => row.stage === "graph.resolve.pool_admission")?.counts?.admitted).toBeGreaterThan(0);
    expect(win.result.evidence.map(span => String(span.id))).not.toEqual([]);
    expect(win.result.evidence.every(span => String(span.id).startsWith("evidence:einstein"))).toBe(true);
  }, 120_000);

  it("executes only the complete question argument licensed by a genuine source annotation", async () => {
    const session = await chatSession({ questionGrammar: true });
    const result = await session.turn("What is 2 + 3?");
    expect(result.trace.find(row => row.stage === "turn.lexical_semantics")?.counts?.questionFrames).toBeGreaterThan(0);
    const expression = result.trace.find(row => row.stage === "turn.source_question_expression");
    expect(expression?.support?.expression).toBe("2 + 3");
    expect(expression?.counts?.sourcePatterns).toBeGreaterThan(0);
    expect(result.result.answer).toBe("2 + 3 = 5.");
    const trailing = await session.turn("What is 2 + 3? suffix");
    expect(trailing.trace.some(row => row.stage === "turn.source_question_expression")).toBe(false);
  }, 120_000);

  it("keeps new content authoritative when no language closed class has been measured", async () => {
    for (const text of ["请换个话题", "የተለየ ጥያቄ", "zuv krel"]) {
      const session = await chatSession({ unmeasuredClass: true });
      const first = await session.turn("who is albert einstein");
      expect(first.result.answer).toContain("theoretical physicist");
      expect(first.trace.find(row => row.stage === "turn.support_candidates")?.counts?.corpusFunctionSymbols).toBe(0);
      const next = await session.turn(text);
      expect(next.result.evidence).toEqual([]);
      expect(next.result.answer).not.toContain(EINSTEIN_LEAD);
      expect(next.trace.find(row => row.stage === "graph.resolve.discourse_carry_unshared")).toBeDefined();
    }
  }, 120_000);

  it("keeps a follow-up whose relation the carried evidence does carry", async () => {
    const session = await chatSession();
    await session.turn("who is albert einstein");
    const born = await session.turn("when was he born");
    // "born" is the request's own content unit and the carried article carries it, so the carry stands.
    expect(born.trace.some(row => row.stage === "graph.resolve.discourse_carry_unshared")).toBe(false);
    expect(born.result.evidence.map(span => String(span.id))).not.toEqual([]);
  }, 120_000);
});

async function chatSession(options: { questionGrammar?: boolean; unmeasuredClass?: boolean; additionalEvidence?: EvidenceSpan[]; formExamples?: string } = {}) {
  const teaching = options.unmeasuredClass ? undefined : sourceOwnedAnswerhoodLanguage(options.formExamples);
  const grammar = await sourceOwnedDiscourseGrammar(options.questionGrammar);
  const lexicalReads: Array<{ query: NonNullable<Parameters<ScceStorage["languageMemory"]["listLanguagePatterns"]>[0]>;
    evidenceIds: EvidenceId[]; evidenceBatches: EvidenceId[][]; ownerBatches: EvidenceId[][]; sourceIds: SourceVersionId[] }> = [];
  const recordLexicalBatch = (ids: EvidenceId[], port: "evidenceBatches" | "ownerBatches") => {
    if (grammar.evidence.some(span => ids.includes(span.id))) lexicalReads.at(-1)?.[port].push([...ids]);
  };
  const evidence = [
    span("evidence:einstein", "Albert Einstein", EINSTEIN_LEAD, 0),
    span("evidence:einstein-nobel", "Albert Einstein", EINSTEIN_NOBEL, 400),
    span("evidence:einstein-birth", "Albert Einstein", EINSTEIN_BIRTH, 800),
    span("evidence:abba", "ABBA", "ABBA are a Swedish pop group formed in Stockholm in 1972 by Agnetha Faltskog and Bjorn Ulvaeus.", 0),
    span("evidence:everest", "Mount Everest", "Mount Everest is Earth's highest mountain above sea level in the Himalayas.", 0),
    ...(options.additionalEvidence ?? [])
  ];
  // Searchable sources can precede their admission to the resident identity catalog.
  const newIds = new Set(options.additionalEvidence?.map(row => row.id) ?? []);
  const titles = [...new Set(evidence.filter(row => !newIds.has(row.id))
    .map(row => corpusIdentitySurface(String((row.provenance as { title: string }).title))))];
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
    schema: "scce.language_identity.v2",
    id: "language.fixture",
    script: "Latn",
    directions: [{ direction: "ltr", count: 1 }],
    closedClass: teaching ? [...teaching.closedClass].map(word => ({ word, documentShare: 1 })) : [],
    families: [{ family: teaching ? "gutenberg" : "fixture", count: 1 }],
    corpusRoles: [],
    profileCount: 1,
    membershipCut: 0.1,
    createdAt: 1
  };
  const storage = {
    ...base,
    model: teaching ? { ...base.model, listLanguageProfiles: teaching.readProfiles } : base.model,
    userModelClaims: { putClaim: async () => undefined, listClaims: async () => [] },
    taskResumption: { putSnapshot: async () => undefined, getLatestSnapshot: async () => null },
    documentGeneration: { putSession: async () => undefined, getSession: async () => null, compareAndPutSession: async () => ({ stored: true, currentUpdatedAt: null }) },
    languageMemory: {
      ...base.languageMemory,
      listNgramModels: teaching?.readModels ?? (async () => [modelRecord]),
      listLanguagePatterns: async (query: Parameters<ScceStorage["languageMemory"]["listLanguagePatterns"]>[0]) => {
        const ordinary = teaching ? await teaching.readPatterns(query) : query?.sourceSystem === "corrections" ? requestPatterns : [];
        const lexical = query?.languageId === "language.fixture" && query.lexicalUnits?.length
          ? grammar.patterns.filter(row => query.patternSchemas?.includes((row.patternJson as { schema: string }).schema)
            && (row.patternJson as { lexicalUnits: string[] }).lexicalUnits.some(unit => query.lexicalUnits!.includes(unit))) : [];
        if (query?.lexicalUnits !== undefined) lexicalReads.push({ query,
          evidenceIds: [...new Set(lexical.flatMap(pattern => pattern.evidenceIds))], evidenceBatches: [], ownerBatches: [], sourceIds: [] });
        return [...ordinary, ...lexical];
      },
      continuationPopulation: async () => ({ languageId: "language.fixture", modelCount: teaching?.state.models.length ?? 1,
        continuationCounts: teaching?.state.models[0]?.continuationCounts ?? trained.continuationCounts })
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
      getEvidenceBatch: async (ids: EvidenceId[]) => {
        recordLexicalBatch(ids, "evidenceBatches");
        return [...await base.evidence.getEvidenceBatch(ids), ...(teaching?.evidence ?? []).filter(span => ids.includes(span.id)),
          ...grammar.evidence.filter(span => ids.includes(span.id))];
      },
      sourceVersionsForEvidence: async (ids: EvidenceId[]) => {
        recordLexicalBatch(ids, "ownerBatches");
        return [...await base.evidence.sourceVersionsForEvidence(ids),
          ...(grammar.evidence.some(span => ids.includes(span.id)) ? [grammar.annotationSource] : [])];
      },
      sourceVersionById: async (id: SourceVersionId) => {
        if (id === grammar.source.sourceVersionId || id === grammar.annotationSource.sourceVersionId) lexicalReads.at(-1)?.sourceIds.push(id);
        return id === grammar.source.sourceVersionId ? grammar.source
          : id === grammar.annotationSource.sourceVersionId ? grammar.annotationSource : await base.evidence.sourceVersionById?.(id) ?? null;
      },
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
    lexicalReads, grammarSourceVersionId: grammar.source.sourceVersionId,
    async turn(text: string): Promise<{ result: TurnResult; trace: TraceRow[] }> {
      const requestSubject = await measureRequestCorpusSubject({ requestText: text, evidence: storage.evidence });
      const discourse = buildDiscourseObjectState({ sessionId: "session.sparse-turn", currentText: text, recentTurns, requestSubject, now: 1 });
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
    informationAccess: { tenantId: "public", principalId: "fixture.sparse-turn", compartments: [], maximumExportClass: "public" },
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
