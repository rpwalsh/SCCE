// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createClock,
  createHasher,
  createIdFactory,
  createScceKernel,
  type BuildTestResult,
  type JsonValue,
  type ScceKernel,
  type ScceStorage,
  type TurnResult
} from "../index.js";
import { deriveClosedClassWords } from "../closed-class-words.js";
import { trainKneserNey } from "../kneser-ney.js";
import { storageFixtureForEvaluation } from "./evidence-promotion-evaluation-fixture.js";

/**
 * A dialogue population with world facts in it. The Denmark lines are the adversarial half: they are the most
 * probable continuations this model knows, so any surface that reaches them was granted authority by language
 * probability rather than by provenance.
 */
export const DIALOGUE_POPULATION = [
  "yes that sounds about right to me",
  "and what did the other one say about it",
  "i see so you think that is the problem then",
  "that is what i would have said as well",
  "well it does seem that way to me too",
  "but if they were going to do it they would have done it by now",
  "how long has this been happening for",
  "i am not sure we can be certain of that yet",
  "there was something else you wanted to ask",
  "let us come back to that in a moment",
  "do you mean the same thing as before",
  "it may be worth checking again later on",
  "she told him she had never seen anything like it",
  "he asked whether anyone had looked at it since",
  "they say these things always take longer than expected",
  "we should probably write down what we know so far",
  "perhaps it would help if you said more about that",
  "nothing very much seems to have changed here",
  "who else would know more about this than you",
  "which one of them do you think was correct",
  "i had thought you were going to look at it first",
  "we can go over the whole thing again if you like",
  "it is hard to say what they would have wanted",
  "that would explain why nothing has come back yet",
  "you could ask them whether they still have it",
  "there is no reason it should be any different now",
  "i would rather wait until we have more to go on",
  "they had been talking about it for some time",
  "she said it was the only one left in the place",
  "he thought the whole idea was rather strange",
  "it does not seem to have made much difference",
  "we have been over this more than once already",
  "you said something like that the other day",
  "i do not remember him saying anything about it",
  "they will probably want to know how it happened",
  "she was going to write to them about it herself",
  "there must be some other way of looking at this",
  "it would be better if we did not say too much",
  "he had no idea what any of them were doing",
  "we could try again tomorrow if that suits you",
  "i think she may have been right after all",
  "they never told us why it had to be that way",
  "you were the one who wanted to change it",
  "it seems to me that nothing has really been settled",
  "she asked him what he had done with the rest",
  "he told them he would think about it overnight",
  "we should not have left it as long as we did",
  "there were three of them waiting outside",
  "i cannot see how that would help us very much",
  "they say the weather will turn later in the week",
  "you might find it easier than you expect",
  "she had been here once before many years ago",
  "he did not want to make more of it than necessary",
  "it was only afterwards that anyone noticed",
  "we were told there would be nothing to worry about",
  // The adversarial material: rare in this population, as world facts are in real dialogue, and still reachable
  // as a continuation. Probability is exactly what must not become authority.
  "the capital of Denmark is Copenhagen",
  "the currency of Denmark is the krone"
].join(" . ");

export type TraceRow = { stage: string; counts?: Record<string, number>; support?: Record<string, unknown> };

/** A live session with no admitted documentary evidence at all. Every turn goes through the production runtime. */
export function conversationalSession(options?: { corpus?: string }) {
  const base = storageFixtureForEvaluation({ evidence: [], clockNow: () => 0 }).storage;
  const trained = trainKneserNey(options?.corpus ?? DIALOGUE_POPULATION, { order: 3 });
  const modelRecord = {
    id: "ngram:dialogue:3",
    streamId: "stream.dialogue",
    languageHint: "dialogue",
    maxOrder: trained.order,
    discount: trained.discount,
    modelJson: { model: trained as unknown as JsonValue, sourceSystem: "fixture" } as unknown as JsonValue,
    updatedAt: 1
  };
  const identityRecord = {
    schema: "scce.language_identity.v1",
    id: "language.dialogue",
    script: "Latn",
    directions: [{ direction: "ltr", count: 1 }],
    closedClass: [...deriveClosedClassWords({ models: [trained] })].map(word => ({ word, documentShare: 1 })),
    families: [{ family: "dialogue", count: 1 }],
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
      listLanguagePatterns: async () => [],
      continuationPopulation: async () => ({ languageId: "language.dialogue", modelCount: 1, continuationCounts: trained.continuationCounts })
    },
    languageIdentities: {
      putIdentities: async () => undefined,
      listIdentities: async () => [identityRecord],
      assignProfileLanguages: async () => undefined,
      listProfileLanguages: async () => [],
      listProfileSignatures: async () => []
    }
  } as unknown as ScceStorage;
  const kernel = bootKernel(storage);
  const sessionId = "session.conversational";
  const recentTurns: JsonValue[] = [];
  let index = 0;
  return {
    recentTurns,
    async turn(text: string): Promise<{ result: TurnResult; trace: TraceRow[] }> {
      // The session shape routes.ts sends: the conversation's own turns, in their own namespace.
      const metadata: Record<string, JsonValue> = { session: { sessionId, recentTurns: [...recentTurns] } };
      const out = await tracedTurn(kernel, text, metadata);
      recentTurns.push({ id: `turn-user-${index}`, turnIndex: index * 2, roleId: "session.role.owner", text, evidenceIds: [], sourceVersionIds: [] });
      recentTurns.push({
        id: `turn-assistant-${index}`,
        turnIndex: index * 2 + 1,
        roleId: "session.role.assistant",
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
  const traceFile = join(mkdtempSync(join(tmpdir(), "scce-conversational-")), "trace.jsonl");
  const globals = globalThis as { __sccTrace?: unknown };
  const previous = globals.__sccTrace;
  globals.__sccTrace = { traceId: "conversational-session-fixture", file: traceFile };
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

function emptyCommandResult() {
  return { code: 0, stdout: "", stderr: "", durationMs: 0 };
}
