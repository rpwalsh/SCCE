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
  type LanguagePatternRecord,
  type EvidenceSpan,
  type ScceKernel,
  type ScceStorage,
  type TurnResult
} from "../index.js";
import { deriveClosedClassWords } from "../closed-class-words.js";
import { CORPUS_ROLE_IDS, CORPUS_SOURCE_SYSTEM_IDS } from "../corpus-registry.js";
import { type LanguageIdentityRecord } from "../language-identity.js";
import { dialogueRequestActObservations } from "../dialogue-communicative-act-learning.js";
import { REQUEST_COMMUNICATIVE_ACT_SOURCE_SYSTEM, compileRequestCommunicativeActModel, requestCommunicativeActPatterns } from "../request-communicative-act.js";
import { induceConversationalActConstructionTrainingSets } from "../conversational-construction-induction.js";
import { compileLanguageConstructionPattern } from "../language-construction-memory.js";
import { compactKneserNeyForProfile, trainKneserNey } from "../kneser-ney.js";
import { canonicalStringify } from "../primitives.js";
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

const DIALOGUE_PROFILE_ID = "language_profile.dialogue.0";
const ACT_VARIANTS = [
  { feed: "pump", time: "sometime last week", valve: "checked the valve", change: "nothing else seemed to change", review: "looked at", reading: "seven hundred and forty" },
  { feed: "supply", time: "sometime this week", valve: "tested the valve", change: "the other readings stayed the same", review: "checked", reading: "six hundred and twenty" },
  { feed: "return", time: "after the restart", valve: "inspected the valve", change: "no other setting moved", review: "reviewed", reading: "eight hundred and thirty" },
  { feed: "outlet", time: "before the service", valve: "measured the valve", change: "the remaining conditions looked steady", review: "compared", reading: "five hundred and ten" }
];

/** Human-authored owner/assistant dialogue fixtures in four source versions, with replies tied to observed context. */
export const HUMAN_AUTHORED_ACT_TRANSCRIPTS = ACT_VARIANTS.map(variant => [
  `owner. the ${variant.feed} feed reads high`,
  `assistant. compare the ${variant.feed} feed reading with the prior baseline before adjusting the setting`,
  `owner. it started ${variant.time}`,
  `assistant. the report it started ${variant.time} gives a range; compare the dated log to identify the day`,
  `owner. we ${variant.valve} already`,
  `assistant. since you ${variant.valve} already, inspect the adjacent line before repeating the check`,
  `owner. ${variant.change}`,
  `assistant. the observation ${variant.change} helps set the comparison window; compare the first high reading with the operating log`,
  `owner. that is all we have ${variant.review} so far`,
  `assistant. compare all we have ${variant.review} so far with the service record to find missing context`,
  "owner. what value did the log record for the first reading",
  `assistant. the log recorded ${variant.reading} units for the first reading`
].join("\n"));

export const DECLARED_ACT_TRANSCRIPTS = HUMAN_AUTHORED_ACT_TRANSCRIPTS.map((transcript, documentIndex) => {
  const record = `log excerpt: the first reading was ${ACT_VARIANTS[documentIndex]!.reading} units`;
  const recordStart = [...transcript].length + 1;
  const text = `${transcript}\n${record}`;
  let offset = 0;
  const lines = transcript.split("\n");
  const turns = lines.map((line, index) => {
    const separator = line.indexOf(". ") + 2;
    const startCodePoint = offset + separator;
    offset += [...line].length + 1;
    return { index, speakerId: line.slice(0, separator - 2), surface: line.slice(separator), startCodePoint, endCodePoint: offset - 1,
      ...(index % 2 ? { replyToTurnIndex: index - 1, commitmentScope: index === lines.length - 1 ? "external" as const : "conversation" as const } : {}),
      ...(index === lines.length - 1 ? { supportingSourceRanges: [{ startCodePoint: recordStart, endCodePoint: recordStart + [...record].length, surface: record }] } : {}) };
  });
  return { schema: "scce.dialogue_transcript.v1" as const, text, turns };
});

const DIALOGUE_TRAINING_HASHER = createHasher();
export const DIALOGUE_ACT_CONSTRUCTION_EVIDENCE: EvidenceSpan[] = DECLARED_ACT_TRANSCRIPTS.map(({ text }, index) => {
  const charLength = [...text].length;
  return {
    id: `evidence.dialogue.source-version.${index}`,
    sourceId: `source.dialogue.source-version.${index}`,
    sourceVersionId: `source_version.dialogue.${index}`,
    chunkId: `chunk.dialogue.source-version.${index}`,
    contentHash: DIALOGUE_TRAINING_HASHER.digestHex(text),
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: Buffer.byteLength(text, "utf8"),
    charStart: 0,
    charEnd: charLength,
    text,
    textPreview: text,
    languageHints: { language: "en" },
    scriptHints: { script: "Latn" },
    status: "promoted",
    alpha: 1,
    observedAt: index + 1
  } as unknown as EvidenceSpan;
});

