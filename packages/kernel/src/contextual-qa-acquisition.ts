// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { copiedRequestRoleSpans } from "./conversational-frame-walk.js";
import type { ConversationalConstructionDocument } from "./conversational-construction-induction.js";
import { compileLanguageConstructionPattern, hydrateLanguageConstructionPatterns, LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA, SOURCE_EXAMPLE_CONSTRUCTION_STORAGE,
  type DurableLanguageConstructionBundle, type SourceBoundConstructionObservation, type SourceConstructionGraphBinding } from "./language-construction-memory.js";
import { createLearnedSurfaceInterpreter } from "./learned-surface-interpretation.js";
import type { LearnedConstructionPart } from "./language-construction.js";
import { sourceConstructionRequestValueResolver } from "./source-construction-request-binding.js";
import { featureSet, canonicalStringify, toJsonValue } from "./primitives.js";
import { isSentenceBoundarySymbol, surfaceSentenceRanges, stripTerminalSentenceBoundary } from "./surface-linguistics.js";
import { CONTEXTUAL_QA_CONSTRUCTION_RECIPE as RECIPE, CONTEXTUAL_QA_SOURCE_SYSTEM as SYSTEM, type ContextualQaRequestForm } from "./source-owned-contextual-qa.js";
import type { LanguagePatternProjection, LanguagePatternRecord } from "./storage.js";
import type { EvidenceSpan, Hasher, JsonValue } from "./types.js";
import { generalizeContextualQaSources, interpretContextualQaSourceGeneralization, type ContextualQaSourceSpan } from "./contextual-qa-source-generalization.js";

type Copy = { slotIndex: number; startCodePoint: number; endCodePoint: number; requestStart: number; requestEnd: number; value: string };
type Measured = { sourceId: string; partition: string; recordId: string; sourceFamilyId?: string; profileId: string; span: EvidenceSpan; request: string; reply: string; context: string;
  requestStart: number; requestEnd: number; replyStart: number; replyEnd: number; contextStart: number; contextEnd: number;
  clause: string; clauseStart: number; clauseEnd: number; answerStart: number; answerEnd: number; copies: Copy[]; questionForm: ContextualQaRequestForm; sourceForm: ContextualQaRequestForm };
export interface AcquiredContextualQaFamily { applicability: { fitBindings: number; heldOutBindings: number; outOfApplicability: number }; pattern: LanguagePatternRecord; sourceDependencies: NonNullable<LanguagePatternProjection["sourceDependencies"]> }

