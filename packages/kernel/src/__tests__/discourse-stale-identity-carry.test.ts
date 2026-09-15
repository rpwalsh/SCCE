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
import { storageFixtureForEvaluation } from "./evidence-promotion-evaluation-fixture.js";

// Shaped like evidence_span.7c0120c3...e8509c986e2b, the reference-list chunk a live chat probe served for five different turns.
const REFERENCE_LIST = "-essential-influential-melancholy ABBA's Essential, Influential Melancholy]. NPR, 23 May 2015 * "
  + "[https://www.smithsonianmag.com/arts-culture/whats-behind-abbas-staying-power-180969709/ What's Behind ABBA's Staying Power?]. "
  + "Smithsonian, 3 August 2018 * [https://www.theguardian.com/music/2018/apr/27/abba-new-songs Abba to release new songs].";
const REFERENCE_LIST_TAIL = "]. Variety, 22 July 2018 * [https://www.npr.org/sections/therecord/2015/05/23/408865285/abba-essential ABBA Essential]. "
  + "The Guardian, 27 April 2018 * [https://www.billboard.com/music/abba-voyage-review Voyage review]. Billboard, 5 November 2021.";
const ABBA_LEAD = "ABBA are a Swedish pop group formed in Stockholm in 1972 by Agnetha Faltskog, Bjorn Ulvaeus, Benny Andersson and Anni-Frid Lyngstad.";
const EINSTEIN_LEAD = "Albert Einstein was a German-born theoretical physicist who developed the theory of relativity.";

afterEach(() => clearCorpusIdentitySignals());

describe("a server-built discourse object read before the turn measured what the request names", () => {
  it("does not carry the previous turn's evidence into a request naming a subject the corpus holds", async () => {
    const session = chatSession({ carrierEvidenceIds: ["evidence:abba-refs", "evidence:abba-refs-tail"], residentMissesEinstein: true });
    // The previous request primes the process-wide identity signal, exactly as the live server's previous turn did.
    await session.turn("whats up");
    const { result, trace } = await session.turn("who is albert einstein");

    expect(session.lastDiscourseObjectBuilt).toBe(true);
    expect(result.answer).not.toContain("Melancholy");
    expect(result.answer).not.toContain("https://");
    expect(result.evidence.map(span => String(span.id))).not.toContain("evidence:abba-refs");
    expect(trace.some(row => row.stage === "graph.resolve.discourse_bound")).toBe(false);
    expect(trace.find(row => row.stage === "graph.resolve.discourse_unbound")?.support?.requestIdentities).toEqual(["albert einstein"]);
  });

  it("answers the named subject from its own source once the stale object no longer pre-empts retrieval", async () => {
    const session = chatSession({ carrierEvidenceIds: ["evidence:abba-refs", "evidence:abba-refs-tail"], residentMissesEinstein: false });
    await session.turn("whats up");
    const { result } = await session.turn("who is albert einstein");

    expect(result.answer).toContain("theoretical physicist");
    expect(result.evidence.map(span => String(span.id))).toEqual(["evidence:einstein"]);
  });

  it("still binds a follow-up that names no corpus subject to the conversation's evidence", async () => {
    const session = chatSession({ carrierEvidenceIds: ["evidence:abba-lead"], residentMissesEinstein: true });
    await session.turn("whats up");
    const { result, trace } = await session.turn("when were they formed");

    expect(session.lastDiscourseObjectBuilt).toBe(true);
    expect(trace.some(row => row.stage === "graph.resolve.discourse_unbound")).toBe(false);
    expect(result.evidence.map(span => String(span.id))).toContain("evidence:abba-lead");
  });
});

type TraceRow = { stage: string; counts?: Record<string, number>; support?: Record<string, unknown> };