const REQUEST_ACT_PATTERNS = (() => {
  const report = dialogueRequestActObservations(DECLARED_ACT_TRANSCRIPTS);
  const model = compileRequestCommunicativeActModel(report.observations);
  return requestCommunicativeActPatterns(model, {
    profileId: DIALOGUE_PROFILE_ID,
    updatedAt: 1,
    makeId: representation => `request_act_fixture.${DIALOGUE_TRAINING_HASHER.digestHex(canonicalStringify(representation))}`
  });
})();

const DIALOGUE_ACT_CONSTRUCTION_PATTERNS = (() => {
  const documents = DIALOGUE_ACT_CONSTRUCTION_EVIDENCE.map((span, index) => ({
    sourceVersionId: String(span.sourceVersionId),
    profileId: DIALOGUE_PROFILE_ID,
    spans: [span],
    transcriptTurns: DECLARED_ACT_TRANSCRIPTS[index]!.turns
  }));
  const induction = induceConversationalActConstructionTrainingSets({ documents, hasher: DIALOGUE_TRAINING_HASHER });
  return induction.sets.flatMap(set => {
    const compiled = compileLanguageConstructionPattern({
      bindingId: set.bindingId,
      profileId: set.profileId,
      observations: set.observations,
      evidence: DIALOGUE_ACT_CONSTRUCTION_EVIDENCE,
      hasher: DIALOGUE_TRAINING_HASHER,
      updatedAt: 1
    });
    if (compiled.status !== "compiled") return [];
    return [{
      ...compiled.pattern,
      patternJson: {
        ...(compiled.pattern.patternJson as Record<string, JsonValue>),
        sourceSystem: "dialogue",
        sourceSystemId: CORPUS_SOURCE_SYSTEM_IDS.dialogue,
        corpusRole: CORPUS_ROLE_IDS.dialogue,
        provenanceClass: "learned_language_prior",
        forceClass: "learned_language_prior",
        authorship: "human_authored"
      } as unknown as JsonValue
    }];
  });
})();

const DIALOGUE_PROFILE_SIGNATURES = DIALOGUE_ACT_CONSTRUCTION_EVIDENCE.map((span, index) => {
  const trained = trainKneserNey(span.text, { order: 3 });
  const profileModel = compactKneserNeyForProfile(trained, span.text) as unknown as { topContinuation?: Array<[string, number]> };
  return {
    id: `language_profile.dialogue.${index}`,
    sourceVersionId: String(span.sourceVersionId),
    sourceSystem: CORPUS_SOURCE_SYSTEM_IDS.dialogue,
    sourceUri: `conversation://dialogue-turns/${span.sourceVersionId}`,
    scripts: [{ script: "Latn", mass: 1 }],
    direction: "ltr",
    topContinuation: profileModel.topContinuation ?? []
  };
});

export const DIALOGUE_CLOSED_CLASS: readonly string[] = [...deriveClosedClassWords({ models: [trainKneserNey(DIALOGUE_POPULATION, { order: 3 })] })];

/** Only the selected construction's exact source literals, excluding every slot realization. */
export function selectedConversationFormLiterals(trace: readonly TraceRow[]): Array<{ id: string; text: string }> {
  const selected = trace.find(row => row.stage === "mouth.conversational_act_binding.candidate")?.support;
  const pattern = DIALOGUE_ACT_CONSTRUCTION_PATTERNS.find(row => row.id === selected?.bundleId);
  const bundle = (pattern?.patternJson as Record<string, unknown> | undefined)?.bundle as import("../language-construction-memory.js").DurableLanguageConstructionBundle | undefined;
  const construction = bundle?.constructions.find(row => row.id === selected?.constructionId);
  return construction?.sequence.flatMap(part => part.kind === "literal"
    ? part.origins.map(origin => ({ id: origin.sourceExampleId, text: part.surface })) : []) ?? [];
}

export type TraceRow = { stage: string; counts?: Record<string, number>; support?: Record<string, unknown> };