/** Human context annotations supervise role alignment; they never certify a later world's facts. */
export function acquireContextualQaConstructions(input: { documents: readonly ConversationalConstructionDocument[]; hasher: Hasher; updatedAt: number; authorship: string }) {
  const groups = new Map<string, Measured[]>(), rejected: Array<{ bindingId: string; reason: string }> = [];
  let pairs = 0;
  if (input.authorship !== "human_authored") return { families: [] as AcquiredContextualQaFamily[], pairs, rejected: [{ bindingId: "", reason: "human_source_required" }] };
  for (const document of input.documents) {
    const turns = document.transcriptTurns ?? [];
    for (const reply of turns) {
      const request = turns.find(turn => turn.index === reply.replyToTurnIndex);
      if (!request || reply.commitmentScope !== "external" || !reply.supportingSourceRanges?.length) continue;
      pairs++;
      const record = reply.sourceRecordId ?? request.sourceRecordId;
      if (reply.sourceRecordId !== request.sourceRecordId || reply.sourceFamilyId !== request.sourceFamilyId) { rejected.push({ bindingId: "", reason: "original_record_owner_mismatch" }); continue; }
      const answer = reply.surface.trim();
      const matches = reply.supportingSourceRanges.flatMap(range => occurrences(range.surface, answer).map(offset => ({ range, offset })));
      if (!answer || matches.length !== 1) { rejected.push({ bindingId: "", reason: "declared_answer_not_unique" }); continue; }
      const { range, offset } = matches[0]!;
      const spans = document.spans.filter(span => span.status === "promoted" && String(span.sourceVersionId) === document.sourceVersionId
        && span.charEnd - span.charStart === [...span.text].length
        && [request, reply, range].every(part => part.startCodePoint >= span.charStart && part.endCodePoint <= span.charEnd
          && [...span.text].slice(part.startCodePoint - span.charStart, part.endCodePoint - span.charStart).join("") === part.surface));
      if (spans.length !== 1) { rejected.push({ bindingId: "", reason: "complete_owner_evidence_required" }); continue; }
      const span = spans[0]!;
      const answerOffset = [...range.surface.slice(0, offset)].length;
      const clauseRanges = surfaceSentenceRanges(range.surface).filter(sentence => {
        const start = [...range.surface.slice(0, sentence.startUtf16)].length, end = [...range.surface.slice(0, sentence.endUtf16)].length;
        return answerOffset >= start && answerOffset + [...answer].length <= end;
      });
      if (clauseRanges.length !== 1) { rejected.push({ bindingId: "", reason: "answer_clause_not_identifiable" }); continue; }
      const clauseRange = clauseRanges[0]!, clauseSurface = range.surface.slice(clauseRange.startUtf16, clauseRange.endUtf16), clause = clauseSurface.trim();
      const leading = clauseSurface.length - clauseSurface.trimStart().length;
      const clauseOffset = [...range.surface.slice(0, clauseRange.startUtf16 + leading)].length;
      const answerStart = answerOffset - clauseOffset, answerEnd = answerStart + [...answer].length;
      const candidates = copiedRequestRoleSpans(request.surface, clause, "literal");
      const copied = candidates?.filter(role => candidates.filter(candidate => candidate.slotIndex === role.slotIndex).length === 1);
      if (!copied?.length) { rejected.push({ bindingId: "", reason: "copied_role_owner_ambiguous" }); continue; }
      const copies: Copy[] = [];
      for (const role of copied) {
        if (role.startCodePoint < answerEnd && role.endCodePoint > answerStart) continue;
        const value = [...clause].slice(role.startCodePoint, role.endCodePoint).join("");
        const owners = occurrences(request.surface, value);
        if (owners.length !== 1) continue;
        const requestStart = [...request.surface.slice(0, owners[0]!)].length;
        copies.push({ ...role, value, requestStart, requestEnd: requestStart + [...value].length });
      }
      if (!copies.length) { rejected.push({ bindingId: "", reason: "query_context_correspondence_missing" }); continue; }
      copies.sort((a, b) => a.startCodePoint - b.startCodePoint);
      copies.forEach((copy, index) => { copy.slotIndex = index; });
      const questionForm = form(request.surface, copies.map(copy => ({ slotIndex: copy.slotIndex, start: copy.requestStart, end: copy.requestEnd })));
      const sourceForm = form(clause, [...copies.map(copy => ({ slotIndex: copy.slotIndex, start: copy.startCodePoint, end: copy.endCodePoint })),
        { slotIndex: copies.length, start: answerStart, end: answerEnd }]);
      const measured: Measured = { sourceId: String(span.sourceId), partition: reply.sourceFamilyId ?? record ?? String(span.sourceId),
        recordId: record ?? String(span.sourceId), ...(reply.sourceFamilyId ? { sourceFamilyId: reply.sourceFamilyId } : {}), profileId: document.profileId, span,
        request: request.surface, reply: answer, context: range.surface, copies, questionForm, sourceForm,
        requestStart: request.startCodePoint - span.charStart, requestEnd: request.endCodePoint - span.charStart,
        replyStart: reply.startCodePoint - span.charStart, replyEnd: reply.endCodePoint - span.charStart,
        contextStart: range.startCodePoint - span.charStart, contextEnd: range.endCodePoint - span.charStart,
        clause, clauseStart: range.startCodePoint + clauseOffset - span.charStart,
        clauseEnd: range.startCodePoint + clauseOffset + [...clause].length - span.charStart, answerStart, answerEnd };
      const key = canonicalStringify([questionForm, sourceForm.filter(part => typeof part !== "string")]), group = groups.get(key) ?? []; group.push(measured); groups.set(key, group);
    }
  }
  const families = new Map<string, AcquiredContextualQaFamily>();
  for (const [key, measured_] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const measured = [...new Map(measured_.map(row => [canonicalStringify([row.request, row.reply, row.context]), row])).values()]
      .sort((a, b) => a.partition.localeCompare(b.partition) || a.sourceId.localeCompare(b.sourceId) || a.requestStart - b.requestStart);
    const partitions = [...new Set(measured.map(row => row.partition))].sort((a, b) => input.hasher.digestHex(a).localeCompare(input.hasher.digestHex(b)) || a.localeCompare(b));
    const heldPartition = partitions.at(-1), allFit = measured.filter(row => row.partition !== heldPartition), held = measured.filter(row => row.partition === heldPartition);
    const candidateSets = new Map<string, Measured[]>([[canonicalStringify(allFit.map(row => measured.indexOf(row))), allFit]]);
    const exact = new Map<string, Measured[]>();
    for (const row of allFit) { const formKey = canonicalStringify(row.sourceForm), members = exact.get(formKey) ?? []; members.push(row); exact.set(formKey, members); }
    for (const members of exact.values()) candidateSets.set(canonicalStringify(members.map(row => measured.indexOf(row))), members);
    for (const fit of candidateSets.values()) {
      let bindingId = `source.contextual_qa.${input.hasher.digestHex(canonicalStringify([key, fit.map(row => row.sourceForm)]))}`;
      const varying = fit[0]?.copies.filter(copy => new Set(fit.map(row => row.copies[copy.slotIndex]!.value)).size > 1).map(copy => copy.slotIndex) ?? [];
      if (!fit.length || !held.length || !varying.length || new Set(fit.map(row => row.reply)).size < 2) { rejected.push({ bindingId, reason: "independent_role_contrast_missing" }); continue; }
      const variableMap = new Map(varying.map((index, slot) => [index, slot]));
      const qForm = foldedForm(fit[0]!.request, fit[0]!.copies.map(copy => ({ slotIndex: variableMap.get(copy.slotIndex), start: copy.requestStart, end: copy.requestEnd })));
      if (!qForm.some(part => typeof part === "string" && part.trim())) { rejected.push({ bindingId, reason: "literal_relation_form_missing" }); continue; }
      const protectedSpans = (row: Measured): ContextualQaSourceSpan[] => [...row.copies.flatMap(copy => variableMap.has(copy.slotIndex)
        ? [{ slotIndex: variableMap.get(copy.slotIndex)!, startCodePoint: copy.startCodePoint, endCodePoint: copy.endCodePoint }] : []),
        { slotIndex: varying.length, startCodePoint: row.answerStart, endCodePoint: row.answerEnd }];
      const identity = (row: Measured) => canonicalStringify([row.sourceId, row.span.sourceVersionId, row.span.id, row.requestStart, row.contextStart]);
      const generalized = generalizeContextualQaSources({ fit: fit.map(row => ({ id: identity(row), surface: row.clause, protectedSpans: protectedSpans(row) })) });
      if (!generalized) { rejected.push({ bindingId, reason: "source_generalization_unidentifiable" }); continue; }
      bindingId = `source.contextual_qa.${input.hasher.digestHex(canonicalStringify([qForm, generalized.parts, generalized.sourceOnlyRoles]))}`;
      const sourceOnly = new Map<Measured, readonly ContextualQaSourceSpan[]>();
      for (const row of fit) sourceOnly.set(row, generalized.fit.find(example => example.id === identity(row))!.sourceOnlySpans);
      const relationId = `relation.contextual_qa.${input.hasher.digestHex(canonicalStringify(generalized.parts))}`;
      const basis = [fit[0]!];
      for (const index of varying) { const contrast = fit.find(row => row.copies[index]!.value !== fit[0]!.copies[index]!.value)!; if (!basis.includes(contrast)) basis.push(contrast); }
      const answerContrast = fit.find(row => row.reply !== fit[0]!.reply)!; if (!basis.includes(answerContrast)) basis.push(answerContrast);
      for (const role of generalized.sourceOnlyRoles) for (const value of role.observedValues) {
        const witness = fit.find(row => sourceOnly.get(row)!.some(span => span.slotIndex === role.slotIndex
          && [...row.clause].slice(span.startCodePoint, span.endCodePoint).join("") === value))!;
        if (!basis.includes(witness)) basis.push(witness);
      }
      const owner = fit[0]!;
      const compile = (rows: readonly Measured[]) => compileLanguageConstructionPattern({ bindingId, profileId: owner.profileId, hasher: input.hasher,
        updatedAt: input.updatedAt, evidence: [...new Map(rows.map(row => [String(row.span.id), row.span])).values()],
        observations: rows.flatMap(row => observations(row, variableMap, relationId, sourceOnly.get(row)!)), acquisitionStatus: "document_heldout_qualified", storageEncoding: SOURCE_EXAMPLE_CONSTRUCTION_STORAGE });
      const trained = compile(basis);
      if (trained.status !== "compiled") { rejected.push({ bindingId, reason: "owned_construction_compile_failed" }); continue; }
      const applicable: Measured[] = [];
      let invalid = false;
      for (const row of measured) {
        const result = inspectRecovery(trained.bundle, row);
        if (result.status === "ambiguous" || result.status === "incomplete") { invalid = true; break; }
        if (result.status !== "bound") { if (fit.includes(row)) invalid = true; continue; }
        if (!result.binding || result.binding.value !== row.reply || result.binding.evidenceIds.length !== 1 || result.binding.evidenceIds[0] !== String(row.span.id)) { invalid = true; break; }
        const interpreted = interpretContextualQaSourceGeneralization({ model: generalized, surface: row.clause, protectedSpans: protectedSpans(row) });
        if (!interpreted) { invalid = true; break; }
        sourceOnly.set(row, interpreted.sourceOnlySpans); applicable.push(row);
      }
      const heldApplicable = applicable.filter(row => held.includes(row));
      if (invalid || !heldApplicable.length || fit.some(row => !applicable.includes(row))) { rejected.push({ bindingId, reason: "heldout_relation_recovery_failed" }); continue; }
      const finalBasis = [...basis, heldApplicable[0]!].sort((a, b) => measured.indexOf(a) - measured.indexOf(b));
      const compiled = compile(finalBasis);
      if (compiled.status !== "compiled") { rejected.push({ bindingId, reason: "owned_construction_compile_failed" }); continue; }
      const features = [...new Set(qForm.filter((part): part is string => typeof part === "string").flatMap(contextualQaRequestFeatures))].sort();
      const metadata = compiled.pattern.patternJson as Record<string, JsonValue>;
      const pattern = { ...compiled.pattern, patternJson: toJsonValue({ ...metadata, sourceSystem: SYSTEM, componentRecipe: RECIPE,
        sourceId: owner.sourceId, sourceVersionId: String(owner.span.sourceVersionId), profileId: owner.profileId,
        contextualQaRequestForm: qForm, contextualQaRequestFeatures: features, requestConstructionCandidate: true, sourceConstructionCandidate: true }) };
      const dependencies = new Map<string, NonNullable<LanguagePatternProjection["sourceDependencies"]>[number]>();
      for (const row of applicable) {
        const version = String(row.span.sourceVersionId), previous = dependencies.get(version);
        if (previous && String(previous.sourceId) !== row.sourceId) throw new Error("contextual QA source version has conflicting owners");
        dependencies.set(version, { sourceId: row.span.sourceId, sourceVersionId: row.span.sourceVersionId, evidenceIds: [...new Set([...(previous?.evidenceIds ?? []), row.span.id])].sort() });
      }
      families.set(pattern.id, { pattern, sourceDependencies: [...dependencies.values()].sort((a, b) => String(a.sourceVersionId).localeCompare(String(b.sourceVersionId))),
        applicability: { fitBindings: applicable.length - heldApplicable.length, heldOutBindings: heldApplicable.length, outOfApplicability: measured.length - applicable.length } });
      if (fit === allFit && applicable.length === measured.length) break;
    }
  }
  return { families: [...families.values()], pairs, rejected };
}

