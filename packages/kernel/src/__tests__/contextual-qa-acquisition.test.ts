// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { acquireContextualQaConstructions, mergeContextualQaAcquisitionResults, boundedContextualQaPairSeedIndices, inspectContextualQaConstructionVerification, verifyContextualQaConstruction, contextualQaRequestMatches,
  inspectContextualQaLiteralAnswerAlignment } from "../contextual-qa-acquisition.js";
import { createHasher } from "../primitives.js";
import { sourceConstructionRequestValueResolver } from "../source-construction-request-binding.js";
import type { EvidenceSpan } from "../types.js";
import type { TranscriptTurn } from "../dialogue-communicative-act-learning.js";
import { compileLanguageConstructionPattern, SOURCE_EXAMPLE_CONSTRUCTION_STORAGE } from "../language-construction-memory.js";
import { canonicalNormalizationContract } from "../normalization-contract.js";
import { CONTEXTUAL_QA_ALIGNMENT_SEGMENTATION_RECIPE, CONTEXTUAL_QA_COMPILER_FINGERPRINT,
  CONTEXTUAL_QA_DERIVED_ALIGNMENT_METHOD } from "../source-owned-contextual-qa.js";
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
  return { sourceVersionId, profileId: `profile.${digest}`, languageIdentityId: "identity.fixture", languageIdentityDigest: hasher.digestHex(`assignment.${digest}`), spans: [span], transcriptTurns: turns };
}
const sources = () => [document("Aster", "17", 0), document("Beryl", "29", 1), document("Cobalt", "41", 2), document("Dahlia", "53", 3)];
it("enumerates bounded independent seed pairs exactly without a quadratic disqualification scan", () => {
  const rows = Array.from({ length: 96 }, (_, index) => ({ partition: `partition.${index % 7}`, pairId: `pair.${index % 13}`,
    reply: `reply.${index % 11}`, copies: Array.from({ length: index % 3 }, (_unused, slot) => ({ value: `copy.${slot}.${index % 5}` })) }));
  const expected: Array<readonly [number, number]> = [];
  for (let left = 0; left < rows.length; left++) for (let right = left + 1; right < rows.length; right++) {
    const a = rows[left]!, b = rows[right]!;
    if (a.partition !== b.partition && a.pairId !== b.pairId && a.reply !== b.reply && a.copies.length === b.copies.length
      && a.copies.some((copy, index) => copy.value !== b.copies[index]!.value)) expected.push([left, right]);
  }
  expect(boundedContextualQaPairSeedIndices(rows, Number.MAX_SAFE_INTEGER)).toEqual({ indices: expected, exceeded: false });
  const bounded = boundedContextualQaPairSeedIndices(rows, 32);
  expect(bounded).toMatchObject({ exceeded: true });
  expect(bounded.indices).toHaveLength(32);
  expect(bounded.indices.every(([left, right]) => expected.some(([a, b]) => a === left && b === right))).toBe(true);
  expect(Math.max(...bounded.indices.flatMap(([left, right]) => [left, right]))).toBeGreaterThan(80);
  const disqualified = Array.from({ length: 8_000 }, (_, index) => ({ partition: `partition.${index}`, pairId: `pair.${index}`,
    reply: "same", copies: [{ value: "same" }] }));
  expect(boundedContextualQaPairSeedIndices(disqualified, 4_096)).toEqual({ indices: [], exceeded: false });
});
it("merges five deterministic group shards to the single-process result", () => {
  const documents = sources(), input = { documents, authorship: "human_authored", hasher, updatedAt: 1 };
  const serial = acquireContextualQaConstructions(input);
  const parallel = mergeContextualQaAcquisitionResults(Array.from({ length: 5 }, (_, index) =>
    acquireContextualQaConstructions({ ...input, groupPartition: { index, count: 5 } })));
  expect(parallel.families).toEqual(serial.families);
  expect(parallel.pairs).toBe(serial.pairs);
  expect(parallel.rejected.map(row => `${row.bindingId}:${row.reason}`).sort())
    .toEqual(serial.rejected.map(row => `${row.bindingId}:${row.reason}`).sort());
  expect(() => acquireContextualQaConstructions({ ...input, groupPartition: { index: 5, count: 5 } }))
    .toThrow("invalid contextual QA group partition");
});
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
  expect(metadata.compilerFingerprint).toBe(CONTEXTUAL_QA_COMPILER_FINGERPRINT);
  expect(verifyContextualQaConstruction({ pattern: { ...pattern, patternJson: { ...metadata,
    compilerFingerprint: "kernel.dialogue_contextual_qa.compiler.v4" } }, evidence: documents.flatMap(doc => doc.spans), hasher })).toBeUndefined();
  expect(contextualQaRequestMatches(metadata.contextualQaRequestForm as never, fresh.transcriptTurns[0]!.surface)).toBe(true);
});