/** A live session with no admitted documentary evidence at all. Every turn goes through the production runtime. */
export function conversationalSession(options?: { corpus?: string; learned?: { patterns: LanguagePatternRecord[]; evidence: EvidenceSpan[] } }) {
  const base = storageFixtureForEvaluation({ evidence: [], clockNow: () => 0 }).storage;
  const trained = trainKneserNey(options?.corpus ?? [DIALOGUE_POPULATION, ...HUMAN_AUTHORED_ACT_TRANSCRIPTS].join(" . "), { order: 3 });
  // The live record shape, measured 2026-09-15: all 11 persisted dialogue models carry a profileId and a corpusRole,
  // and all 7 profiles they name are the only rows in language_profiles with no language identity assigned.
  // provenanceClass added 2026-09-15 from the live rows (sourceSystem='dialogue' -> 'learned_language_prior'); without
  // it the fixture's model is invisible to the generation provenance report and no learned surface can be admitted.
  const modelRecord = {
    id: "ngram:dialogue:3",
    streamId: "stream.dialogue",
    languageHint: "dialogue",
    maxOrder: trained.order,
    discount: trained.discount,
    modelJson: {
      model: trained as unknown as JsonValue,
      sourceSystem: "dialogue",
      provenanceClass: "learned_language_prior",
      profileId: DIALOGUE_PROFILE_ID,
      corpusRole: CORPUS_ROLE_IDS.dialogue
    } as unknown as JsonValue,
    updatedAt: 1
  };
  let identityRecords: LanguageIdentityRecord[] = [];
  let profileLanguages: Array<{ profileId: string; languageId: string }> = [];
  const constructionEvidence = options?.learned?.evidence ?? DIALOGUE_ACT_CONSTRUCTION_EVIDENCE;
  const profileSignatures = [...DIALOGUE_PROFILE_SIGNATURES,
    ...[...new Set(options?.learned?.patterns.map(pattern => pattern.profileId) ?? [])].map(id => ({ ...DIALOGUE_PROFILE_SIGNATURES[0]!, id }))];
  const storage = {
    ...base,
    evidence: {
      ...base.evidence,
      getEvidence: async (id: string) => constructionEvidence.find(span => String(span.id) === String(id)) ?? null,
      getEvidenceBatch: async (ids: readonly string[]) => constructionEvidence.filter(span => ids.map(String).includes(String(span.id))),
      searchEvidence: async () => []
    },
    userModelClaims: { putClaim: async () => undefined, listClaims: async () => [] },
    taskResumption: { putSnapshot: async () => undefined, getLatestSnapshot: async () => null },
    documentGeneration: { putSession: async () => undefined, getSession: async () => null, compareAndPutSession: async () => ({ stored: true, currentUpdatedAt: null }) },
    languageMemory: {
      ...base.languageMemory,
      listNgramModels: async () => [modelRecord],
      listLanguagePatterns: async (query?: { sourceSystem?: string; profileIds?: string[] }) => {
        if (options?.learned) return options.learned.patterns.filter(pattern => {
          const row = pattern.patternJson as Record<string, JsonValue>;
          return query?.sourceSystem === REQUEST_COMMUNICATIVE_ACT_SOURCE_SYSTEM
            ? row.sourceSystem === REQUEST_COMMUNICATIVE_ACT_SOURCE_SYSTEM
            : row.sourceSystem === "dialogue";
        });
        if (query?.sourceSystem === REQUEST_COMMUNICATIVE_ACT_SOURCE_SYSTEM) return REQUEST_ACT_PATTERNS;
        if (query?.sourceSystem === "dialogue" || query?.profileIds?.includes(DIALOGUE_PROFILE_ID)) return DIALOGUE_ACT_CONSTRUCTION_PATTERNS;
        return [];
      },
      continuationPopulation: async () => ({ languageId: "language.dialogue", modelCount: 1, continuationCounts: trained.continuationCounts })
    },
    languageIdentities: {
      putIdentities: async (records: readonly LanguageIdentityRecord[]) => { identityRecords = [...records]; },
      listIdentities: async () => [...identityRecords],
      assignProfileLanguages: async (rows: readonly { profileId: string; languageId: string }[]) => { profileLanguages = [...rows]; },
      listProfileLanguages: async () => [...profileLanguages],
      listProfileSignatures: async ({ afterId = "", limit }: { afterId?: string; limit: number }) => profileSignatures.filter(row => row.id > afterId).slice(0, limit)
    }
  } as unknown as ScceStorage;
  const kernel = bootKernel(storage);
  const identityInitialization = kernel.languageIdentities();
  const sessionId = "session.conversational";
  const recentTurns: JsonValue[] = [];
  let index = 0;
  return {
    recentTurns,
    async turn(text: string): Promise<{ result: TurnResult; trace: TraceRow[] }> {
      await identityInitialization;
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