function observations(row: Measured, variables: ReadonlyMap<number, number>, relationId: string, sourceOnly: readonly ContextualQaSourceSpan[]): SourceBoundConstructionObservation[] {
  const answerSlot = variables.size;
  const binding = (slot: number): SourceConstructionGraphBinding => ({ relationId, roleId: `${relationId}.role.${slot}`, valueKind: slot === answerSlot ? "opaque.contextual_qa.answer" : "opaque.contextual_qa.argument" });
  const common = { sourceVersionId: String(row.span.sourceVersionId), evidenceId: String(row.span.id) };
  return [{ ...common, surfaceStartCodePoint: row.requestStart, surfaceEndCodePoint: row.requestEnd,
    roles: row.copies.flatMap(copy => variables.has(copy.slotIndex) ? [{ slotIndex: variables.get(copy.slotIndex)!, startCodePoint: copy.requestStart, endCodePoint: copy.requestEnd, graphBinding: binding(variables.get(copy.slotIndex)!) }] : []),
    nullRoles: [{ slotIndex: answerSlot, graphBinding: binding(answerSlot) }], contextualQaSupervision: { sourceRecordId: row.recordId,
      ...(row.sourceFamilyId ? { sourceFamilyId: row.sourceFamilyId } : {}),
      sourceId: row.sourceId, profileId: row.profileId,
      replyStartCodePoint: row.replyStart, replyEndCodePoint: row.replyEnd, contextStartCodePoint: row.contextStart, contextEndCodePoint: row.contextEnd } },
  { ...common, surfaceStartCodePoint: row.clauseStart, surfaceEndCodePoint: row.clauseEnd,
    roles: [...row.copies.flatMap(copy => variables.has(copy.slotIndex) ? [{ slotIndex: variables.get(copy.slotIndex)!, startCodePoint: copy.startCodePoint, endCodePoint: copy.endCodePoint, graphBinding: binding(variables.get(copy.slotIndex)!) }] : []),
      { slotIndex: answerSlot, startCodePoint: row.answerStart, endCodePoint: row.answerEnd, graphBinding: binding(answerSlot) },
      ...sourceOnly.map(role => ({ ...role, graphBinding: { ...binding(role.slotIndex), valueKind: "opaque.contextual_qa.source_only", surfaceClass: "observed" as const } }))] }];
}