function chatSession(input: { carrierEvidenceIds: string[]; residentMissesEinstein: boolean }) {
  const evidence = [
    span("evidence:abba-refs", "ABBA", REFERENCE_LIST, 81_722),
    span("evidence:abba-refs-tail", "ABBA", REFERENCE_LIST_TAIL, 77_704),
    span("evidence:abba-lead", "ABBA", ABBA_LEAD, 0),
    span("evidence:einstein", "Albert Einstein", EINSTEIN_LEAD, 0)
  ];
  const titles = [...new Set(evidence.map(row => corpusIdentitySurface(String((row.provenance as { title: string }).title))))];
  const base = storageFixtureForEvaluation({ evidence, clockNow: () => 0 }).storage;
  const storage = {
    ...base,
    userModelClaims: { putClaim: async () => undefined, listClaims: async () => [] },
    taskResumption: { putSnapshot: async () => undefined, getLatestSnapshot: async () => null },
    documentGeneration: { putSession: async () => undefined, getSession: async () => null, compareAndPutSession: async () => ({ stored: true, currentUpdatedAt: null }) },
    evidence: {
      ...base.evidence,
      sourceIdentityArbitration: async ({ text }: { text: string }) => ({
        identities: titles.filter(title => ` ${corpusIdentitySurface(text)} `.includes(` ${title} `)),
        spread: new Map<string, number>()
      }),
      // The live resident slice held the previous subject's neighbourhood and no source titled with the new one.
      ...(input.residentMissesEinstein
        ? { searchEvidence: async () => evidence.filter(row => String(row.id) !== "evidence:einstein").map(row => ({ span: row, score: row.alpha, reason: "fixture" })) }
        : {})
    }
  } as unknown as ScceStorage;
  const kernel = bootKernel(storage);
  // The carrier turn as the server stores it: the assistant turn whose evidence the discourse object carries.
  const recentTurns: JsonValue[] = [
    { id: "turn-user-0", turnIndex: 0, roleId: "user", text: "tell me something", evidenceIds: [], sourceVersionIds: [] },
    { id: "turn-assistant-0", turnIndex: 1, roleId: "assistant", text: "carrier", evidenceIds: input.carrierEvidenceIds, sourceVersionIds: [] }
  ];
  const session = {
    lastDiscourseObjectBuilt: false,
    async turn(text: string): Promise<{ result: TurnResult; trace: TraceRow[] }> {
      // Built the way routes.ts builds it: before the kernel turn primes this request's corpus identity.
      const discourse = buildDiscourseObjectState({ sessionId: "session.chat-carry", currentText: text, recentTurns, now: 1 });
      session.lastDiscourseObjectBuilt = Boolean(discourse);
      const metadata: Record<string, JsonValue> = discourse
        ? {
          runtimeEvidenceIds: discourse.evidenceIds,
          discourse: { schema: "scce.discourse_runtime_state.v1", activeObject: discourse as unknown as JsonValue, queryConcatenationUsed: false }
        }
        : {};
      return tracedTurn(kernel, text, metadata);
    }
  };
  return session;
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

async function tracedTurn(kernel: ScceKernel, text: string, metadata: Record<string, JsonValue>): Promise<{ result: TurnResult; trace: TraceRow[] }> {
  const traceFile = join(mkdtempSync(join(tmpdir(), "scce-chat-carry-")), "trace.jsonl");
  const globals = globalThis as { __sccTrace?: unknown };
  const previousTrace = globals.__sccTrace;
  globals.__sccTrace = { traceId: "discourse-stale-identity-carry-test", file: traceFile };
  let result: TurnResult;
  try {
    result = await kernel.turn({ text, metadata });
  } finally {
    globals.__sccTrace = previousTrace;
  }
  const trace = readFileSync(traceFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as TraceRow);
  return { result, trace };
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
    provenance: { namespace: "local", source: "discourse-stale-identity-carry-test", title, uri: `fixture://wiki/${title}`, canonicalUri: `fixture://wiki/${title}`, sourceVersionId, byteRange: [charStart, charStart + text.length], charRange: [charStart, charStart + text.length] },
    features: featureSet(text, 256),
    status: "promoted",
    alpha: 0.9,
    observedAt: 1000
  };
}

function emptyCommandResult() {
  return { code: 0, stdout: "", stderr: "", durationMs: 0 };
}
