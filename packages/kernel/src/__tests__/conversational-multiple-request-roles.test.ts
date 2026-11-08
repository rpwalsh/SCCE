import { describe, expect, it } from "vitest";
import { createHasher } from "../primitives.js";
import { induceConversationalActConstructionTrainingSets } from "../conversational-construction-induction.js";
import { compileLanguageConstructionPattern } from "../language-construction-memory.js";
import { sourceAlignedConversationalFillers } from "../conversational-source-alignment.js";
import { conversationalSurfaceMeaningPlan, type ConversationalActBinding } from "../conversational-act-binding.js";
import { realizeLearnedSurface, type ConversationTurnSurface } from "../language-construction.js";
import { transcriptEvidence } from "./dialogue-transcript-corpus-fixture.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClock, createIdFactory, createLanguageMemoryRuntime, createMouth, createCorrectionMemory, createSemanticEntailmentEngine, featureSet } from "../index.js";
import type { ConstructGraph, FieldState, LanguageProfile } from "../types.js";
import { DIALOGUE_ACT_IDS } from "../dialogue-pragmatics.js";

const hasher = createHasher();
const forms = [
  { request: (a: string, b: string) => `òrba «${a}»; plèn «${b}».`, reply: (a: string, b: string) => `Àmbit: ${a}.\nSegüent: ${b}; recorda ${a}!` },
  { request: (a: string, b: string) => `жарк «${a}»; флём «${b}».`, reply: (a: string, b: string) => `Первое: ${a}.\nСледом: ${b}; снова ${a}!` }
];
function population(form = forms[0]!) {
  const values = [["nuvól α", "brísa β"], ["àlber γ", "roure δ"], ["núvol ε", "pedra ζ"]];
  const requests = values.map(([a, b]) => form.request(a!, b!));
  const replies = values.map(([a, b]) => form.reply(a!, b!));
  const fixture = transcriptEvidence(requests.map((request, index) => `${request}\n\n${replies[index]}`), hasher);
  fixture.documents.forEach((document, index) => {
    const request = requests[index]!, reply = replies[index]!, start = [...request].length + 2;
    document.profileId = "profile.opaque";
    document.transcriptTurns = [{ index: 0, speakerId: "a", startCodePoint: 0, endCodePoint: start - 2, surface: request },
      { index: 1, speakerId: "b", startCodePoint: start, endCodePoint: start + [...reply].length, surface: reply, replyToTurnIndex: 0, commitmentScope: "conversation" }];
  });
  const report = induceConversationalActConstructionTrainingSets({ documents: fixture.documents, hasher });
  const compiled = report.sets.map(set => ({ set, result: compileLanguageConstructionPattern({ ...set, evidence: fixture.evidence, hasher, updatedAt: 1 }) }));
  const entry = compiled.find(row => row.result.status === "compiled" && row.result.bundle.constructions.some(construction => construction.roleOccurrences.length === 3));
  expect(entry, JSON.stringify(report)).toBeDefined();
  if (!entry || entry.result.status !== "compiled") throw new Error("missing multi-role construction");
  const bundle = entry.result.bundle, construction = bundle.constructions.find(row => row.roleOccurrences.length === 3)!;
  return { bundle, construction, actId: entry.set.actId };
}
function turn(surface: string): ConversationTurnSurface { return { turnId: "live.turn", turnIndex: 0, surface }; }