function inspectRecovery(bundle: DurableLanguageConstructionBundle, row: Measured) {
  return sourceConstructionRequestValueResolver({ bundles: [bundle], graph: { nodes: [], hyperedges: [] },
    sourceWindows: [{ evidenceId: String(row.span.id), startCodePoint: row.contextStart, endCodePoint: row.contextEnd }] }).inspect(row.request, [row.span]);
}

function occurrences(text: string, value: string): number[] {
  if (!value) return [];
  const found: number[] = [];
  for (let index = text.indexOf(value); index >= 0; index = text.indexOf(value, index + 1)) found.push(index);
  return found;
}
function form(text: string, slots: readonly { slotIndex: number; start: number; end: number }[]): ContextualQaRequestForm {
  const points = [...text], parts: Array<string | { slotIndex: number }> = []; let previous = 0;
  for (const slot of [...slots].sort((a, b) => a.start - b.start)) { if (slot.start < previous) throw new Error("overlapping contextual QA roles");
    const literal = points.slice(previous, slot.start).join(""); if (literal) parts.push(literal); parts.push({ slotIndex: slot.slotIndex }); previous = slot.end; }
  const tail = points.slice(previous).join(""); if (tail) parts.push(tail); return parts;
}
function foldedForm(text: string, slots: readonly { slotIndex: number | undefined; start: number; end: number }[]): ContextualQaRequestForm {
  return form(text, slots.flatMap(slot => slot.slotIndex === undefined ? [] : [{ ...slot, slotIndex: slot.slotIndex }]));
}

