// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { acquireContextualQaConstructions, verifyContextualQaConstruction, contextualQaRequestMatches } from "../contextual-qa-acquisition.js";
import { createHasher } from "../primitives.js";
import { sourceConstructionRequestValueResolver } from "../source-construction-request-binding.js";
import type { EvidenceSpan } from "../types.js";
import type { TranscriptTurn } from "../dialogue-communicative-act-learning.js";
import { compileLanguageConstructionPattern, SOURCE_EXAMPLE_CONSTRUCTION_STORAGE } from "../language-construction-memory.js";
const hasher = createHasher();
function document(name: string, value: string, index: number, contextOverride?: string, requestOverride?: string) {
  const request = requestOverride ?? `⟡ ${name} ⊹?`, context = contextOverride ?? `${name} ꙮ ${value}.`, text = `${request}\n${value}\n${context}`;
  const digest = hasher.digestHex(text), sourceVersionId = `version.${digest}`, sourceId = `source.${index}`;
  const replyStart = [...request].length + 1, contextStart = replyStart + [...value].length + 1;
  const span = { id: `evidence.${digest}`, sourceId, sourceVersionId, contentHash: `sha256_${digest}`, text, charStart: 0, charEnd: [...text].length,
    status: "promoted", alpha: 1 } as unknown as EvidenceSpan;
  const turns: TranscriptTurn[] = [{ index: 0, speakerId: "user", sourceRecordId: `original.${index}`, surface: request, startCodePoint: 0, endCodePoint: [...request].length },
    { index: 1, speakerId: "assistant", sourceRecordId: `original.${index}`, surface: value, startCodePoint: replyStart, endCodePoint: replyStart + [...value].length,
      replyToTurnIndex: 0, commitmentScope: "external", supportingSourceRanges: [{ surface: context, startCodePoint: contextStart, endCodePoint: [...text].length }] }];
  return { sourceVersionId, profileId: `profile.${digest}`, spans: [span], transcriptTurns: turns };
}
const sources = () => [document("Aster", "17", 0), document("Beryl", "29", 1), document("Cobalt", "41", 2), document("Dahlia", "53", 3)];
it("learns an owner-bound contextual question and declarative relation without supplied graph roles", () => {
  const documents = sources(), learned = acquireContextualQaConstructions({ documents, authorship: "human_authored", hasher, updatedAt: 1 });
  expect(learned.families, JSON.stringify(learned.rejected)).toHaveLength(1);
  const pattern = learned.families[0]!.pattern, bundle = verifyContextualQaConstruction({ pattern, evidence: documents.flatMap(doc => doc.spans), hasher });
  expect(bundle).toBeDefined();
  const fresh = document("新港🧭", "907", 99), context = fresh.transcriptTurns[1]!.supportingSourceRanges![0]!;
  const current = { ...fresh.spans[0]!, text: context.surface, charStart: context.startCodePoint, charEnd: context.endCodePoint };
  const resolver = sourceConstructionRequestValueResolver({ bundles: [bundle!], graph: { nodes: [], hyperedges: [] } });
  expect(resolver.resolve(fresh.transcriptTurns[0]!.surface, [current])).toMatchObject({ value: "907", subject: "新港🧭", evidenceIds: [String(current.id)] });
  expect(resolver.resolve(`⟡ 新港🧭 ⊺?`, [current])).toBeUndefined();
  const metadata = pattern.patternJson as Record<string, unknown>;
  expect(contextualQaRequestMatches(metadata.contextualQaRequestForm as never, fresh.transcriptTurns[0]!.surface)).toBe(true);
});
it("leaves ambiguous shared copies literal while requiring unique ownership for every acquired role", () => {
  const documents = [["Aster", "17"], ["Beryl", "29"], ["Cobalt", "41"], ["Dahlia", "53"]]
    .map(([name, answer], index) => document(name!, answer!, index, `${name} ꙮ ${answer} a.`, `a ⟡ ${name} ⊹ a?`));
  const learned = acquireContextualQaConstructions({ documents, authorship: "human_authored", hasher, updatedAt: 1 });
  expect(learned.families, JSON.stringify(learned.rejected)).toHaveLength(1);
  const bundle = verifyContextualQaConstruction({ pattern: learned.families[0]!.pattern, evidence: documents.flatMap(row => row.spans), hasher });
  expect(bundle).toBeDefined();
  expect(bundle!.sourceExamples.flatMap(example => example.roles).every(role => role.surface !== "a")).toBe(true);
});
it("enforces finite acquired source-only roles on new direct source interpretation", () => {
  const documents = Array.from({ length: 8 }, (_, index) => document(`owner${index}`, String(101 + index), index,
    `owner${index} z\u00f4r ${index % 2 ? "\u00f6pa" : "n\u00fcva"} v\u00f6 ${101 + index}.`));
  const learned = acquireContextualQaConstructions({ documents, authorship: "human_authored", hasher, updatedAt: 1 });
  expect(learned.families, JSON.stringify(learned.rejected)).toHaveLength(1);
  const bundle = verifyContextualQaConstruction({ pattern: learned.families[0]!.pattern, evidence: documents.flatMap(row => row.spans), hasher });
  expect(bundle).toBeDefined();
  expect(bundle!.sourceExamples.flatMap(example => example.roles).some(role => role.graphBinding?.surfaceClass === "observed")).toBe(true);
  const resolver = sourceConstructionRequestValueResolver({ bundles: [bundle!], graph: { nodes: [], hyperedges: [] } });
  const fresh = document("\u65b0\u6e2f\ud83e\udded", "907", 99, "\u65b0\u6e2f\ud83e\udded z\u00f4r \u00f6pa v\u00f6 907.");
  const span = { ...fresh.spans[0]!, text: fresh.transcriptTurns[1]!.supportingSourceRanges![0]!.surface };
  expect(resolver.resolve(fresh.transcriptTurns[0]!.surface, [span])).toMatchObject({ value: "907" });
  expect(resolver.resolve(fresh.transcriptTurns[0]!.surface, [{ ...span, text: span.text.replace("\u00f6pa", "not") }])).toBeUndefined();
  expect(resolver.resolve(fresh.transcriptTurns[0]!.surface, [{ ...span, text: span.text.replace("z\u00f4r", "foreign") }])).toBeUndefined();
});
it("jointly identifies multiword current arguments and refuses ambiguous or incomplete joins", () => {
  const names = ["Aster harbour", "Beryl cove", "Cobalt strand", "Dahlia haven", "Ember quay", "Fennel inlet", "Garnet port", "Hazel bay"];
  const documents = names.map((name, index) => document(name, String(101 + index), index,
    `${name} ${index % 2 ? "ki" : "lo"} ${101 + index}.`, `q ${index % 2 ? "ki" : "lo"} ${name}?`));
  const learned = acquireContextualQaConstructions({ documents, authorship: "human_authored", hasher, updatedAt: 1 });
  expect(learned.families, JSON.stringify(learned.rejected)).toHaveLength(1);
  const bundle = verifyContextualQaConstruction({ pattern: learned.families[0]!.pattern, evidence: documents.flatMap(row => row.spans), hasher });
  expect(bundle).toBeDefined();
  const resolver = sourceConstructionRequestValueResolver({ bundles: [bundle!], graph: { nodes: [], hyperedges: [] } });
  const fresh = document("\u65b0\u6e2f\ud83e\udded harbour", "907", 99, "\u65b0\u6e2f\ud83e\udded harbour ki 907.", "q ki \u65b0\u6e2f\ud83e\udded harbour?");
  const current = { ...fresh.spans[0]!, text: fresh.transcriptTurns[1]!.supportingSourceRanges![0]!.surface };
  expect(resolver.inspect(fresh.transcriptTurns[0]!.surface, [current])).toMatchObject({ status: "bound", binding: { value: "907", subject: "\u65b0\u6e2f\ud83e\udded harbour ki" } });
  expect(resolver.resolve(fresh.transcriptTurns[0]!.surface, [{ ...current, text: current.text.replace("ki", "lo") }])).toBeUndefined();
  const ambiguous = { ...current, text: "a a a 907." };
  expect(resolver.inspect("q a a a?", [ambiguous]).status).toBe("ambiguous");
  expect(resolver.resolve("q a a a?", [ambiguous])).toBeUndefined();
  const bounded = sourceConstructionRequestValueResolver({ bundles: [bundle!], graph: { nodes: [], hyperedges: [] }, maxTransitions: 1 });
  expect(bounded.inspect(fresh.transcriptTurns[0]!.surface, [current])).toEqual({ status: "incomplete", visited: 1 });
  expect(bounded.resolve(fresh.transcriptTurns[0]!.surface, [current])).toBeUndefined();
});
it("retains ambiguous or non-independent observations unqualified", () => {
  const duplicated = sources().map(doc => ({ ...doc, transcriptTurns: doc.transcriptTurns.map(turn => ({ ...turn, sourceRecordId: "same.original" })) }));
  expect(acquireContextualQaConstructions({ documents: duplicated, authorship: "human_authored", hasher, updatedAt: 1 }).families).toEqual([]);
  const ambiguous = [document("Aster", "17", 0, "Aster ꙮ 17 and 17."), ...sources().slice(1)];
  const learned = acquireContextualQaConstructions({ documents: ambiguous, authorship: "human_authored", hasher, updatedAt: 1 });
  expect(learned.rejected.some(row => row.reason === "declared_answer_not_unique")).toBe(true);
});