describe("source-owned multiline conversational roles", () => {
  for (const [index, form] of forms.entries()) it(`induces and realizes complete multilingual form ${index}, preserving every repeated role and Unicode span`, () => {
    const { bundle, construction, actId } = population(form);
    const live = turn(form.request("kàntic 😀", "violeta\nλ"));
    const aligned = sourceAlignedConversationalFillers({ bundle, construction, turn: live });
    expect(aligned?.fillers).toHaveLength(3);
    expect(aligned!.fillers.map(row => row.surface).sort()).toEqual(["kàntic 😀", "kàntic 😀", "violeta\nλ"].sort());
    for (const filler of aligned!.fillers) expect([...live.surface].slice(filler.startCodePoint, filler.endCodePoint).join("")).toBe(filler.surface);
    const binding: ConversationalActBinding = { schema: "scce.conversational_act_binding.v1", id: "binding.live", actId, bindingId: bundle.bindingId,
      profileKey: construction.profileKey, conversationId: "live", turnId: live.turnId, turnIndex: live.turnIndex, fillers: aligned!.fillers };
    const { plan } = conversationalSurfaceMeaningPlan({ binding, hasher,
      roleIdForSlot: index => construction.roleOccurrences[index]!.roleId,
      occurrenceIdForSlot: index => construction.roleOccurrences[index]!.occurrenceId,
      formClassIdForSlot: index => bundle.formClasses.find(row => row.constructionId === construction.id && row.occurrenceId === construction.roleOccurrences[index]!.occurrenceId)?.id });
    const realized = realizeLearnedSurface({ plan, constructions: [construction], formClasses: bundle.formClasses, hasher, conversationTurns: [live] });
    expect(realized.status, JSON.stringify(realized)).toBe("realized");
    if (realized.status !== "realized") return;
    expect(realized.realization.text).toBe(form.reply("kàntic 😀", "violeta\nλ"));
    expect(realized.realization.trace.filter(row => row.kind === "slot").every(row => row.evidenceIds.length === 0)).toBe(true);
  });

  it("refuses missing/contradictory source anchors rather than taking arbitrary content from the turn", () => {
    const { bundle, construction } = population();
    for (const surface of ["òrba «nou».", "plèn «nou»; òrba «altre».", "òrba «nou»; canvi «altre»."])
      expect(sourceAlignedConversationalFillers({ bundle, construction, turn: turn(surface) })).toBeUndefined();
  });

  it("Mouth admits several exactly owned occurrences from one live turn and preserves the realized multiline form", async () => {
    const { bundle, construction, actId } = population();
    const live = turn(forms[0]!.request("kàntic", "violeta"));
    const clock = createClock({ fixedTime: 5000, stepMs: 1 }), ids = createIdFactory({ clock, hasher, deterministicReplay: true });
    const memory = createLanguageMemoryRuntime({ idFactory: ids, hasher });
    const state = memory.hydrateFromImportedBrain({ importRunId: "multiline", models: [], observations: [], units: [], patterns: [], semanticFrames: [] });
    const matrix = { nodes: [], values: [] };
    const field = { requestFeatures: featureSet(live.surface, 64), seeds: [], active: [], ppf: [], ppfDiagnostics: {}, causalMass: [],
      alphaTrace: { alpha: .7, thresholds: { virtual: .49, visible: .7, bonded: .84, structural: .51 }, relations: [], adjacency: matrix, laplacian: matrix, normalizedLaplacian: matrix,
        surfaces: { pressure: .2, drift: 0, contradiction: 0, bond: 0, risk: 0, actionability: .4 }, contradictionMass: 0, bondedLeakage: 0 } } as unknown as FieldState;
    const construct = { id: ids.constructId({ fixture: "multiline" }), episodeId: ids.episodeId(), forceVector: {},
      nodes: [{ id: "family:answer", kind: "construct:answer", label: "fixture.answer", metadata: {} }], edges: [], artifacts: [] } as unknown as ConstructGraph;
    const profile = { id: construction.profileKey, sourceVersionId: "source_version.transcript.0", scripts: [], symbolShapes: [], charNgrams: [], direction: "unknown", entropy: .2, createdAt: 0 } as unknown as LanguageProfile;
    const dir = mkdtempSync(join(tmpdir(), "conversation-multiline-")), traceFile = join(dir, "trace.jsonl");
    const globals = globalThis as { __sccTrace?: unknown }, prior = globals.__sccTrace;
    globals.__sccTrace = { traceId: "multiline", file: traceFile };
    try {
      await createMouth({ languageMemory: memory, correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }), hashText: text => hasher.digestHex(text), hasher }).speak({
        construct, field, languageProfile: profile, evidence: [], requestText: live.surface, conversationTurns: [live],
        entailment: createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({ text: live.surface, evidence: [], nodes: [], field, createdAt: clock.now() }),
        requestCommunicativeAct: { schema: "scce.request_communicative_act_classification.v1", status: "active", actId, matchedPatternIds: ["source.act"], logOddsOverNeutral: 1.4, classIds: [actId, DIALOGUE_ACT_IDS.neutral] },
        languageMemory: { ...state, importedConstructionBundles: [{ ...bundle, constructions: [construction] }] }
      });
      const trace = readFileSync(traceFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
      const row = trace.find(item => item.stage === "mouth.conversational_act_binding.candidate");
      expect(row?.counts?.rows, JSON.stringify(row)).toBe(1);
      expect(row.support.surface).toBe(forms[0]!.reply("kàntic", "violeta"));
    } finally { globals.__sccTrace = prior; rmSync(dir, { recursive: true, force: true }); }
  });

  it("refuses ambiguous ownership in the source antecedent and conflicting source bindings", () => {
    const { bundle, construction } = population();
    const ambiguous = { ...bundle, sourceExamples: bundle.sourceExamples.map(example => ({ ...example, antecedent: example.antecedent ? {
      ...example.antecedent, surface: `${example.antecedent.surface} ${example.roles[0]!.surface}` } : undefined })) };
    expect(sourceAlignedConversationalFillers({ bundle: ambiguous, construction, turn: turn(forms[0]!.request("nova", "segona")) })).toBeUndefined();
    expect(sourceAlignedConversationalFillers({ bundle, construction,
      turn: turn(forms[0]!.request("nova»; plèn «intermèdia", "segona")) })).toBeUndefined();
    const conflicting = { ...bundle, sourceExamples: bundle.sourceExamples.map((example, index) => {
      if (index) return example;
      const ids = [...new Set(example.roles.map(role => role.roleId))];
      const surfaces = ids.map(id => example.roles.find(role => role.roleId === id)!.surface);
      return { ...example, roles: example.roles.map(role => ({ ...role, surface: surfaces[1 - ids.indexOf(role.roleId)]! })) };
    }) };
    expect(sourceAlignedConversationalFillers({ bundle: conflicting, construction, turn: turn(forms[0]!.request("nova", "segona")) })).toBeUndefined();
  });
});