export function contextualQaRequestMatches(form_: ContextualQaRequestForm, requestText: string): boolean {
  try {
    const sequence: LearnedConstructionPart[] = form_.map(part => typeof part === "string"
      ? { kind: "literal", surface: part, origins: [], evidenceIds: [] }
      : { kind: "slot", roleId: String(part.slotIndex), occurrenceId: String(part.slotIndex), formClassId: "contextual.qa.header", required: true, origins: [], evidenceIds: [] });
    const last = sequence.at(-1); if (last?.kind === "literal") { const points = [...last.surface];
      if (points.length && isSentenceBoundarySymbol(points.at(-1)!)) { points.pop(); const surface = points.join("");
        if (surface) sequence[sequence.length - 1] = { ...last, surface }; else sequence.pop(); } }
    const surface = stripTerminalSentenceBoundary(requestText), budget = BigInt([...surface].length + 1) ** 2n * BigInt(sequence.length + 1);
    let matched = false;
    const enumeration = createLearnedSurfaceInterpreter(surface, true).enumerate({ sequence }, {
      maxTransitions: Number(budget > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : budget), collect: false,
      visit: () => { matched = true; }
    });
    return enumeration.complete && matched;
  } catch { return false; }
}

export function contextualQaRequestFeatures(text: string): string[] {
  return featureSet(text, Number.MAX_SAFE_INTEGER);
}