it("rejects revoked, changed, foreign owners and a locally recompiled false relation", () => {
  const documents = sources(), evidence = documents.flatMap(doc => doc.spans);
  const pattern = acquireContextualQaConstructions({ documents, authorship: "human_authored", hasher, updatedAt: 1 }).families[0]!.pattern;
  const bundle = verifyContextualQaConstruction({ pattern, evidence, hasher })!;
  for (const altered of [evidence.slice(1), evidence.map(span => ({ ...span, status: "quarantined" as const })),
    evidence.map(span => ({ ...span, sourceVersionId: `foreign.${span.sourceVersionId}` as EvidenceSpan["sourceVersionId"] })),
    evidence.map(span => ({ ...span, sourceId: `foreign.${span.sourceId}` as EvidenceSpan["sourceId"] })),
    evidence.map(span => ({ ...span, contentHash: "sha256_changed" as EvidenceSpan["contentHash"] })),
    evidence.map(span => ({ ...span, text: span.text.replace("ꙮ", "⊺") }))]) {
    expect(verifyContextualQaConstruction({ pattern, evidence: altered, hasher })).toBeUndefined();
  }
  const forged = compileLanguageConstructionPattern({ bindingId: bundle.bindingId, profileId: pattern.profileId, evidence, hasher, updatedAt: 1,
    acquisitionStatus: "document_heldout_qualified", storageEncoding: SOURCE_EXAMPLE_CONSTRUCTION_STORAGE,
    observations: bundle.sourceExamples.map(example => ({ sourceVersionId: example.sourceVersionId, evidenceId: example.evidenceId,
      surfaceStartCodePoint: example.surfaceStartCodePoint, surfaceEndCodePoint: example.surfaceEndCodePoint,
      contextualQaSupervision: example.contextualQaSupervision,
      roles: example.roles.map(role => ({ ...role, graphBinding: { ...role.graphBinding!, relationId: "relation.forged" } })),
      nullRoles: example.nullRoles.map(role => ({ ...role, graphBinding: { ...role.graphBinding!, relationId: "relation.forged" } })) })) });
  expect(forged.status).toBe("compiled");
  if (forged.status !== "compiled") throw Error("required false-relation fixture");
  expect(verifyContextualQaConstruction({ pattern: { ...forged.pattern, patternJson: { ...(pattern.patternJson as Record<string, never>),
    ...(forged.pattern.patternJson as Record<string, never>) } }, evidence, hasher })).toBeUndefined();
});