it("learns a relation independently of unrelated sentence surroundings and resolves it as a unique subspan", () => {
  const documents = [["Aster", "17"], ["Beryl", "29"], ["Cobalt", "41"], ["Dahlia", "53"]]
    .map(([name, answer], index) => document(name!, answer!, index,
      `unrelated-prefix-${index} ${name} ꙮ ${answer}, unrelated-suffix-${index}.`));
  const learned = acquireContextualQaConstructions({ documents, authorship: "human_authored", hasher, updatedAt: 1 });
  expect(learned.families, JSON.stringify(learned.rejected)).toHaveLength(1);
  const verification = inspectContextualQaConstructionVerification({ pattern: learned.families[0]!.pattern,
    evidence: documents.flatMap(row => row.spans), hasher });
  expect(verification.status, JSON.stringify(verification)).toBe("verified");
  const bundle = verification.status === "verified" ? verification.bundle : undefined;
  const fresh = document("新港🧭", "907", 99, "new outer material 新港🧭 ꙮ 907, trailing material.");
  const context = fresh.transcriptTurns[1]!.supportingSourceRanges![0]!;
  const evidence = { ...fresh.spans[0]!, text: context.surface, charStart: context.startCodePoint, charEnd: context.endCodePoint };
  const resolver = sourceConstructionRequestValueResolver({ bundles: [bundle!], graph: { nodes: [], hyperedges: [] } });
  const audit = resolver.inspect(fresh.transcriptTurns[0]!.surface, [evidence]);
  expect(audit.binding, JSON.stringify(audit)).toMatchObject({ value: "907" });
});
it("learns and resolves a relation whose answer precedes the request anchor", () => {
  const documents = [["Alpha Book", "Ada"], ["Beta Book", "Bob"], ["Gamma Book", "Cara"], ["Delta Book", "Dan"]]
    .map(([title, author], index) => document(title!, author!, index, `${author} wrote ${title}.`, `Who authored ${title}?`));
  const learned = acquireContextualQaConstructions({ documents, authorship: "human_authored", hasher, updatedAt: 1 });
  expect(learned.families, JSON.stringify(learned.rejected)).toHaveLength(1);
  const bundle = verifyContextualQaConstruction({ pattern: learned.families[0]!.pattern,
    evidence: documents.flatMap(row => row.spans), hasher });
  expect(bundle).toBeDefined();
  const fresh = document("Epsilon Book", "Eve", 99, "Eve wrote Epsilon Book.", "Who authored Epsilon Book?");
  const context = fresh.transcriptTurns[1]!.supportingSourceRanges![0]!;
  const evidence = { ...fresh.spans[0]!, text: context.surface, charStart: context.startCodePoint, charEnd: context.endCodePoint };
  const audit = sourceConstructionRequestValueResolver({ bundles: [bundle!], graph: { nodes: [], hyperedges: [] } })
    .inspect(fresh.transcriptTurns[0]!.surface, [evidence]);
  expect(audit.binding, JSON.stringify(audit)).toMatchObject({ value: "Eve", subject: "Epsilon Book", evidenceIds: [String(evidence.id)] });
});
it("learns a possessive author relation across independently varying modifiers before the title", () => {
  const rows = [
    ["Preventive Police", "Edwin Chadwick", "Edwin Chadwick's 1829 article Preventive Police argued for prevention."],
    ["Tirant lo Blanc", "Martorell", "Martorell's outstanding novel Tirant lo Blanc shows a transition."],
    ["Divine Comedy", "Dante Alighieri", "Dante Alighieri's celebrated Divine Comedy merged several traditions."],
    ["Principles of Classification", "George Gaylord Simpson", "George Gaylord Simpson's detailed Principles of Classification appeared in print."],
    ["Frankenstein", "Mary Shelley", "Mary Shelley's influential novel Frankenstein remains widely read."]
  ];
  const documents = rows.map(([title, author, context], index) => {
    const result = document(title!, author!, index, context!, `Who wrote ${title}?`);
    const range = result.transcriptTurns[1]!.supportingSourceRanges![0]!;
    range.answerRange = { startCodePoint: range.startCodePoint, endCodePoint: range.startCodePoint + [...author!].length };
    return result;
  });
  const learned = acquireContextualQaConstructions({ documents, authorship: "human_authored", hasher, updatedAt: 1 });
  expect(learned.families, JSON.stringify(learned.rejected)).toHaveLength(1);
  const verification = inspectContextualQaConstructionVerification({ pattern: learned.families[0]!.pattern,
    evidence: documents.flatMap(row => row.spans), hasher });
  expect(verification.status, JSON.stringify(verification)).toBe("verified");
  const bundle = verification.status === "verified" ? verification.bundle : undefined;
  const fresh = document("Epsilon Treatise", "Eve Rowan", 99,
    "Eve Rowan's newly catalogued Epsilon Treatise describes the result.", "Who wrote Epsilon Treatise?");
  const context = fresh.transcriptTurns[1]!.supportingSourceRanges![0]!;
  const evidence = { ...fresh.spans[0]!, text: context.surface, charStart: context.startCodePoint, charEnd: context.endCodePoint };
  expect(sourceConstructionRequestValueResolver({ bundles: [bundle!], graph: { nodes: [], hyperedges: [] } })
    .resolve(fresh.transcriptTurns[0]!.surface, [evidence])).toMatchObject({ value: "Eve Rowan", subject: "Epsilon Treatise" });
});
it("publishes independently observed source relations without pretending they passed transfer qualification", () => {
  const rows = [["Alpha Book", "Ada"], ["Beta Book", "Bob"], ["Gamma Book", "Cara Doe"]];
  const documents = rows.map(([title, author], index) => {
    const prefix = `${title} was created by `;
    const result = document(title!, author!, index, `${prefix}${author}.`, `Who wrote ${title}?`);
    const range = result.transcriptTurns[1]!.supportingSourceRanges![0]!;
    const answerStart = range.startCodePoint + [...prefix].length;
    range.answerRange = { startCodePoint: answerStart, endCodePoint: answerStart + [...author!].length };
    return result;
  });
  const learned = acquireContextualQaConstructions({ documents, authorship: "human_authored", hasher, updatedAt: 1 });
  expect(learned.families, JSON.stringify(learned.rejected)).toHaveLength(1);
  const metadata = learned.families[0]!.pattern.patternJson as Record<string, unknown>;
  expect((metadata.contextualQaQualification as { method: string }).method).toBe("independent_source_observed.v1");
  const verification = inspectContextualQaConstructionVerification({ pattern: learned.families[0]!.pattern,
    evidence: documents.flatMap(row => row.spans), hasher });
  expect(verification.status, JSON.stringify(verification)).toBe("verified");
  if (verification.status === "verified") expect(verification.bundle.acquisitionStatus).toBe("source_observed");
});
it("learns a possessive author relation across independently observed request decorations", () => {
  const rows = [
    ["Preventive Police", "Edwin Chadwick", "Who wrote Preventive Police?", "Edwin Chadwick's 1829 article, Preventive Police, argued for prevention."],
    ["Tirant lo Blanc", "Martorell", "Who wrote Tirant lo Blanc?", "Martorell's outstanding novel of chivalry Tirant lo Blanc shows a transition."],
    ["Divine Comedy", "Dante Alighieri", "Who wrote the Divine Comedy?", "Dante Alighieri's Divine Comedy, written in the early 14th century, merged several traditions."],
    ["Principles of Classification", "George Gaylord Simpson", "Who wrote the \"Principles of Classification?", "George Gaylord Simpson's \"Principles of Classification\" was the original source."],
    ["The Prince", "Niccolo Machiavelli", "Who wrote The Prince?", "Niccolo Machiavelli's The Prince, written between 1511 and 1512, became influential."],
    ["Aster Treatise", "Ava Rowan", "Who wrote Aster Treatise?", "Ava Rowan's newly catalogued Aster Treatise describes the result."],
    ["Beryl Manual", "Ben Vale", "Who wrote Beryl Manual?", "Ben Vale's Beryl Manual remains widely read."]
  ];
  const documents = rows.map(([title, author, request, context], index) => {
    const result = document(title!, author!, index, context!, request!);
    const range = result.transcriptTurns[1]!.supportingSourceRanges![0]!;
    range.answerRange = { startCodePoint: range.startCodePoint, endCodePoint: range.startCodePoint + [...author!].length };
    return result;
  });
  const learned = acquireContextualQaConstructions({ documents, authorship: "human_authored", hasher, updatedAt: 1 });
  expect(learned.families, JSON.stringify(learned.rejected)).toHaveLength(1);
  expect(verifyContextualQaConstruction({ pattern: learned.families[0]!.pattern,
    evidence: documents.flatMap(row => row.spans), hasher })).toBeDefined();
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
  expect(learned.families[0]!.applicability).toMatchObject({ fitBindings: 7, heldOutBindings: 1, outOfApplicability: 0 });
  expect(learned.rejected.some(row => row.reason === "family_strictly_subsumed")).toBe(true);
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
it("qualifies an open source role only after independent unseen variations replay", () => {
  const documents = Array.from({ length: 6 }, (_, index) => document(`owner${index}`, String(301 + index), index,
    `owner${index} z\u00f4r modifier${index} v\u00f6 ${301 + index}.`));
  const learned = acquireContextualQaConstructions({ documents, authorship: "human_authored", hasher, updatedAt: 1 });
  expect(learned.families, JSON.stringify(learned.rejected)).toHaveLength(1);
  const bundle = verifyContextualQaConstruction({ pattern: learned.families[0]!.pattern, evidence: documents.flatMap(row => row.spans), hasher });
  expect(bundle).toBeDefined();
  expect(bundle!.sourceExamples.flatMap(example => example.roles).some(role => role.graphBinding?.valueKind === "opaque.contextual_qa.source_only"
    && role.graphBinding.surfaceClass === undefined)).toBe(true);
  const resolver = sourceConstructionRequestValueResolver({ bundles: [bundle!], graph: { nodes: [], hyperedges: [] } });
  const fresh = document("\u65b0\u6e2f\ud83e\udded", "907", 99, "\u65b0\u6e2f\ud83e\udded z\u00f4r unseen-variant v\u00f6 907.");
  const span = { ...fresh.spans[0]!, text: fresh.transcriptTurns[1]!.supportingSourceRanges![0]!.surface };
  expect(resolver.resolve(fresh.transcriptTurns[0]!.surface, [span])).toMatchObject({ value: "907" });
  expect(resolver.resolve(fresh.transcriptTurns[0]!.surface, [{ ...span, text: span.text.replace("z\u00f4r", "bad") }])).toBeUndefined();
});
it("discovers a repeated finite relation despite an unrelated source skeleton", () => {
  const related = Array.from({ length: 8 }, (_, index) => document(`owner${index}`, String(201 + index), index,
    `owner${index} z\u00f4r ${index % 2 ? "\u00f6pa" : "n\u00fcva"} v\u00f6 ${201 + index}.`));
  const unrelated = document("outsider", "999", 99, "outsider qqq unrelated 999.");
  const documents = [...related, unrelated];
  const learned = acquireContextualQaConstructions({ documents, authorship: "human_authored", hasher, updatedAt: 1 });
  expect(learned.families, JSON.stringify(learned.rejected)).toHaveLength(1);
  expect(learned.families[0]!.applicability).toMatchObject({ outOfApplicability: 1 });
  const witnesses = ((learned.families[0]!.pattern.patternJson as Record<string, unknown>).contextualQaQualification as
    { witnesses: Array<{ sourceVersionId: string }> }).witnesses;
  expect(witnesses).toHaveLength(8);
  expect(witnesses.some(witness => witness.sourceVersionId === unrelated.sourceVersionId)).toBe(false);
  const reversed = acquireContextualQaConstructions({ documents: [...documents].reverse(), authorship: "human_authored", hasher, updatedAt: 1 });
  expect(reversed.families[0]!.pattern).toEqual(learned.families[0]!.pattern);
});
it("keeps a qualified relation when an outside witness is locally ambiguous", () => {
  const clean = [
    document("Aster", "17", 0),
    document("Beryl", "29", 1),
    document("Cobalt", "41", 2),
    document("Dahlia", "53", 3),
    document("Ember", "67", 4)
  ];
  const ambiguous = document("Fennel", "79", 5, "Fennel ꙮ 79 and Fennel ꙮ 79.");
  const learned = acquireContextualQaConstructions({ documents: [...clean, ambiguous], authorship: "human_authored", hasher, updatedAt: 1 });
  expect(learned.families, JSON.stringify(learned.rejected)).toHaveLength(1);
  const qualification = (learned.families[0]!.pattern.patternJson as Record<string, unknown>).contextualQaQualification as
    { witnesses: Array<{ sourceVersionId: string }> };
  expect(qualification.witnesses.some(witness => witness.sourceVersionId === ambiguous.sourceVersionId)).toBe(false);
  expect(inspectContextualQaConstructionVerification({ pattern: learned.families[0]!.pattern,
    evidence: clean.flatMap(row => row.spans), hasher }).status).toBe("verified");
});
it("uses an independently repeated request control to bound adjacent multiword roles", () => {
  const names = ["Aster harbour", "Beryl cove", "Cobalt strand", "Dahlia haven", "Ember quay", "Fennel inlet", "Garnet port", "Hazel bay"];
  const documents = names.map((name, index) => document(name, String(101 + index), index,
    `${name} ${index % 2 ? "ki" : "lo"} ${101 + index}.`, `q ${index % 2 ? "ki" : "lo"} ${name}?`));
  const learned = acquireContextualQaConstructions({ documents, authorship: "human_authored", hasher, updatedAt: 1 });
  const learnedForms = learned.families.map(family => ({ applicability: family.applicability,
    requestForm: (family.pattern.patternJson as Record<string, unknown>).contextualQaRequestForm }));
  expect(learnedForms).toHaveLength(2);
  expect(learnedForms.map(row => row.requestForm)).toEqual(expect.arrayContaining([
    ["q ki ", { slotIndex: 0 }, "?"], ["q lo ", { slotIndex: 0 }, "?"]
  ]));
  expect(learnedForms.every(row => row.applicability.fitBindings === 3 && row.applicability.heldOutBindings === 1
    && row.applicability.outOfApplicability === 0)).toBe(true);
  const reversed = acquireContextualQaConstructions({ documents: [...documents].reverse(), authorship: "human_authored", hasher, updatedAt: 1 });
  expect(reversed.families.map(family => family.pattern)).toEqual(learned.families.map(family => family.pattern));
});
it("retains ambiguous or non-independent observations unqualified", () => {
  const duplicated = sources().map(doc => ({ ...doc, transcriptTurns: doc.transcriptTurns.map(turn => ({ ...turn, sourceRecordId: "same.original" })) }));
  expect(acquireContextualQaConstructions({ documents: duplicated, authorship: "human_authored", hasher, updatedAt: 1 }).families).toEqual([]);
  const ambiguous = [document("Aster", "17", 0, "Aster ꙮ 17 and 17."), ...sources().slice(1)];
  const learned = acquireContextualQaConstructions({ documents: ambiguous, authorship: "human_authored", hasher, updatedAt: 1 });
  expect(learned.rejected.some(row => row.reason === "heldout_relation_recovery_failed"
    || row.reason === "source_generalization_unidentifiable"), JSON.stringify(learned.rejected)).toBe(true);
});

function framedDocument(name: string, answer: string, index: number, overrides: { request?: string; reply?: string; context?: string } = {}) {
  const request = overrides.request ?? `\u27e1 ${name} \u22b9?`, reply = overrides.reply ?? `\u2301 ${name} \u2301 ${answer}`, context = overrides.context ?? `${name} \u00a7 ${answer}.`;
  const text = `${request}\n${reply}\n${context}`, digest = hasher.digestHex(text), sourceVersionId = `version.${digest}`;
  const replyStart = [...request].length + 1, contextStart = replyStart + [...reply].length + 1;
  const span = { id: `evidence.${digest}`, sourceId: `source.${index}`, sourceVersionId, contentHash: `sha256_${digest}`, text,
    charStart: 0, charEnd: [...text].length, status: "promoted", alpha: 1 } as unknown as EvidenceSpan;
  const turns: TranscriptTurn[] = [
    { index: 0, speakerId: "user", sourceRecordId: `original.${index}`, surface: request, startCodePoint: 0, endCodePoint: [...request].length },
    { index: 1, speakerId: "assistant", sourceRecordId: `original.${index}`, surface: reply, startCodePoint: replyStart,
      endCodePoint: replyStart + [...reply].length, replyToTurnIndex: 0, commitmentScope: "external",
      supportingSourceRanges: [{ surface: context, startCodePoint: contextStart, endCodePoint: [...text].length }] }
  ];
  return { sourceVersionId, profileId: `profile.${digest}`, languageIdentityId: "identity.fixture", languageIdentityDigest: hasher.digestHex(`assignment.${digest}`), spans: [span], transcriptTurns: turns };
}

it("aligns a unique source answer inside a framed reply without copying request material", () => {
  const rows = [["Aster", "17"], ["Beryl", "29"], ["Cobalt", "41"], ["Dahlia", "53"]] as const;
  const documents = rows.map(([name, answer], index) => framedDocument(name, answer, index));
  for (const [index, row] of documents.entries()) {
    const reply = row.transcriptTurns[1]!;
    const inspected = inspectContextualQaLiteralAnswerAlignment({ request: row.transcriptTurns[0]!.surface, reply: reply.surface,
      ranges: reply.supportingSourceRanges! });
    expect(inspected.status).toBe("bound");
    if (inspected.status === "bound") expect(inspected.selected.answer).toBe(rows[index]![1]);
  }
  const learned = acquireContextualQaConstructions({ documents, authorship: "human_authored", hasher, updatedAt: 1 });
  expect(learned.families, JSON.stringify(learned.rejected)).toHaveLength(1);
  const bundle = verifyContextualQaConstruction({ pattern: learned.families[0]!.pattern, evidence: documents.flatMap(row => row.spans), hasher });
  expect(bundle).toBeDefined();
  const answerSurfaces = bundle!.sourceExamples.flatMap(example => example.roles)
    .filter(role => role.graphBinding?.valueKind === "opaque.contextual_qa.answer").map(role => role.surface);
  expect(answerSurfaces.length).toBeGreaterThanOrEqual(2);
  expect(answerSurfaces.every(answer => rows.some(row => row[1] === answer))).toBe(true);
  expect(answerSurfaces.every(answer => !rows.some(row => row[0] === answer))).toBe(true);
  const supervised = bundle!.sourceExamples.filter(example => example.contextualQaSupervision);
  expect(supervised.length).toBeGreaterThan(0);
  for (const example of supervised) {
    const supervision = example.contextualQaSupervision!, span = documents.flatMap(row => row.spans).find(row => String(row.id) === example.evidenceId)!;
    const fullReply = [...span.text].slice(supervision.replyStartCodePoint, supervision.replyEndCodePoint).join("");
    expect(fullReply.startsWith("\u2301 ")).toBe(true);
    expect(supervision.answerRange).toBeUndefined();
    expect(supervision.derivedAnswerAlignment).toMatchObject({ method: CONTEXTUAL_QA_DERIVED_ALIGNMENT_METHOD,
      segmentationRecipe: CONTEXTUAL_QA_ALIGNMENT_SEGMENTATION_RECIPE,
      normalizationContractId: canonicalNormalizationContract().id });
  }
  const forged = compileLanguageConstructionPattern({ bindingId: bundle!.bindingId, profileId: learned.families[0]!.pattern.profileId,
    evidence: documents.flatMap(row => row.spans), hasher, updatedAt: 1, acquisitionStatus: "document_heldout_qualified",
    storageEncoding: SOURCE_EXAMPLE_CONSTRUCTION_STORAGE, observations: bundle!.sourceExamples.map(example => {
      const supervision = example.contextualQaSupervision;
      if (!supervision) return { sourceVersionId: example.sourceVersionId, evidenceId: example.evidenceId,
        surfaceStartCodePoint: example.surfaceStartCodePoint, surfaceEndCodePoint: example.surfaceEndCodePoint,
        roles: example.roles, nullRoles: example.nullRoles };
      const span = documents.flatMap(row => row.spans).find(row => String(row.id) === example.evidenceId)!;
      const name = rows.find(row => example.surface.includes(row[0]))![0], replySurface = [...span.text]
        .slice(supervision.replyStartCodePoint, supervision.replyEndCodePoint).join(""), contextSurface = [...span.text]
        .slice(supervision.contextStartCodePoint, supervision.contextEndCodePoint).join("");
      const replyOffset = [...replySurface.slice(0, replySurface.indexOf(name))].length;
      const sourceOffset = [...contextSurface.slice(0, contextSurface.indexOf(name))].length;
      return { sourceVersionId: example.sourceVersionId, evidenceId: example.evidenceId,
        surfaceStartCodePoint: example.surfaceStartCodePoint, surfaceEndCodePoint: example.surfaceEndCodePoint,
        roles: example.roles, nullRoles: example.nullRoles, contextualQaSupervision: { ...supervision,
          derivedAnswerAlignment: { ...supervision.derivedAnswerAlignment!,
            replyAnswerStartCodePoint: supervision.replyStartCodePoint + replyOffset,
            replyAnswerEndCodePoint: supervision.replyStartCodePoint + replyOffset + [...name].length,
            sourceAnswerStartCodePoint: supervision.contextStartCodePoint + sourceOffset,
            sourceAnswerEndCodePoint: supervision.contextStartCodePoint + sourceOffset + [...name].length } } };
    }) });
  expect(forged.status).toBe("compiled");
  if (forged.status === "compiled") expect(verifyContextualQaConstruction({ pattern: { ...forged.pattern,
    patternJson: { ...(learned.families[0]!.pattern.patternJson as Record<string, never>),
      ...(forged.pattern.patternJson as Record<string, never>) } }, evidence: documents.flatMap(row => row.spans), hasher })).toBeUndefined();
  for (const mutate of [
    (derived: NonNullable<NonNullable<(typeof supervised)[number]["contextualQaSupervision"]>["derivedAnswerAlignment"]>) => ({ ...derived,
      method: "unique_literal_source_reply.v1" as never }),
    (derived: NonNullable<NonNullable<(typeof supervised)[number]["contextualQaSupervision"]>["derivedAnswerAlignment"]>) => ({ ...derived,
      segmentationRecipe: "host_default_intl.v0" as never }),
    (derived: NonNullable<NonNullable<(typeof supervised)[number]["contextualQaSupervision"]>["derivedAnswerAlignment"]>) => ({ ...derived,
      normalizationContractId: "normalization_contract.obsolete" })
  ]) {
    const obsolete = compileLanguageConstructionPattern({ bindingId: bundle!.bindingId, profileId: learned.families[0]!.pattern.profileId,
      evidence: documents.flatMap(row => row.spans), hasher, updatedAt: 1, acquisitionStatus: "document_heldout_qualified",
      storageEncoding: SOURCE_EXAMPLE_CONSTRUCTION_STORAGE, observations: bundle!.sourceExamples.map(example => ({
        sourceVersionId: example.sourceVersionId, evidenceId: example.evidenceId,
        surfaceStartCodePoint: example.surfaceStartCodePoint, surfaceEndCodePoint: example.surfaceEndCodePoint,
        roles: example.roles, nullRoles: example.nullRoles,
        ...(example.contextualQaSupervision ? { contextualQaSupervision: { ...example.contextualQaSupervision,
          ...(example.contextualQaSupervision.derivedAnswerAlignment
            ? { derivedAnswerAlignment: mutate(example.contextualQaSupervision.derivedAnswerAlignment) } : {}) } } : {})
      })) });
    expect(obsolete.status).toBe("rejected");
  }
});

it("abstains when distinct exact reply-source alignments tie", () => {
  const inspected = inspectContextualQaLiteralAnswerAlignment({ request: "\u27e1 \u4e3b\u984c \u22b9?", reply: "\u7532 / \u4e59",
    ranges: [{ surface: "\u4e3b\u984c \u00a7 \u7532 + \u4e59.", startCodePoint: 40, endCodePoint: 51 }] });
  expect(inspected.status).toBe("ambiguous");
  expect(inspected.candidates.map(candidate => candidate.answer).sort()).toEqual(["\u4e59", "\u7532"].sort());
});

it("does not select a longer candidate when another non-contained alignment exists", () => {
  const inspected = inspectContextualQaLiteralAnswerAlignment({ request: "\u27e1 scope \u22b9?", reply: "alpha beta / gamma",
    ranges: [{ surface: "alpha beta + gamma", startCodePoint: 0, endCodePoint: 18 }] });
  expect(inspected.status).toBe("ambiguous");
  expect(inspected.candidates.map(candidate => candidate.answer)).toEqual(["alpha beta", "gamma"]);
});

it("does not truncate a shared answer at a request-copied unit", () => {
  const inspected = inspectContextualQaLiteralAnswerAlignment({ request: "scope York?", reply: "New York",
    ranges: [{ surface: "New York", startCodePoint: 0, endCodePoint: 8 }] });
  expect(inspected).toMatchObject({ status: "absent", candidates: [] });
});

it("starts a source-supported answer immediately after request-copied material", () => {
  const inspected = inspectContextualQaLiteralAnswerAlignment({ request: "Who mapped Aster?", reply: "Aster was mapped by Nia Vale.",
    ranges: [{ surface: "Aster was mapped by Nia Vale, before the survey closed!", startCodePoint: 0, endCodePoint: 55 }] });
  expect(inspected.status).toBe("bound");
  if (inspected.status === "bound") expect(inspected.selected.answer).toBe("by Nia Vale");
});

it("recovers bounded answers in no-whitespace scripts", () => {
  const inspected = inspectContextualQaLiteralAnswerAlignment({ request: "\u5bf9\u8c61\u53eb\u4ec0\u4e48\uff1f", reply: "\u7b54\u6848\u662f\u661f\u6d77",
    ranges: [{ surface: "\u8bb0\u5f55\u4e2d\u5bf9\u8c61\u79f0\u4e3a\u661f\u6d77\u3002", startCodePoint: 7, endCodePoint: 17 }] });
  expect(inspected.status).toBe("bound");
  if (inspected.status === "bound") expect(inspected.selected.answer).toBe("\u661f\u6d77");
});

it("uses the pinned locale-independent replay contract and retains punctuation and code-only answer units", () => {
  expect(canonicalNormalizationContract()).toMatchObject({ localePolicy: "locale-independent", normalizationForm: "NFC" });
  for (const answer of ["::", "=>", "C++", "\u03bb::"]) {
    const inspected = inspectContextualQaLiteralAnswerAlignment({ request: "\u27e1 value \u22b9?", reply: `result ${answer}`,
      ranges: [{ surface: `field ${answer}`, startCodePoint: 0, endCodePoint: [...`field ${answer}`].length }] });
    expect(inspected.status, answer).toBe("bound");
    if (inspected.status === "bound") expect(inspected.selected.answer).toBe(answer);
  }
});

it("bounds repeated-unit alignment work", () => {
  const repeated = Array.from({ length: 128 }, () => "x").join(" ");
  const inspected = inspectContextualQaLiteralAnswerAlignment({ request: "?", reply: repeated,
    ranges: [{ surface: repeated, startCodePoint: 0, endCodePoint: [...repeated].length }], maxTransitions: 32 });
  expect(inspected).toMatchObject({ status: "incomplete", maxTransitions: 32 });
});

it("charges candidate maximality reduction to the same work budget", () => {
  const units = Array.from({ length: 96 }, (_, index) => `u${index}`);
  const inspected = inspectContextualQaLiteralAnswerAlignment({ request: "?", reply: units.join(" "),
    ranges: [{ surface: [...units].reverse().join(" "), startCodePoint: 0, endCodePoint: units.join(" ").length }],
    maxTransitions: 400 });
  expect(inspected).toMatchObject({ status: "incomplete", phase: "maximal_reduction", maxTransitions: 400 });
});

it("uses declared human answer ranges without licensing unannotated or malformed repeated text", () => {
  const documents = sources().map(doc => {
    const reply = doc.transcriptTurns[1]!, value = reply.surface;
    const repeated = document(doc.transcriptTurns[0]!.surface.split(" ")[1]!, value, Number(doc.spans[0]!.sourceId.split(".")[1]),
      `${doc.transcriptTurns[1]!.supportingSourceRanges![0]!.surface} \u25c7 ${value}.`);
    const range = repeated.transcriptTurns[1]!.supportingSourceRanges![0]!;
    return { ...repeated, transcriptTurns: repeated.transcriptTurns.map(turn => turn.index !== 1 ? turn : { ...turn,
      supportingSourceRanges: [{ ...range, answerRange: { startCodePoint: range.startCodePoint + [...range.surface.slice(0, range.surface.indexOf(value))].length,
        endCodePoint: range.startCodePoint + [...range.surface.slice(0, range.surface.indexOf(value))].length + [...value].length } }] }) };
  });
  const learned = acquireContextualQaConstructions({ documents, authorship: "human_authored", hasher, updatedAt: 1 });
  expect(learned.families, JSON.stringify(learned.rejected)).toHaveLength(1);
  const pattern = learned.families[0]!.pattern, evidence = documents.flatMap(doc => doc.spans);
  const verified = verifyContextualQaConstruction({ pattern, evidence, hasher });
  expect(verified).toBeDefined();
  const wrongAnnotation = compileLanguageConstructionPattern({ bindingId: verified!.bindingId, profileId: pattern.profileId, evidence, hasher, updatedAt: 1,
    acquisitionStatus: "document_heldout_qualified", storageEncoding: SOURCE_EXAMPLE_CONSTRUCTION_STORAGE,
    observations: verified!.sourceExamples.map(example => ({ sourceVersionId: example.sourceVersionId, evidenceId: example.evidenceId,
      surfaceStartCodePoint: example.surfaceStartCodePoint, surfaceEndCodePoint: example.surfaceEndCodePoint,
      roles: example.roles, nullRoles: example.nullRoles,
      ...(example.contextualQaSupervision ? { contextualQaSupervision: { ...example.contextualQaSupervision,
        answerRange: { startCodePoint: example.contextualQaSupervision.contextStartCodePoint, endCodePoint: example.contextualQaSupervision.contextStartCodePoint + 1 } } } : {}) })) });
  expect(wrongAnnotation.status).toBe("rejected");
  const unannotated = documents.map(doc => ({ ...doc, transcriptTurns: doc.transcriptTurns.map(turn => ({ ...turn,
    supportingSourceRanges: turn.supportingSourceRanges?.map(({ answerRange: _answer, ...range }) => range) })) }));
  const disambiguated = acquireContextualQaConstructions({ documents: unannotated, authorship: "human_authored", hasher, updatedAt: 1 });
  expect(disambiguated.families, JSON.stringify(disambiguated.rejected)).toHaveLength(1);
  expect(verifyContextualQaConstruction({ pattern: disambiguated.families[0]!.pattern, evidence, hasher })).toBeDefined();
  for (const mode of ["mismatch", "outside", "multiple"] as const) {
    const malformed = documents.map(doc => ({ ...doc, transcriptTurns: doc.transcriptTurns.map(turn => ({ ...turn,
      supportingSourceRanges: turn.supportingSourceRanges?.flatMap(range => mode === "multiple" ? [range, range] : [{ ...range,
        answerRange: mode === "outside" ? { startCodePoint: range.startCodePoint - 1, endCodePoint: range.startCodePoint + 1 }
          : { startCodePoint: range.startCodePoint, endCodePoint: range.startCodePoint + [...turn.surface].length } }]) })) }));
    const result = acquireContextualQaConstructions({ documents: malformed, authorship: "human_authored", hasher, updatedAt: 1 });
    expect(result.families).toEqual([]); expect(result.rejected.filter(row => row.reason === "declared_answer_range_invalid")).toHaveLength(4);
  }
  expect(verifyContextualQaConstruction({ pattern, evidence: evidence.map(span => ({ ...span, status: "quarantined" })), hasher })).toBeUndefined();
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

it("selects one of several multilingual full-reply runs only by the held-out typed relation", () => {
  const rows = [["Aster", "\u661f\u6d77"], ["Beryl", "\u6df1\u6797"], ["Cobalt", "\u96ea\u539f"], ["Dahlia", "\u7802\u4e18"]] as const;
  const documents = rows.map(([name, answer], index) => framedDocument(name, answer, index,
    { reply: `\u56de\u7b54: \u6052 / ${answer}`, context: `${name} \u00a7 \u6052 ${answer}.` }));
  for (const document of documents) expect(inspectContextualQaLiteralAnswerAlignment({ request: document.transcriptTurns[0]!.surface,
    reply: document.transcriptTurns[1]!.surface, ranges: document.transcriptTurns[1]!.supportingSourceRanges! }).status).toBe("ambiguous");
  const learned = acquireContextualQaConstructions({ documents, authorship: "human_authored", hasher, updatedAt: 1 });
  expect(learned.families, JSON.stringify(learned.rejected)).toHaveLength(1);
  const pattern = learned.families[0]!.pattern, evidence = documents.flatMap(document => document.spans);
  const verified = verifyContextualQaConstruction({ pattern, evidence, hasher });
  expect(verified).toBeDefined();
  for (const example of verified!.sourceExamples.filter(example => example.contextualQaSupervision)) {
    const supervision = example.contextualQaSupervision!, span = evidence.find(span => String(span.id) === example.evidenceId)!;
    expect([...span.text].slice(supervision.replyStartCodePoint, supervision.replyEndCodePoint).join("")).toMatch(/^\u56de\u7b54: \u6052 \/ /u);
    expect(supervision.answerRange).toBeUndefined();
  }
  const metadata = pattern.patternJson as Record<string, unknown>;
  expect(metadata.contextualQaOwnership).toMatchObject({ languageIdentityId: "identity.fixture", members: expect.any(Array) });
  expect(metadata.contextualQaQualification).toMatchObject({ method: "leave_one_source_family_out.v1", partitions: expect.any(Array), witnesses: expect.any(Array) });
  const reversed = acquireContextualQaConstructions({ documents: [...documents].reverse(), authorship: "human_authored", hasher, updatedAt: 1 });
  expect(reversed.families[0]!.pattern).toEqual(pattern);
});

it("abstains when both independently varying multilingual answer roles satisfy the same family", () => {
  const documents = [["Aster", "\u661f", "\u6d77"], ["Beryl", "\u96ea", "\u6797"], ["Cobalt", "\u6708", "\u7802"], ["Dahlia", "\u65e5", "\u5c71"]]
    .map(([name, left, right], index) => framedDocument(name!, left!, index,
      { reply: `${left} / ${right}`, context: `${name} \u00a7 ${left} + ${right}.` }));
  const learned = acquireContextualQaConstructions({ documents, authorship: "human_authored", hasher, updatedAt: 1 });
  expect(learned.families).toEqual([]);
});

it("rejects matching polar and supplied-value contrasts without English keyword rules", () => {
  const base = sources();
  for (const contrast of [
    framedDocument("Ember", "71", 8, { reply: "\u0646\u0639\u0645", context: "Ember \ua66e 71." }),
    framedDocument("Ember", "71", 8, { request: "\u27e1 Ember 71 \u22b9?", reply: "71", context: "Ember 71 \ua66e 71." })
  ]) {
    const learned = acquireContextualQaConstructions({ documents: [...base, contrast], authorship: "human_authored", hasher, updatedAt: 1 });
    expect(learned.families).toEqual([]);
    expect(learned.rejected.some(row => row.reason === "matching_closed_or_unresolved_contrast")).toBe(true);
  }
});

it("requires verified language identity and isolates labels and profile assignments", () => {
  const base = sources();
  expect(acquireContextualQaConstructions({ documents: base.map(({ languageIdentityId: _id, languageIdentityDigest: _digest, ...document }) => document),
    authorship: "human_authored", hasher, updatedAt: 1 }).rejected.every(row => row.reason === "verified_language_identity_required")).toBe(true);
  const splitIdentity = base.map((document, index) => ({ ...document, languageIdentityId: `identity.${index % 2}` }));
  expect(acquireContextualQaConstructions({ documents: splitIdentity, authorship: "human_authored", hasher, updatedAt: 1 }).families).toEqual([]);
  const splitLabels = base.map((document, index) => ({ ...document, spans: document.spans.map(span => ({ ...span,
    informationLabel: { tenantId: `tenant.${index % 2}`, principals: ["owner"], compartments: [], exportClass: "restricted" as const, mergePolicy: "isolated" as const } })) }));
  expect(acquireContextualQaConstructions({ documents: splitLabels, authorship: "human_authored", hasher, updatedAt: 1 }).families).toEqual([]);
  const conflict = base.map(document => ({ ...document, profileId: "one.profile" }));
  expect(acquireContextualQaConstructions({ documents: conflict, authorship: "human_authored", hasher, updatedAt: 1 }).rejected.every(row => row.reason === "conflicting_profile_identity_assignment")).toBe(true);
});

it("retains all bounded alternatives and abstains when the candidate bound is exceeded", () => {
  const inspect = (count: number) => inspectContextualQaLiteralAnswerAlignment({ request: "?", reply: Array.from({ length: count }, (_, index) => `u${index}`).join(" / "),
    ranges: [{ surface: Array.from({ length: count }, (_, index) => `u${index}`).join(" + "), startCodePoint: 0, endCodePoint: 1000 }] });
  expect(inspect(5)).toMatchObject({ status: "ambiguous", candidates: expect.any(Array) });
  expect(inspect(5).candidates).toHaveLength(5);
  expect(inspect(33)).toMatchObject({ status: "incomplete", candidates: [] });
});