/** Recreate supervised acquisition from current accessible source bytes; local hashes cannot invent a relation. */
export function verifyContextualQaConstruction(input: { pattern: LanguagePatternRecord; evidence: readonly EvidenceSpan[]; hasher: Hasher }): DurableLanguageConstructionBundle | undefined {
  try {
    const metadata = input.pattern.patternJson as Record<string, JsonValue>;
    if (metadata.schema !== LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA || metadata.componentRecipe !== RECIPE || metadata.sourceSystem !== SYSTEM || metadata.profileId !== input.pattern.profileId) return undefined;
    const hydrated = hydrateLanguageConstructionPatterns({ patterns: [input.pattern], evidence: input.evidence, hasher: input.hasher });
    const bundle = hydrated.bundles[0]; if (!bundle || bundle.acquisitionStatus !== "document_heldout_qualified") return undefined;
    const byId = new Map(input.evidence.filter(span => span.status === "promoted").map(span => [String(span.id), span]));
    const documents: ConversationalConstructionDocument[] = [];
    for (const example of bundle.sourceExamples) {
      const supervision = example.contextualQaSupervision; if (!supervision) continue;
      const span = byId.get(example.evidenceId); if (!span || String(span.sourceId) !== supervision.sourceId) return undefined;
      const points = [...span.text], request = points.slice(example.surfaceStartCodePoint, example.surfaceEndCodePoint).join("");
      const reply = points.slice(supervision.replyStartCodePoint, supervision.replyEndCodePoint).join("");
      documents.push({ sourceVersionId: String(span.sourceVersionId), profileId: supervision.profileId, spans: [span], transcriptTurns: [
        { index: 0, speakerId: "source.request", sourceRecordId: supervision.sourceRecordId, sourceFamilyId: supervision.sourceFamilyId, surface: request, startCodePoint: span.charStart + example.surfaceStartCodePoint, endCodePoint: span.charStart + example.surfaceEndCodePoint },
        { index: 1, speakerId: "source.reply", sourceRecordId: supervision.sourceRecordId, sourceFamilyId: supervision.sourceFamilyId, surface: reply, replyToTurnIndex: 0, commitmentScope: "external",
          startCodePoint: span.charStart + supervision.replyStartCodePoint, endCodePoint: span.charStart + supervision.replyEndCodePoint,
          supportingSourceRanges: [{ startCodePoint: span.charStart + supervision.contextStartCodePoint, endCodePoint: span.charStart + supervision.contextEndCodePoint,
            surface: points.slice(supervision.contextStartCodePoint, supervision.contextEndCodePoint).join("") }] }
      ] });
    }
    const rebuilt = acquireContextualQaConstructions({ documents, hasher: input.hasher, updatedAt: input.pattern.updatedAt, authorship: "human_authored" }).families
      .find(family => family.pattern.id === input.pattern.id);
    if (!rebuilt) return undefined;
    const expected = rebuilt.pattern.patternJson as Record<string, JsonValue>;
    return canonicalStringify(expected.contextualQaRequestForm) === canonicalStringify(metadata.contextualQaRequestForm)
      && canonicalStringify(expected.contextualQaRequestFeatures) === canonicalStringify(metadata.contextualQaRequestFeatures)
      && metadata.sourceId === expected.sourceId && metadata.sourceVersionId === expected.sourceVersionId ? bundle : undefined;
  } catch { return undefined; }
}
