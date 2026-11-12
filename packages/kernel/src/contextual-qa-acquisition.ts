// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { copiedRequestRoleSpans } from "./conversational-frame-walk.js";
import type { TranscriptTurn } from "./dialogue-communicative-act-learning.js";
import type { ConversationalConstructionDocument } from "./conversational-construction-induction.js";
import { compileLanguageConstructionPattern, hydrateLanguageConstructionPatterns, LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA, SOURCE_EXAMPLE_CONSTRUCTION_STORAGE,
  type DurableLanguageConstructionBundle, type SourceBoundConstructionObservation, type SourceConstructionGraphBinding } from "./language-construction-memory.js";
import { createLearnedSurfaceInterpreter } from "./learned-surface-interpretation.js";
import type { LearnedConstructionPart } from "./language-construction.js";
import { inspectLearnedRequestOmittedSlot, sourceConstructionRequestValueResolver } from "./source-construction-request-binding.js";
import { featureSet, canonicalStringify, toJsonValue } from "./primitives.js";
import { canonicalNormalizationContract, normalizeCanonicalSurface } from "./normalization-contract.js";
import { isSentenceBoundarySymbol, surfaceSentenceRanges, stripTerminalSentenceBoundary } from "./surface-linguistics.js";
import { CONTEXTUAL_QA_ALIGNMENT_SEGMENTATION_RECIPE, CONTEXTUAL_QA_COMPILER_FINGERPRINT, CONTEXTUAL_QA_CONSTRUCTION_RECIPE as RECIPE,
  CONTEXTUAL_QA_DERIVED_ALIGNMENT_METHOD, CONTEXTUAL_QA_SOURCE_SYSTEM as SYSTEM, type ContextualQaRequestForm } from "./source-owned-contextual-qa.js";
import type { LanguagePatternProjection, LanguagePatternRecord } from "./storage.js";
import type { EvidenceSpan, Hasher, JsonValue, RequestedAuthority, SourceVersionId } from "./types.js";
import { segmentUnicodeSurface } from "./unicode-segmentation.js";
import { generalizeContextualQaSources, interpretContextualQaSourceGeneralization, type ContextualQaSourceGeneralization,
  type ContextualQaSourceSpan } from "./contextual-qa-source-generalization.js";
import { compileRequestRequirementCorpus, REQUEST_REQUIREMENT_CORPUS_SCHEMA } from "./request-requirement-learning.js";
import { unicodeLexicalSegments } from "./unicode-segmentation.js";

type Copy = { slotIndex: number; startCodePoint: number; endCodePoint: number; requestStart: number; requestEnd: number; value: string };
type SupportingSourceRange = NonNullable<TranscriptTurn["supportingSourceRanges"]>[number];
type LearnedRequestControl = { key: string; surface: string; anchor: "start" | "end"; authority: RequestedAuthority; exampleSupport: number };
type LearnedRequestFrame = { controlKey: string; argumentStart: number; argumentEnd: number };
type AnswerAlignment = { status: "bound"; answer: string; range: SupportingSourceRange; answerOffset: number; replyOffset: number }
  | { status: "absent" | "ambiguous" | "incomplete" };
type Measured = { sourceId: string; partition: string; recordId: string; sourceFamilyId?: string; profileId: string; languageIdentityId: string; languageIdentityDigest: string; ownership: string; pairId: string; span: EvidenceSpan; request: string; reply: string; context: string;
  requestAuthority: RequestedAuthority;
  supportingSourceRanges: NonNullable<import("./source-owned-contextual-qa.js").ContextualQaSupervision["supportingSourceRanges"]>;
  requestStart: number; requestEnd: number; replyStart: number; replyEnd: number; contextStart: number; contextEnd: number;
  answerRange?: { startCodePoint: number; endCodePoint: number };
  derivedAnswerAlignment?: { method: typeof CONTEXTUAL_QA_DERIVED_ALIGNMENT_METHOD;
    segmentationRecipe: typeof CONTEXTUAL_QA_ALIGNMENT_SEGMENTATION_RECIPE; normalizationContractId: string;
    replyAnswerStartCodePoint: number; replyAnswerEndCodePoint: number;
    sourceAnswerStartCodePoint: number; sourceAnswerEndCodePoint: number };
  clause: string; clauseStart: number; clauseEnd: number; answerStart: number; answerEnd: number; copies: Copy[]; questionForm: ContextualQaRequestForm; sourceForm: ContextualQaRequestForm; requestControlKey?: string };
export interface AcquiredContextualQaFamily { applicability: { fitBindings: number; heldOutBindings: number; outOfApplicability: number }; pattern: LanguagePatternRecord; sourceDependencies: NonNullable<LanguagePatternProjection["sourceDependencies"]> }
export interface ContextualQaAcquisitionResult {
  families: AcquiredContextualQaFamily[];
  pairs: number;
  rejected: Array<{ bindingId: string; reason: string; detail?: JsonValue }>;
}
export interface ContextualQaAcquisitionPartition { index: number; count: number }
export type ContextualQaConstructionVerification =
  | { status: "verified"; bundle: DurableLanguageConstructionBundle }
  | { status: "rejected"; reason: string; detail?: JsonValue };

/** Human context annotations supervise role alignment; they never certify a later world's facts. */
export function acquireContextualQaConstructions(input: { documents: readonly ConversationalConstructionDocument[]; hasher: Hasher; updatedAt: number; authorship: string;
  /** Deterministic group shard. Every shard receives the complete immutable corpus, but evaluates only its assigned construction groups. */
  groupPartition?: ContextualQaAcquisitionPartition }): ContextualQaAcquisitionResult {
  if (input.groupPartition && (!Number.isSafeInteger(input.groupPartition.index) || !Number.isSafeInteger(input.groupPartition.count)
    || input.groupPartition.count < 1 || input.groupPartition.index < 0 || input.groupPartition.index >= input.groupPartition.count)) {
    throw new Error("invalid contextual QA group partition");
  }
  const groups = new Map<string, Measured[]>(), rejected: ContextualQaAcquisitionResult["rejected"] = [];
  const literalWitnesses = new Map<string, Array<Extract<AnswerAlignment, { status: "bound" }>>>();
  const ownerCohorts = new Map<string, Map<string, { request: string; answerCandidates: string[] }>>();
  const profileAssignments = new Map<string, Set<string>>();
  for (const document of input.documents) {
    const assignments = profileAssignments.get(document.profileId) ?? new Set<string>();
    assignments.add(canonicalStringify([document.languageIdentityId ?? null, document.languageIdentityDigest ?? null]));
    profileAssignments.set(document.profileId, assignments);
  }
  let pairs = 0;
  if (input.authorship !== "human_authored") return { families: [], pairs,
    rejected: input.groupPartition?.index ? [] : [{ bindingId: "", reason: "human_source_required" }] };
  const requestControls = compileContextualQaRequestControls(input.documents, input.hasher, input.updatedAt, input.authorship);
  for (const document of input.documents) {
    const turns = document.transcriptTurns ?? [];
    for (const reply of turns) {
      const request = turns.find(turn => turn.index === reply.replyToTurnIndex);
      if (request && document.languageIdentityId && document.languageIdentityDigest) {
        const labels = [...new Set(document.spans.map(span => canonicalStringify(span.informationLabel ?? null)))];
        if (labels.length !== 1) { rejected.push({ bindingId: "", reason: "mixed_information_ownership" }); continue; }
        const ownerKey = canonicalStringify([document.spans[0]?.informationLabel ?? null, input.authorship, document.languageIdentityId]);
        const cohort = ownerCohorts.get(ownerKey) ?? new Map<string, { request: string; answerCandidates: string[] }>();
        cohort.set(canonicalStringify([document.sourceVersionId, request.startCodePoint, reply.startCodePoint]), { request: request.surface, answerCandidates: [] });
        ownerCohorts.set(ownerKey, cohort);
      }
      if (!request || reply.commitmentScope !== "external" || !reply.supportingSourceRanges?.length) continue;
      pairs++;
      if (profileAssignments.get(document.profileId)!.size !== 1) { rejected.push({ bindingId: "", reason: "conflicting_profile_identity_assignment" }); continue; }
      if (!document.languageIdentityId || !document.languageIdentityDigest) { rejected.push({ bindingId: "", reason: "verified_language_identity_required" }); continue; }
      const record = reply.sourceRecordId ?? request.sourceRecordId;
      if (reply.sourceRecordId !== request.sourceRecordId || reply.sourceFamilyId !== request.sourceFamilyId) { rejected.push({ bindingId: "", reason: "original_record_owner_mismatch" }); continue; }
      const annotated = reply.supportingSourceRanges.filter(range => range.answerRange !== undefined);
      const annotation = annotated[0]?.answerRange;
      if (annotated.length && (annotated.length !== 1 || !annotation || !record
        || !Number.isSafeInteger(annotation.startCodePoint) || !Number.isSafeInteger(annotation.endCodePoint)
        || annotation.startCodePoint < annotated[0]!.startCodePoint || annotation.endCodePoint > annotated[0]!.endCodePoint
        || annotation.endCodePoint <= annotation.startCodePoint
        || [...annotated[0]!.surface].slice(annotation.startCodePoint - annotated[0]!.startCodePoint, annotation.endCodePoint - annotated[0]!.startCodePoint).join("") !== reply.surface)) {
        rejected.push({ bindingId: "", reason: "declared_answer_range_invalid" }); continue;
      }
      const declared: AnswerAlignment | undefined = annotated.length ? (() => {
        const answer = reply.surface.trim(), leading = [...reply.surface.slice(0, reply.surface.length - reply.surface.trimStart().length)].length;
        return answer ? { status: "bound", answer, range: annotated[0]!,
          answerOffset: annotation!.startCodePoint - annotated[0]!.startCodePoint + leading, replyOffset: leading } : { status: "absent" };
      })() : undefined;
      const inspected = declared ? undefined : inspectContextualQaLiteralAnswerAlignment({ request: request.surface, reply: reply.surface, ranges: reply.supportingSourceRanges });
      if (declared && declared.status !== "bound" || inspected && (inspected.status === "absent" || inspected.status === "incomplete")) {
        rejected.push({ bindingId: "", reason: inspected?.status === "incomplete" ? "derived_answer_alignment_budget_exhausted" : "derived_answer_alignment_missing" }); continue;
      }
      const alignments: Array<Extract<AnswerAlignment, { status: "bound" }>> = declared?.status === "bound" ? [declared]
        : inspected!.candidates.map(candidate => ({ status: "bound", answer: candidate.answer, range: reply.supportingSourceRanges![candidate.rangeIndex]!,
          answerOffset: candidate.sourceStartCodePoint, replyOffset: candidate.replyStartCodePoint }));
      const pairId = canonicalStringify([document.sourceVersionId, request.startCodePoint, reply.startCodePoint]);
      literalWitnesses.set(pairId, alignments);
      const ownerKey = canonicalStringify([document.spans[0]?.informationLabel ?? null, input.authorship, document.languageIdentityId]);
      const cohort = ownerCohorts.get(ownerKey);
      if (cohort?.has(pairId)) cohort.set(pairId, { request: request.surface, answerCandidates: [...new Set(alignments.map(row => row.answer))].sort(compareSurface) });
      const requestFrames = learnedRequestFrames(request.surface, request.requestAuthority ?? "factual", requestControls.get(ownerKey) ?? []);
      for (const alignment of alignments) {
      const { range, answerOffset, replyOffset, answer } = alignment;
      const spans = document.spans.filter(span => span.status === "promoted" && String(span.sourceVersionId) === document.sourceVersionId
        && span.charEnd - span.charStart === [...span.text].length
        && [request, reply, ...reply.supportingSourceRanges!].every(part => part.startCodePoint >= span.charStart && part.endCodePoint <= span.charEnd
          && [...span.text].slice(part.startCodePoint - span.charStart, part.endCodePoint - span.charStart).join("") === part.surface));
      if (spans.length !== 1) { rejected.push({ bindingId: "", reason: "complete_owner_evidence_required" }); continue; }
      const span = spans[0]!;
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
      const rawCopies: Copy[] = [];
      for (const role of copied) {
        if (role.startCodePoint < answerEnd && role.endCodePoint > answerStart) continue;
        const value = [...clause].slice(role.startCodePoint, role.endCodePoint).join("");
        const owners = occurrences(request.surface, value);
        if (owners.length !== 1) continue;
        const requestStart = [...request.surface.slice(0, owners[0]!)].length;
        rawCopies.push({ ...role, value, requestStart, requestEnd: requestStart + [...value].length });
      }
      if (!rawCopies.length) { rejected.push({ bindingId: "", reason: "query_context_correspondence_missing" }); continue; }
      rawCopies.sort((a, b) => a.startCodePoint - b.startCodePoint);
      const framedCopySets = requestFrames.flatMap(frame => rawCopies
        .filter(copy => copy.requestStart >= frame.argumentStart && copy.requestEnd <= frame.argumentEnd)
        .map(copy => ({ requestControlKey: frame.controlKey, copies: [{ ...copy, slotIndex: 0 }] })));
      const copySets: Array<{ requestControlKey?: string; copies: Copy[] }> = framedCopySets.length
        ? [...new Map(framedCopySets.map(candidate => [canonicalStringify([candidate.requestControlKey,
          candidate.copies.map(copy => [copy.requestStart, copy.requestEnd, copy.startCodePoint, copy.endCodePoint])]), candidate])).values()]
        : [{ copies: rawCopies.map((copy, index) => ({ ...copy, slotIndex: index })) }];
      const ownership = canonicalStringify([span.informationLabel ?? null, input.authorship, document.languageIdentityId]);
      for (const candidate of copySets) {
      const relationStart = Math.min(answerStart, ...candidate.copies.map(copy => copy.startCodePoint));
      const protectedEnd = Math.max(answerEnd, ...candidate.copies.map(copy => copy.endCodePoint));
      // The relation core ends with its final measured role. Sentence punctuation and following discourse are
      // outside that relation; retaining either as a synthetic role makes an otherwise reusable construction
      // depend on whether a source window happened to be sentence-final.
      const relationEnd = protectedEnd;
      const relationClause = [...clause].slice(relationStart, relationEnd).join("");
      const copies = candidate.copies.map(copy => ({ ...copy,
        startCodePoint: copy.startCodePoint - relationStart, endCodePoint: copy.endCodePoint - relationStart }));
      const relationAnswerStart = answerStart - relationStart, relationAnswerEnd = answerEnd - relationStart;
      const questionForm = form(request.surface, copies.map(copy => ({ slotIndex: copy.slotIndex, start: copy.requestStart, end: copy.requestEnd })));
      const sourceForm = form(relationClause, [...copies.map(copy => ({ slotIndex: copy.slotIndex, start: copy.startCodePoint, end: copy.endCodePoint })),
        { slotIndex: copies.length, start: relationAnswerStart, end: relationAnswerEnd }]);
      const measured: Measured = { sourceId: String(span.sourceId), ownership, pairId, languageIdentityId: document.languageIdentityId, languageIdentityDigest: document.languageIdentityDigest,
        partition: reply.sourceFamilyId ?? record ?? String(span.sourceId),
        recordId: record ?? String(span.sourceId), ...(reply.sourceFamilyId ? { sourceFamilyId: reply.sourceFamilyId } : {}), profileId: document.profileId, span,
        request: request.surface, requestAuthority: request.requestAuthority ?? "factual", reply: answer, context: range.surface, copies, questionForm, sourceForm,
        ...(candidate.requestControlKey ? { requestControlKey: candidate.requestControlKey } : {}),
        supportingSourceRanges: reply.supportingSourceRanges.map(range => ({ startCodePoint: range.startCodePoint - span.charStart,
          endCodePoint: range.endCodePoint - span.charStart, ...(range.answerRange ? { answerRange: {
            startCodePoint: range.answerRange.startCodePoint - span.charStart, endCodePoint: range.answerRange.endCodePoint - span.charStart } } : {}) })),
        requestStart: request.startCodePoint - span.charStart, requestEnd: request.endCodePoint - span.charStart,
        replyStart: reply.startCodePoint - span.charStart, replyEnd: reply.endCodePoint - span.charStart,
        contextStart: range.startCodePoint - span.charStart, contextEnd: range.endCodePoint - span.charStart,
        ...(annotation ? { answerRange: { startCodePoint: annotation.startCodePoint - span.charStart,
          endCodePoint: annotation.endCodePoint - span.charStart } } : { derivedAnswerAlignment: { method: CONTEXTUAL_QA_DERIVED_ALIGNMENT_METHOD,
          segmentationRecipe: CONTEXTUAL_QA_ALIGNMENT_SEGMENTATION_RECIPE,
          normalizationContractId: canonicalNormalizationContract().id,
          replyAnswerStartCodePoint: reply.startCodePoint + replyOffset - span.charStart,
          replyAnswerEndCodePoint: reply.startCodePoint + replyOffset + [...answer].length - span.charStart,
          sourceAnswerStartCodePoint: range.startCodePoint + answerOffset - span.charStart,
          sourceAnswerEndCodePoint: range.startCodePoint + answerOffset + [...answer].length - span.charStart } }),
        clause: relationClause, clauseStart: range.startCodePoint + clauseOffset + relationStart - span.charStart,
        clauseEnd: range.startCodePoint + clauseOffset + relationEnd - span.charStart,
        answerStart: relationAnswerStart, answerEnd: relationAnswerEnd };
      const key = canonicalStringify([ownership, measured.requestControlKey ?? questionForm, sourceForm.filter(part => typeof part !== "string")]), group = groups.get(key) ?? []; group.push(measured); groups.set(key, group);
      }
      }
    }
  }
  const families = new Map<string, AcquiredContextualQaFamily>();
  const orderedGroups = [...groups].sort(([a], [b]) => a.localeCompare(b));
  // Corpus qualification above is intentionally global. Only shard zero reports those shared rejections;
  // otherwise a coordinator would multiply the same audit events by its worker count.
  if (input.groupPartition?.index) rejected.length = 0;
  for (const [groupOrdinal, [key, measured_]] of orderedGroups.entries()) {
    const groupAuditOwner = !input.groupPartition || groupOrdinal % input.groupPartition.count === input.groupPartition.index;
    const measured = [...new Map(measured_.map(row => [canonicalStringify([row.request, row.requestAuthority, row.reply, row.context,
      row.requestControlKey ?? null, row.questionForm, row.sourceForm,
      row.answerRange ? ["declared", row.answerRange.startCodePoint - row.contextStart, row.answerRange.endCodePoint - row.contextStart]
        : row.derivedAnswerAlignment ? ["derived", row.derivedAnswerAlignment.sourceAnswerStartCodePoint - row.contextStart,
          row.derivedAnswerAlignment.sourceAnswerEndCodePoint - row.contextStart] : null]), row])).values()]
      .sort((a, b) => a.partition.localeCompare(b.partition) || a.sourceId.localeCompare(b.sourceId) || a.requestStart - b.requestStart);
    const partitions = [...new Set(measured.map(row => row.partition))].sort((a, b) => input.hasher.digestHex(a).localeCompare(input.hasher.digestHex(b)) || a.localeCompare(b));
    const heldPartition = partitions.at(-1), allFit = measured.filter(row => row.partition !== heldPartition);
    const candidateSets = new Map<string, Measured[]>([[canonicalStringify(allFit.map(row => measured.indexOf(row))), allFit]]);
    const exact = new Map<string, Measured[]>();
    for (const row of allFit) { const formKey = canonicalStringify(row.sourceForm), members = exact.get(formKey) ?? []; members.push(row); exact.set(formKey, members); }
    for (const members of exact.values()) candidateSets.set(canonicalStringify(members.map(row => measured.indexOf(row))), members);
    // A single unrelated source skeleton can make the whole-cohort model unidentifiable, while exact source-form
    // equality is too narrow to discover a finite, independently repeated variation. Seed the existing verifier
    // with bounded pairs of independent observations. A seed is never publishable by itself: below it must recover
    // the complete measured cohort, exclude every alternative literal witness, and survive leave-one-family-out
    // replay. Bound the product of seeds and cohort rows rather than seeds alone; otherwise one large archive turns
    // a nominal 256-candidate limit into hundreds of thousands of complete request/source interpretations.
    const maxPairSeeds = Math.max(1, Math.min(256, Math.floor(32_768 / Math.max(1, measured.length))));
    if (partitions.length >= 3) {
      const pairSeeds = boundedContextualQaPairSeedIndices(measured, maxPairSeeds);
      if (pairSeeds.exceeded && groupAuditOwner) rejected.push({ bindingId: "", reason: "pair_seed_budget_exhausted" });
      for (const [left, right] of pairSeeds.indices) candidateSets.set(canonicalStringify([left, right]), [measured[left]!, measured[right]!]);
    }
    const assignments = new Map<string, Measured[]>();
    for (const candidateSet of candidateSets.values()) {
      const byPair = new Map<string, Measured[]>();
      for (const row of candidateSet) byPair.set(row.pairId, [...(byPair.get(row.pairId) ?? []), row]);
      let rows: Measured[][] = [[]];
      for (const choices of byPair.values()) {
        if (rows.length * choices.length > 4_096) { rows = []; if (groupAuditOwner) rejected.push({ bindingId: "", reason: "family_alignment_budget_exhausted" }); break; }
        rows = rows.flatMap(prefix => choices.map(choice => [...prefix, choice]));
      }
      for (const assignment of rows) assignments.set(canonicalStringify(assignment.map(row => measured.indexOf(row))), assignment);
    }
    let assignmentOrdinal = 0;
    for (const fit of assignments.values()) {
      const ownsAssignment = !input.groupPartition
        || (groupOrdinal + assignmentOrdinal) % input.groupPartition.count === input.groupPartition.index;
      assignmentOrdinal++;
      if (!ownsAssignment) continue;
      const fitPartitions = new Set(fit.map(row => row.partition));
      const held = measured.filter(row => !fitPartitions.has(row.partition));
      let bindingId = `source.contextual_qa.${input.hasher.digestHex(canonicalStringify([key, fit.map(row => row.sourceForm)]))}`;
      const varying = fit[0]?.copies.filter(copy => new Set(fit.map(row => row.copies[copy.slotIndex]!.value)).size > 1).map(copy => copy.slotIndex) ?? [];
      if (new Set(fit.map(row => row.partition)).size < 2 || !held.length || !varying.length || new Set(fit.map(row => row.reply)).size < 2) { rejected.push({ bindingId, reason: "independent_role_contrast_missing" }); continue; }
      const variableMap = new Map(varying.map((index, slot) => [index, slot]));
      const requestForm = (row: Measured) => foldedForm(row.request, row.copies.map(copy => ({ slotIndex: variableMap.get(copy.slotIndex), start: copy.requestStart, end: copy.requestEnd })));
      const requestGroups = new Map<string, Measured[]>();
      for (const row of measured) { const formKey = canonicalStringify(requestForm(row)), members = requestGroups.get(formKey) ?? []; members.push(row); requestGroups.set(formKey, members); }
      const qualifiedRequestGroup = [...requestGroups].map(([formKey, rows]) => ({ formKey, rows,
        partitions: new Set(rows.map(row => row.partition)).size })).filter(group => group.partitions >= 2
          && new Set(group.rows.map(row => row.reply)).size >= 2
          && varying.every(index => new Set(group.rows.map(row => row.copies[index]!.value)).size >= 2))
        .sort((a, b) => b.partitions - a.partitions || b.rows.length - a.rows.length || compareSurface(a.formKey, b.formKey))[0];
      if (!qualifiedRequestGroup) { rejected.push({ bindingId, reason: "independent_request_form_contrast_missing" }); continue; }
      const requestRepresentative = qualifiedRequestGroup.rows[0]!;
      const qForm = requestForm(requestRepresentative);
      const requestFit = qualifiedRequestGroup.rows;
      // A published request construction is licensed by one independently repeated observed form. Do not
      // project that form onto alternative copied substrings from differently decorated requests while deciding
      // source applicability: doing so turns incidental overlaps (for example a repeated article elsewhere in a
      // sentence) into counterfactual requests and creates false distinct bindings. Other repeated forms qualify
      // as their own families.
      if (fit.some(row => !requestFit.includes(row))) continue;
      if (!qForm.some(part => typeof part === "string" && part.trim())) { rejected.push({ bindingId, reason: "literal_relation_form_missing" }); continue; }
      const requestFor = (row: Measured) => instantiateContextualQaRequest(qForm, new Map(varying.map(index => [variableMap.get(index)!, row.copies[index]!.value])));
      const protectedSpans = (row: Measured): ContextualQaSourceSpan[] => [...row.copies.flatMap(copy => variableMap.has(copy.slotIndex)
        ? [{ slotIndex: variableMap.get(copy.slotIndex)!, startCodePoint: copy.startCodePoint, endCodePoint: copy.endCodePoint }] : []),
        { slotIndex: varying.length, startCodePoint: row.answerStart, endCodePoint: row.answerEnd }];
      const identity = (row: Measured) => canonicalStringify([row.sourceId, row.span.sourceVersionId, row.span.id, row.requestStart, row.contextStart]);
      const windows = fit.map(row => ({ id: identity(row), surface: row.clause, protectedSpans: protectedSpans(row) }));
      const finiteGeneralization = generalizeContextualQaSources({ fit: windows });
      const openGeneralization = generalizeContextualQaSources({ fit: windows, sourceOnlySurfaceClass: "open" });
      const openInterpretations = openGeneralization ? requestFit.flatMap(row => {
        const interpreted = interpretContextualQaSourceGeneralization({ model: openGeneralization, surface: row.clause,
          protectedSpans: protectedSpans(row) });
        return interpreted ? [{ row, spans: interpreted.sourceOnlySpans }] : [];
      }) : [];
      const openByPair = new Map<string, typeof openInterpretations>();
      for (const entry of openInterpretations) openByPair.set(entry.row.pairId, [...(openByPair.get(entry.row.pairId) ?? []), entry]);
      const uniqueOpenRows = [...openByPair.values()].flatMap(rows => rows.length === 1 ? rows : []);
      const hybridOpenGeneralization = (() => {
        if (!openGeneralization || !finiteGeneralization
          || new Set(uniqueOpenRows.map(entry => entry.row.partition)).size < 4
          || canonicalStringify(openGeneralization.parts) !== canonicalStringify(finiteGeneralization.parts)
          || canonicalStringify(openGeneralization.sourceOnlyRoles.map(role => role.slotIndex))
            !== canonicalStringify(finiteGeneralization.sourceOnlyRoles.map(role => role.slotIndex))) return undefined;
        const promoted = new Set<number>();
        for (const role of openGeneralization.sourceOnlyRoles) {
          const value = (row: Measured, spans: readonly ContextualQaSourceSpan[]) => {
            const span = spans.find(candidate => candidate.slotIndex === role.slotIndex);
            return span ? [...row.clause].slice(span.startCodePoint, span.endCodePoint).join("") : "";
          };
          const fitValues = new Set(fit.map(row => value(row,
            openGeneralization.fit.find(example => example.id === identity(row))!.sourceOnlySpans)));
          if (uniqueOpenRows.some(entry => !fitPartitions.has(entry.row.partition)
            && !fitValues.has(value(entry.row, entry.spans)))) promoted.add(role.slotIndex);
        }
        if (!promoted.size) return undefined;
        const surfaceClass = new Map(finiteGeneralization.sourceOnlyRoles.map(role => [role.slotIndex,
          promoted.has(role.slotIndex) ? "open" as const : "observed" as const]));
        return { ...finiteGeneralization,
          sourceOnlyRoles: finiteGeneralization.sourceOnlyRoles.map(role => ({ ...role, surfaceClass: surfaceClass.get(role.slotIndex)! })),
          fit: finiteGeneralization.fit.map(example => ({ ...example, sourceOnlySpans: example.sourceOnlySpans.map(span => ({ ...span,
            surfaceClass: surfaceClass.get(span.slotIndex)! })) })) };
      })();
      const generalized = hybridOpenGeneralization ?? finiteGeneralization;
      if (!generalized) { rejected.push({ bindingId, reason: "source_generalization_unidentifiable" }); continue; }
      bindingId = `source.contextual_qa.${input.hasher.digestHex(canonicalStringify([fit[0]!.ownership, qForm,
        contextualQaSourceModelSignature(generalized)]))}`;
      const sourceOnly = new Map<Measured, readonly ContextualQaSourceSpan[]>();
      for (const row of fit) sourceOnly.set(row, generalized.fit.find(example => example.id === identity(row))!.sourceOnlySpans);
      const relationId = `relation.contextual_qa.${input.hasher.digestHex(canonicalStringify([fit[0]!.ownership, generalized.parts]))}`;
      const basis = [fit[0]!];
      for (const index of varying) { const contrast = fit.find(row => row.copies[index]!.value !== fit[0]!.copies[index]!.value)!; if (!basis.includes(contrast)) basis.push(contrast); }
      const answerContrast = fit.find(row => row.reply !== fit[0]!.reply)!; if (!basis.includes(answerContrast)) basis.push(answerContrast);
      for (const role of generalized.sourceOnlyRoles) for (const value of role.observedValues) {
        const witness = value === ""
          ? fit.find(row => !sourceOnly.get(row)!.some(span => span.slotIndex === role.slotIndex))
          : fit.find(row => sourceOnly.get(row)!.some(span => span.slotIndex === role.slotIndex
            && [...row.clause].slice(span.startCodePoint, span.endCodePoint).join("") === value));
        if (!witness) throw new Error("contextual QA source-only class lacks its measured witness");
        if (!basis.includes(witness)) basis.push(witness);
      }
      let owner = [...fit].sort((a, b) => compareSurface(a.profileId, b.profileId) || compareSurface(a.sourceId, b.sourceId)
        || compareSurface(String(a.span.sourceVersionId), String(b.span.sourceVersionId)))[0]!;
      const compile = (rows: readonly Measured[], requestRows: readonly Measured[], compiledBindingId = bindingId,
        acquisitionStatus: "document_heldout_qualified" | "source_observed" = "document_heldout_qualified") => compileLanguageConstructionPattern({ bindingId: compiledBindingId, profileId: owner.profileId, hasher: input.hasher,
        updatedAt: input.updatedAt, evidence: [...new Map([...rows, ...requestRows].map(row => [String(row.span.id), row.span])).values()],
        observations: [...rows.flatMap(row => observations(row, variableMap, relationId, sourceOnly.get(row)!, false, true)),
          ...requestRows.flatMap(row => observations(row, variableMap, relationId, [], true, false))],
        acquisitionStatus, storageEncoding: SOURCE_EXAMPLE_CONSTRUCTION_STORAGE });
      const trained = compile(basis, [requestRepresentative]);
      if (trained.status !== "compiled") { rejected.push({ bindingId, reason: "owned_construction_compile_failed" }); continue; }
      const applicable: Measured[] = [];
      let invalid = false;
      const byPair = new Map<string, Measured[]>();
      for (const row of requestFit) byPair.set(row.pairId, [...(byPair.get(row.pairId) ?? []), row]);
      for (const choices of byPair.values()) {
        const recovered: Measured[] = [];
        const containsFitWitness = choices.some(row => fit.includes(row));
        let pairRejected = false;
        for (const row of choices) {
        const projectedRequest = requestFor(row);
        const requestAudit = inspectLearnedRequestOmittedSlot({ bundles: [trained.bundle] }, projectedRequest);
        if (requestAudit.status === "incomplete" || requestAudit.status === "ambiguous") {
          rejected.push({ bindingId, reason: `request_placement_${requestAudit.status}` });
          if (fit.includes(row)) invalid = true; else pairRejected = true;
          break;
        }
        if (requestAudit.status !== "value_demand") continue;
        const result = inspectRecovery(trained.bundle, row, projectedRequest);
        if (result.status === "ambiguous" || result.status === "incomplete") {
          rejected.push({ bindingId, reason: `source_recovery_${result.status}${result.ambiguityCause ? `.${result.ambiguityCause}` : ""}` });
          if (fit.includes(row)) invalid = true; else pairRejected = true;
          break;
        }
        if (result.status !== "bound") {
          if (fit.includes(row)) { rejected.push({ bindingId, reason: "fit_source_recovery_missing" }); invalid = true; }
          continue;
        }
        if (!result.binding || result.binding.value !== row.reply) continue;
        if (result.binding.evidenceIds.length !== 1 || result.binding.evidenceIds[0] !== String(row.span.id)) {
          rejected.push({ bindingId, reason: "source_recovery_evidence_mismatch" });
          if (fit.includes(row)) invalid = true; else pairRejected = true;
          break;
        }
        const interpreted = interpretContextualQaSourceGeneralization({ model: generalized, surface: row.clause, protectedSpans: protectedSpans(row) });
        if (!interpreted) continue;
        sourceOnly.set(row, interpreted.sourceOnlySpans); recovered.push(row);
        }
        if (invalid) break;
        if (pairRejected) continue;
        if (recovered.length !== 1) {
          if (containsFitWitness) {
            rejected.push({ bindingId, reason: recovered.length ? "multiple_source_alignments_recovered" : "fit_source_alignment_missing" });
            invalid = true;
          }
          continue;
        }
        const selected = recovered[0]!;
        // Every retained exact witness must be excluded by the typed source/request construction, including witnesses outside this shape group.
        for (const other of literalWitnesses.get(selected.pairId) ?? []) {
          const selectedRange = selected.derivedAnswerAlignment ?? { sourceAnswerStartCodePoint: selected.answerRange!.startCodePoint,
            sourceAnswerEndCodePoint: selected.answerRange!.endCodePoint, replyAnswerStartCodePoint: selected.replyStart, replyAnswerEndCodePoint: selected.replyEnd };
          if (other.range.startCodePoint + other.answerOffset - selected.span.charStart === selectedRange.sourceAnswerStartCodePoint
            && other.range.startCodePoint + other.answerOffset + [...other.answer].length - selected.span.charStart === selectedRange.sourceAnswerEndCodePoint
            && selected.replyStart + other.replyOffset === selectedRange.replyAnswerStartCodePoint
            && selected.replyStart + other.replyOffset + [...other.answer].length === selectedRange.replyAnswerEndCodePoint) continue;
          const exclusion = excludesLiteralWitness(generalized, other, varying.map(index => selected.copies[index]!.value));
          if (!exclusion) {
            rejected.push({ bindingId, reason: "literal_witness_exclusion_failed" });
            if (fit.includes(selected)) invalid = true; else pairRejected = true;
            break;
          }
        }
        if (pairRejected) continue;
        applicable.push(selected);
      }
      const heldApplicable = applicable.filter(row => held.includes(row));
      const observedByPair = new Map<string, Measured[]>();
      for (const row of requestFit) {
        const interpreted = interpretContextualQaSourceGeneralization({ model: generalized, surface: row.clause, protectedSpans: protectedSpans(row) });
        if (!interpreted) continue;
        sourceOnly.set(row, interpreted.sourceOnlySpans);
        observedByPair.set(row.pairId, [...(observedByPair.get(row.pairId) ?? []), row]);
      }
      const observedApplicable = [...observedByPair.values()].flatMap(rows => rows.length === 1 ? rows : []);
      const independentlyObserved = new Set(observedApplicable.map(row => row.partition)).size >= 3
        && new Set(observedApplicable.map(row => row.reply)).size >= 2
        && varying.every(index => new Set(observedApplicable.map(row => row.copies[index]!.value)).size >= 2)
        && observedApplicable.some(row => held.includes(row));
      const transferCandidate = !invalid && heldApplicable.length > 0 && fit.every(row => applicable.includes(row));
      let qualificationMethod: "leave_one_source_family_out.v1" | "independent_source_observed.v1"
        = transferCandidate ? "leave_one_source_family_out.v1" : "independent_source_observed.v1";
      if (!transferCandidate) {
        rejected.push({ bindingId, reason: "heldout_relation_recovery_failed" });
        if (!independentlyObserved) continue;
        invalid = false;
      }
      // A noisy outside family does not invalidate a relation that is independently reproducible elsewhere.
      // Retain the largest stable witness set. Seed rows discover a candidate; they are not privileged evidence
      // once a larger independently recovered cohort exists. Publication still requires multiple source families
      // and at least one witness that was outside the discovery seed.
      let qualifiedApplicable = [...(transferCandidate ? applicable : observedApplicable)];
      const foldFailureReasons = new Set<string>();
      while (qualificationMethod === "leave_one_source_family_out.v1") {
        const failedPartitions = new Set<string>();
        for (const partition of new Set(qualifiedApplicable.map(row => row.partition))) {
        const foldFit = qualifiedApplicable.filter(row => row.partition !== partition), foldHeld = qualifiedApplicable.filter(row => row.partition === partition);
        if (new Set(foldFit.map(row => row.partition)).size < 2 || new Set(foldFit.map(row => row.reply)).size < 2
          || varying.some(index => new Set(foldFit.map(row => row.copies[index]!.value)).size < 2)) {
          failedPartitions.add(partition); foldFailureReasons.add("insufficient_contrast"); continue;
        }
        const foldModel = generalizeContextualQaSources({ fit: foldFit.map(row => ({ id: identity(row), surface: row.clause, protectedSpans: protectedSpans(row) })),
          sourceOnlySurfaceClass: generalized.sourceOnlyRoles.some(role => role.surfaceClass === "open") ? "open" : "observed" });
        // Qualification is behavioral: a fold may encode the same recoverable relation with a different
        // internal literal/role split. Requiring byte-identical model signatures rejects equivalent parses.
        if (!foldModel) { failedPartitions.add(partition); foldFailureReasons.add("source_model_missing"); continue; }
        const folded = compileLanguageConstructionPattern({ bindingId, profileId: owner.profileId, hasher: input.hasher, updatedAt: input.updatedAt,
          evidence: [...new Map(foldFit.map(row => [String(row.span.id), row.span])).values()],
          observations: foldFit.flatMap(row => observations(row, variableMap, relationId,
            foldModel.fit.find(example => example.id === identity(row))!.sourceOnlySpans,
            canonicalStringify(requestForm(row)) === qualifiedRequestGroup.formKey)),
          acquisitionStatus: "document_heldout_qualified", storageEncoding: SOURCE_EXAMPLE_CONSTRUCTION_STORAGE });
        if (folded.status !== "compiled") { failedPartitions.add(partition); foldFailureReasons.add("compile_failed"); continue; }
        let foldFailed = false;
        for (const row of foldHeld) {
          const requestStatus = inspectLearnedRequestOmittedSlot({ bundles: [folded.bundle] }, requestFor(row)).status;
          if (requestStatus !== "value_demand") {
            foldFailed = true; foldFailureReasons.add(`heldout_request_${requestStatus}`); continue;
          }
          const recovery = inspectRecovery(folded.bundle, row, requestFor(row));
          if (recovery.binding?.value !== row.reply) {
            foldFailed = true; foldFailureReasons.add(`heldout_source_${recovery.status}`);
          }
        }
        if (foldFailed) { failedPartitions.add(partition); foldFailureReasons.add("heldout_replay_failed"); }
        }
        if (!failedPartitions.size) break;
        const next = qualifiedApplicable.filter(row => !failedPartitions.has(row.partition));
        if (next.length === qualifiedApplicable.length || new Set(next.map(row => row.partition)).size < 3
          || new Set(next.map(row => row.reply)).size < 2
          || varying.some(index => new Set(next.map(row => row.copies[index]!.value)).size < 2)
          || !next.some(row => held.includes(row))) { invalid = true; break; }
        qualifiedApplicable = next;
      }
      if (invalid) {
        rejected.push({ bindingId, reason: "leave_one_family_out_recovery_failed" });
        for (const reason of foldFailureReasons) rejected.push({ bindingId, reason: `leave_one_family_out.${reason}` });
        if (!independentlyObserved) continue;
        qualifiedApplicable = [...observedApplicable];
        qualificationMethod = "independent_source_observed.v1";
      }
      if ([...(ownerCohorts.get(owner.ownership) ?? [])].some(([pairId, contrast]) => contextualQaRequestMatches(qForm, contrast.request)
        && (qualifiedApplicable.some(row => row.pairId === pairId && occurrences(contrast.request, row.reply).length)
          || !qualifiedApplicable.some(row => row.pairId === pairId)
            && (!contrast.answerCandidates.length || contrast.answerCandidates.some(answer => occurrences(contrast.request, answer).length))))) {
        rejected.push({ bindingId, reason: "matching_closed_or_unresolved_contrast" }); continue;
      }
      owner = [...qualifiedApplicable].sort((a, b) => compareSurface(a.profileId, b.profileId) || compareSurface(a.sourceId, b.sourceId)
        || compareSurface(String(a.span.sourceVersionId), String(b.span.sourceVersionId)))[0]!;
      const finalBasis = [...qualifiedApplicable].sort((a, b) => measured.indexOf(a) - measured.indexOf(b));
      const features = [...new Set(qForm.filter((part): part is string => typeof part === "string").flatMap(contextualQaRequestFeatures))].sort();
      const contextualQaOwnership = { languageIdentityId: owner.languageIdentityId, informationLabel: owner.span.informationLabel ?? null, authorship: input.authorship,
        members: [...new Map(qualifiedApplicable.map(row => [row.profileId, { profileId: row.profileId, languageIdentityDigest: row.languageIdentityDigest }])).values()].sort((a, b) => compareSurface(a.profileId, b.profileId)) };
      const contextualQaQualification = { method: qualificationMethod, partitions: [...new Set(qualifiedApplicable.map(row => row.partition))].sort(),
        witnesses: qualifiedApplicable.map(row => ({ sourceId: row.sourceId, sourceVersionId: String(row.span.sourceVersionId), evidenceId: String(row.span.id),
          profileId: row.profileId, sourceFamilyId: row.sourceFamilyId ?? null, sourceRecordId: row.recordId, requestStart: row.requestStart,
          requestEnd: row.requestEnd, requestAuthority: row.requestAuthority,
          replyStart: row.replyStart, replyEnd: row.replyEnd, contextStart: row.contextStart, contextEnd: row.contextEnd,
          supportingSourceRanges: row.supportingSourceRanges,
          requestDigest: input.hasher.digestHex(row.request), replyDigest: input.hasher.digestHex([...row.span.text].slice(row.replyStart, row.replyEnd).join("")),
          contextDigest: input.hasher.digestHex(row.context), selectedAnswerDigest: input.hasher.digestHex(row.reply),
          selectedAlignment: row.derivedAnswerAlignment ?? row.answerRange,
          alternativesDigest: input.hasher.digestHex(canonicalStringify((literalWitnesses.get(row.pairId) ?? []).map(alternative => ({
            answer: alternative.answer, sourceStart: alternative.range.startCodePoint + alternative.answerOffset,
            sourceEnd: alternative.range.startCodePoint + alternative.answerOffset + [...alternative.answer].length,
            replyOffset: alternative.replyOffset })))) })) };
      const qualificationReceipt = { sourceSystem: SYSTEM, componentRecipe: RECIPE, compilerFingerprint: CONTEXTUAL_QA_COMPILER_FINGERPRINT,
        sourceId: owner.sourceId, sourceVersionId: String(owner.span.sourceVersionId), profileId: owner.profileId,
        contextualQaOwnership, contextualQaQualification, contextualQaRelationId: relationId,
        contextualQaRequestForm: qForm, contextualQaRequestFeatures: features };
      const qualifiedBindingId = contextualQaQualifiedBindingId(input.hasher, qualificationReceipt);
      const compiled = compile(finalBasis, finalBasis.filter(row => canonicalStringify(requestForm(row)) === qualifiedRequestGroup.formKey), qualifiedBindingId,
        qualificationMethod === "leave_one_source_family_out.v1" ? "document_heldout_qualified" : "source_observed");
      if (compiled.status !== "compiled") { rejected.push({ bindingId, reason: "owned_construction_compile_failed" }); continue; }
      const metadata = compiled.pattern.patternJson as Record<string, JsonValue>;
      const pattern = { ...compiled.pattern, patternJson: toJsonValue({ ...metadata, ...qualificationReceipt,
        requestConstructionCandidate: true, sourceConstructionCandidate: true }) };
      const dependencies = new Map<string, NonNullable<LanguagePatternProjection["sourceDependencies"]>[number]>();
      for (const row of qualifiedApplicable) {
        const version = String(row.span.sourceVersionId), previous = dependencies.get(version);
        if (previous && String(previous.sourceId) !== row.sourceId) throw new Error("contextual QA source version has conflicting owners");
        dependencies.set(version, { sourceId: row.span.sourceId, sourceVersionId: row.span.sourceVersionId, evidenceIds: [...new Set([...(previous?.evidenceIds ?? []), row.span.id])].sort() });
      }
      const qualifiedPartitions = [...new Set(qualifiedApplicable.map(row => row.partition))]
        .sort((a, b) => input.hasher.digestHex(a).localeCompare(input.hasher.digestHex(b)) || a.localeCompare(b));
      const qualificationHeldPartition = qualifiedPartitions.at(-1);
      const qualificationHeldBindings = qualifiedApplicable.filter(row => row.partition === qualificationHeldPartition).length;
      const publicationVerification = inspectContextualQaConstructionVerification({ pattern,
        evidence: [...new Map(qualifiedApplicable.map(row => [String(row.span.id), row.span])).values()], hasher: input.hasher });
      if (publicationVerification.status !== "verified") {
        rejected.push({ bindingId: pattern.id, reason: `publication_verification.${publicationVerification.reason}`,
          ...(publicationVerification.detail === undefined ? {} : { detail: publicationVerification.detail }) });
        continue;
      }
      families.set(pattern.id, { pattern, sourceDependencies: [...dependencies.values()].sort((a, b) => String(a.sourceVersionId).localeCompare(String(b.sourceVersionId))),
        applicability: { fitBindings: qualifiedApplicable.length - qualificationHeldBindings, heldOutBindings: qualificationHeldBindings,
          outOfApplicability: measured.length - qualifiedApplicable.length } });
    }
  }
  const result = { families: [...families.values()], pairs, rejected };
  return input.groupPartition ? result : mergeContextualQaAcquisitionResults([result]);
}

/** Apply the one global conflict/subsumption reduction after independently evaluated group shards complete. */
export function mergeContextualQaAcquisitionResults(results: readonly ContextualQaAcquisitionResult[]): ContextualQaAcquisitionResult {
  if (!results.length) return { families: [], pairs: 0, rejected: [] };
  const pairs = results[0]!.pairs;
  if (results.some(result => result.pairs !== pairs)) throw new Error("contextual QA worker pair inventories differ");
  const rejected = results.flatMap(result => result.rejected);
  const families = new Map<string, AcquiredContextualQaFamily>();
  for (const result of results) for (const family of result.families) {
    const existing = families.get(family.pattern.id);
    if (existing && canonicalStringify(toJsonValue(existing)) !== canonicalStringify(toJsonValue(family))) {
      throw new Error("contextual QA worker families disagree for one pattern identity");
    }
    families.set(family.pattern.id, family);
  }
  const familyMetadata = (family: AcquiredContextualQaFamily) => family.pattern.patternJson as unknown as {
    contextualQaRequestForm: ContextualQaRequestForm;
    contextualQaOwnership: unknown;
    contextualQaQualification: { method: "leave_one_source_family_out.v1" | "independent_source_observed.v1";
      witnesses: Array<{ sourceVersionId: string; requestStart: number; selectedAlignment: unknown }> };
  };
  const qualificationRank = (family: AcquiredContextualQaFamily) =>
    familyMetadata(family).contextualQaQualification.method === "leave_one_source_family_out.v1" ? 1 : 0;
  const witnesses = (family: AcquiredContextualQaFamily) => familyMetadata(family).contextualQaQualification.witnesses;
  const witnessKey = (witness: ReturnType<typeof witnesses>[number]) => canonicalStringify([
    witness.sourceVersionId, witness.requestStart, witness.selectedAlignment
  ]);
  const ownershipScope = (family: AcquiredContextualQaFamily) => {
    const ownership = familyMetadata(family).contextualQaOwnership as { languageIdentityId?: unknown; informationLabel?: unknown; authorship?: unknown };
    return canonicalStringify([ownership?.languageIdentityId ?? null, ownership?.informationLabel ?? null, ownership?.authorship ?? null]);
  };
  const allFamilies = [...families.values()];
  const nonConflicting = allFamilies.filter(family => !allFamilies.some(other => other !== family
    && witnesses(family).some(witness => witnesses(other).some(candidate => candidate.sourceVersionId === witness.sourceVersionId
      && candidate.requestStart === witness.requestStart && canonicalStringify(candidate.selectedAlignment) !== canonicalStringify(witness.selectedAlignment)))));
  if (nonConflicting.length !== allFamilies.length) rejected.push({ bindingId: "", reason: "family_alignment_ambiguous" });
  // Exact-shape candidate sets can qualify a strict subset after a broader construction has already recovered
  // every one of the same owned witnesses. Keeping both does not add knowledge; it creates two admissible parses
  // for the same request/source relation. Retain the independently qualified maximal family only.
  const uniqueFamilies = nonConflicting.filter(family => !nonConflicting.some(other => {
    if (other === family || witnesses(other).length <= witnesses(family).length) return false;
    if (qualificationRank(other) < qualificationRank(family)) return false;
    const metadata = familyMetadata(family), otherMetadata = familyMetadata(other);
    if (canonicalStringify(metadata.contextualQaRequestForm) !== canonicalStringify(otherMetadata.contextualQaRequestForm)
      || ownershipScope(family) !== ownershipScope(other)) return false;
    const otherWitnesses = new Set(witnesses(other).map(witnessKey));
    return witnesses(family).every(witness => otherWitnesses.has(witnessKey(witness)));
  }));
  if (uniqueFamilies.length !== nonConflicting.length) rejected.push({ bindingId: "", reason: "family_strictly_subsumed" });
  // Stable-subset qualification can discover overlapping witness sets from different seeds. When they have the
  // same request and ownership and agree on a witness alignment, keep the widest deterministic representative;
  // retaining both would create duplicate admissible parses without adding a distinct relation.
  const reduced: AcquiredContextualQaFamily[] = [];
  const ordered = [...uniqueFamilies].sort((a, b) => qualificationRank(b) - qualificationRank(a)
    || b.applicability.fitBindings + b.applicability.heldOutBindings - a.applicability.fitBindings - a.applicability.heldOutBindings
    || a.pattern.id.localeCompare(b.pattern.id));
  for (const family of ordered) {
    const metadata = familyMetadata(family), keys = new Set(witnesses(family).map(witnessKey));
    const equivalent = reduced.some(other => canonicalStringify(metadata.contextualQaRequestForm)
      === canonicalStringify(familyMetadata(other).contextualQaRequestForm)
      && ownershipScope(family) === ownershipScope(other)
      && witnesses(other).some(witness => keys.has(witnessKey(witness))));
    if (equivalent) rejected.push({ bindingId: String(family.pattern.id), reason: "family_equivalent_overlap_reduced" });
    else reduced.push(family);
  }
  return { families: reduced, pairs, rejected };
}

type ContextualQaPairSeedRow = Pick<Measured, "partition" | "pairId" | "reply"> & { copies: readonly { value: string }[] };

/**
 * Enumerate exactly the same independent pair seeds as the former nested scan, in the same order, without
 * examining every disqualified pair. Four inverted bit sets remove rows sharing partition, pair identity,
 * answer, or the complete copied-value vector. When the bound is smaller than the row population, candidate left
 * sides are sampled evenly across the ordered cohort before unsampled rows fill any unused budget.
 */
export function boundedContextualQaPairSeedIndices(rows: readonly ContextualQaPairSeedRow[], limit: number): {
  indices: Array<readonly [number, number]>; exceeded: boolean;
} {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("pair seed limit must be a non-negative safe integer");
  type Bucket = { indices: number[]; localByGlobal: Map<number, number>; words: number;
    masks: Array<Map<string, Uint32Array>>; keys: Array<string[]> };
  const buckets = new Map<number, Bucket>();
  const bucketByGlobal: Bucket[] = [];
  for (let global = 0; global < rows.length; global++) {
    const length = rows[global]!.copies.length;
    let bucket = buckets.get(length);
    if (!bucket) { bucket = { indices: [], localByGlobal: new Map(), words: 0, masks: [], keys: [] }; buckets.set(length, bucket); }
    bucket.localByGlobal.set(global, bucket.indices.length); bucket.indices.push(global); bucketByGlobal[global] = bucket;
  }
  for (const bucket of buckets.values()) {
    bucket.words = Math.ceil(bucket.indices.length / 32);
    bucket.masks = [new Map(), new Map(), new Map(), new Map()];
    bucket.keys = bucket.indices.map(global => {
      const row = rows[global]!;
      return [row.partition, row.pairId, row.reply, canonicalStringify(row.copies.map(copy => copy.value))];
    });
    for (let local = 0; local < bucket.indices.length; local++) for (let dimension = 0; dimension < 4; dimension++) {
      const key = bucket.keys[local]![dimension]!, map = bucket.masks[dimension]!;
      let mask = map.get(key); if (!mask) { mask = new Uint32Array(bucket.words); map.set(key, mask); }
      mask[local >>> 5] = (mask[local >>> 5]! | (1 << (local & 31))) >>> 0;
    }
  }
  const indices: Array<readonly [number, number]> = [];
  if (limit === 0) return { indices, exceeded: rows.length > 1 };
  const perLeftLimit = Math.max(1, Math.floor(limit / Math.max(1, rows.length)));
  const spreadAcrossEndpoints = limit < rows.length;
  const leftOrder = [...rows.keys()];
  if (spreadAcrossEndpoints) leftOrder.sort((left, right) =>
    ((Math.imul(left + 1, 0x9e37_79b1) >>> 0) - (Math.imul(right + 1, 0x9e37_79b1) >>> 0)) || left - right);
  const seenPairs = new Set<string>();
  let exceeded = false;
  for (const global of leftOrder) {
    const bucket = bucketByGlobal[global]!, local = bucket.localByGlobal.get(global)!;
    const masks = bucket.keys[local]!.map((key, dimension) => bucket.masks[dimension]!.get(key)!);
    const startWord = spreadAcrossEndpoints ? 0 : (local + 1) >>> 5, startBit = spreadAcrossEndpoints ? 0 : (local + 1) & 31;
    let acceptedForLeft = 0;
    for (let word = startWord; word < bucket.words; word++) {
      let allowed = (~(masks[0]![word]! | masks[1]![word]! | masks[2]![word]! | masks[3]![word]!)) >>> 0;
      if (word === startWord && startBit) allowed = (allowed & (0xffff_ffff << startBit)) >>> 0;
      while (allowed) {
        const bit = (allowed & -allowed) >>> 0, offset = 31 - Math.clz32(bit), candidateLocal = (word << 5) + offset;
        allowed = (allowed & (allowed - 1)) >>> 0;
        if (candidateLocal >= bucket.indices.length) continue;
        const candidateGlobal = bucket.indices[candidateLocal]!;
        const left = Math.min(global, candidateGlobal), right = Math.max(global, candidateGlobal), pairKey = `${left}:${right}`;
        if (seenPairs.has(pairKey)) continue;
        if (acceptedForLeft >= perLeftLimit) { exceeded = true; break; }
        seenPairs.add(pairKey);
        indices.push([left, right] as const);
        acceptedForLeft++;
        if (indices.length >= limit) return { indices, exceeded: true };
      }
      if (acceptedForLeft >= perLeftLimit) break;
    }
  }
  return { indices, exceeded };
}

function compileContextualQaRequestControls(documents: readonly ConversationalConstructionDocument[], hasher: Hasher,
  updatedAt: number, authorship: string): Map<string, LearnedRequestControl[]> {
  const cohorts = new Map<string, { profileId: string; sourceVersionId: string; language: string;
    evidenceIds: string[]; examples: Array<{ text: string; authority: RequestedAuthority; responseText: string }> }>();
  for (const document of documents) {
    if (!document.languageIdentityId || !document.languageIdentityDigest) continue;
    const labels = [...new Set(document.spans.map(span => canonicalStringify(span.informationLabel ?? null)))];
    if (labels.length !== 1) continue;
    const key = canonicalStringify([document.spans[0]?.informationLabel ?? null, authorship, document.languageIdentityId]);
    const cohort = cohorts.get(key) ?? { profileId: document.profileId, sourceVersionId: document.sourceVersionId,
      language: document.languageIdentityId, evidenceIds: [], examples: [] };
    for (const reply of document.transcriptTurns ?? []) {
      const request = document.transcriptTurns?.find(turn => turn.index === reply.replyToTurnIndex);
      if (!request || reply.commitmentScope !== "external" || !reply.supportingSourceRanges?.length) continue;
      cohort.examples.push({ text: request.surface, authority: request.requestAuthority ?? "factual", responseText: reply.surface });
    }
    cohort.evidenceIds.push(...document.spans.filter(span => span.status === "promoted").map(span => String(span.id)));
    cohorts.set(key, cohort);
  }
  const result = new Map<string, LearnedRequestControl[]>();
  for (const [key, cohort] of cohorts) {
    if (cohort.examples.length < 2) continue;
    const compiled = compileRequestRequirementCorpus({ corpus: { schema: REQUEST_REQUIREMENT_CORPUS_SCHEMA,
      language: cohort.language, examples: cohort.examples }, profileId: cohort.profileId,
      sourceVersionId: cohort.sourceVersionId as SourceVersionId, evidenceIds: cohort.evidenceIds as never[], sourceSystem: SYSTEM,
      updatedAt, makeId: value => `contextual.qa.request_control.${hasher.digestHex(canonicalStringify(value))}` });
    const controls = compiled.patterns.flatMap(pattern => {
      const value = pattern.patternJson as Record<string, JsonValue>;
      const surface = typeof value.surface === "string" ? value.surface : undefined;
      const anchor = value.anchor === "start" || value.anchor === "end" ? value.anchor : undefined;
      const authority = typeof value.selectedAuthority === "string" && ["factual", "reasoned", "creative", "translation", "program", "action"].includes(value.selectedAuthority)
        ? value.selectedAuthority as RequestedAuthority : undefined;
      const exampleSupport = typeof value.exampleSupport === "number" ? value.exampleSupport : 0;
      if (!surface || !anchor || !authority || value.requestSpanRole !== "control" || exampleSupport < 2) return [];
      return [{ key: canonicalStringify([anchor, surface, authority]), surface, anchor: anchor as "start" | "end", authority, exampleSupport }];
    }).sort((a, b) => b.exampleSupport - a.exampleSupport || unicodeLexicalSegments(b.surface).length - unicodeLexicalSegments(a.surface).length
      || compareSurface(a.key, b.key));
    if (controls.length) result.set(key, controls);
  }
  return result;
}

function learnedRequestFrames(request: string, authority: RequestedAuthority, controls: readonly LearnedRequestControl[]): LearnedRequestFrame[] {
  const segments = unicodeLexicalSegments(request), frames: LearnedRequestFrame[] = [];
  if (!segments.length) return frames;
  for (const control of controls) {
    if (control.authority !== authority) continue;
    const units = unicodeLexicalSegments(control.surface).map(segment => segment.normalized);
    if (!units.length || units.length >= segments.length) continue;
    const index = control.anchor === "start" ? 0 : segments.length - units.length;
    if (!units.every((unit, offset) => segments[index + offset]?.normalized === unit)) continue;
    const argumentStart = control.anchor === "start" ? segments[index + units.length - 1]!.codePointEnd : segments[0]!.codePointStart;
    const argumentEnd = control.anchor === "start" ? segments.at(-1)!.codePointEnd : segments[index]!.codePointStart;
    if (argumentEnd <= argumentStart) continue;
    frames.push({ controlKey: control.key, argumentStart, argumentEnd });
    // Controls are ordered by independent support and then specificity. One request must have one framing
    // owner; emitting every contained control fragments the same semantic family into overlapping parses.
    break;
  }
  return [...new Map(frames.map(frame => [canonicalStringify(frame), frame])).values()];
}

function instantiateContextualQaRequest(form_: ContextualQaRequestForm, values: ReadonlyMap<number, string>): string {
  return form_.map(part => typeof part === "string" ? part : values.get(part.slotIndex) ?? "").join("");
}

function contextualQaSourceModelSignature(model: Pick<ContextualQaSourceGeneralization, "parts" | "sourceOnlyRoles">): string {
  return canonicalStringify({ parts: model.parts, sourceOnlyRoles: model.sourceOnlyRoles.map(role => ({
    slotIndex: role.slotIndex,
    surfaceClass: role.surfaceClass,
    observedValues: role.surfaceClass === "open" ? [] : role.observedValues
  })) });
}

function observations(row: Measured, variables: ReadonlyMap<number, number>, relationId: string,
  sourceOnly: readonly ContextualQaSourceSpan[], includeRequest = true, includeSource = true): SourceBoundConstructionObservation[] {
  const answerSlot = variables.size;
  const binding = (slot: number): SourceConstructionGraphBinding => ({ relationId, roleId: `${relationId}.role.${slot}`, valueKind: slot === answerSlot ? "opaque.contextual_qa.answer" : "opaque.contextual_qa.argument" });
  const common = { sourceVersionId: String(row.span.sourceVersionId), evidenceId: String(row.span.id) };
  const request: SourceBoundConstructionObservation = { ...common, surfaceStartCodePoint: row.requestStart, surfaceEndCodePoint: row.requestEnd,
    roles: row.copies.flatMap(copy => variables.has(copy.slotIndex) ? [{ slotIndex: variables.get(copy.slotIndex)!, startCodePoint: copy.requestStart, endCodePoint: copy.requestEnd, graphBinding: binding(variables.get(copy.slotIndex)!) }] : []),
    nullRoles: [{ slotIndex: answerSlot, graphBinding: binding(answerSlot) }], contextualQaSupervision: { sourceRecordId: row.recordId,
      ...(row.sourceFamilyId ? { sourceFamilyId: row.sourceFamilyId } : {}),
      sourceId: row.sourceId, profileId: row.profileId,
      supportingSourceRanges: row.supportingSourceRanges,
      ...(row.answerRange ? { answerRange: row.answerRange } : {}),
      ...(row.derivedAnswerAlignment ? { derivedAnswerAlignment: row.derivedAnswerAlignment } : {}),
      replyStartCodePoint: row.replyStart, replyEndCodePoint: row.replyEnd, contextStartCodePoint: row.contextStart, contextEndCodePoint: row.contextEnd } };
  const source: SourceBoundConstructionObservation = { ...common, surfaceStartCodePoint: row.clauseStart, surfaceEndCodePoint: row.clauseEnd,
    roles: [...row.copies.flatMap(copy => variables.has(copy.slotIndex) ? [{ slotIndex: variables.get(copy.slotIndex)!, startCodePoint: copy.startCodePoint, endCodePoint: copy.endCodePoint, graphBinding: binding(variables.get(copy.slotIndex)!) }] : []),
      { slotIndex: answerSlot, startCodePoint: row.answerStart, endCodePoint: row.answerEnd, graphBinding: binding(answerSlot) },
      ...sourceOnly.map(role => ({ ...role, graphBinding: { ...binding(role.slotIndex), valueKind: "opaque.contextual_qa.source_only",
        ...(role.surfaceClass === "observed" ? { surfaceClass: "observed" as const } : {}) } }))] };
  return [...(includeRequest ? [request] : []), ...(includeSource ? [source] : [])];
}

function inspectRecovery(bundle: DurableLanguageConstructionBundle, row: Measured, request = row.request) {
  return sourceConstructionRequestValueResolver({ bundles: [bundle], graph: { nodes: [], hyperedges: [] },
    sourceWindows: [{ evidenceId: String(row.span.id), startCodePoint: row.contextStart, endCodePoint: row.contextEnd }] }).inspect(request, [row.span]);
}

/** Exclusion is a failed complete typed construction parse, never a surface-length ranking. */
function excludesLiteralWitness(model: Parameters<typeof interpretContextualQaSourceGeneralization>[0]["model"],
  witness: Extract<AnswerAlignment, { status: "bound" }>, copiedValues: readonly string[]): boolean {
  const ranges = surfaceSentenceRanges(witness.range.surface).filter(range => {
    const start = [...witness.range.surface.slice(0, range.startUtf16)].length, end = [...witness.range.surface.slice(0, range.endUtf16)].length;
    return witness.answerOffset >= start && witness.answerOffset + [...witness.answer].length <= end;
  });
  if (ranges.length !== 1) return ranges.length === 0;
  const range = ranges[0]!, raw = witness.range.surface.slice(range.startUtf16, range.endUtf16), surface = raw.trim();
  const offset = [...witness.range.surface.slice(0, range.startUtf16 + raw.length - raw.trimStart().length)].length;
  const answer = { slotIndex: copiedValues.length, startCodePoint: witness.answerOffset - offset,
    endCodePoint: witness.answerOffset - offset + [...witness.answer].length };
  let states: ContextualQaSourceSpan[][] = [[]];
  for (const [slotIndex, value] of copiedValues.entries()) {
    const placements = occurrences(surface, value).map(start => ({ slotIndex, startCodePoint: [...surface.slice(0, start)].length,
      endCodePoint: [...surface.slice(0, start)].length + [...value].length }));
    if (states.length * placements.length > 256) return false;
    states = states.flatMap(prefix => placements.map(placement => [...prefix, placement]));
  }
  return !states.some(spans => interpretContextualQaSourceGeneralization({ model, surface, protectedSpans: [...spans, answer] }));
}

function occurrences(text: string, value: string): number[] {
  if (!value) return [];
  const found: number[] = [];
  for (let index = text.indexOf(value); index >= 0; index = text.indexOf(value, index + 1)) found.push(index);
  return found;
}

interface UnitSpan { surface: string; startCodePoint: number; endCodePoint: number }
export interface ContextualQaLiteralAnswerCandidate {
  answer: string;
  rangeIndex: number;
  replyStartCodePoint: number;
  replyEndCodePoint: number;
  sourceStartCodePoint: number;
  sourceEndCodePoint: number;
  unitCount: number;
}
export type ContextualQaLiteralAnswerInspection = { status: "absent"; candidates: readonly ContextualQaLiteralAnswerCandidate[] }
  | { status: "ambiguous"; candidates: readonly ContextualQaLiteralAnswerCandidate[] }
  | { status: "incomplete"; phase: "generation" | "deduplication" | "maximal_reduction";
    candidates: readonly ContextualQaLiteralAnswerCandidate[]; transitions: number; maxTransitions: number }
  | { status: "bound"; candidates: readonly ContextualQaLiteralAnswerCandidate[]; selected: ContextualQaLiteralAnswerCandidate };

/**
 * Recover only one distinct maximal literal witness shared by a supervised reply and its owned source range.
 * Units copied anywhere in the request are barriers, so the inferred answer cannot merely echo a query argument.
 * No language labels or word classes participate: equality is over Unicode surface units and the admitted answer
 * remains byte-for-byte source text. Multiple non-contained candidates, repeated occurrences, or missing literal support abstain.
 */
function uniqueLiteralAnswerAlignment(input: { request: string; reply: string; ranges: readonly SupportingSourceRange[] }): AnswerAlignment {
  const inspected = inspectContextualQaLiteralAnswerAlignment(input);
  if (inspected.status !== "bound") return { status: inspected.status };
  const selected = inspected.selected, range = input.ranges[selected.rangeIndex];
  if (!range) return { status: "absent" };
  return { status: "bound", answer: selected.answer, range,
    answerOffset: selected.sourceStartCodePoint, replyOffset: selected.replyStartCodePoint };
}

/** Read-only acquisition diagnostic; it performs the same abstaining alignment used by the compiler. */
export function inspectContextualQaLiteralAnswerAlignment(input: {
  request: string;
  reply: string;
  ranges: readonly Pick<SupportingSourceRange, "surface" | "startCodePoint" | "endCodePoint">[];
  maxTransitions?: number;
}): ContextualQaLiteralAnswerInspection {
  const absoluteWorkLimit = 1_000_000;
  const requestUnits = new Set(unitSpans(input.request).map(unit => unit.surface));
  const replyUnits = unitSpans(input.reply), replyPoints = [...input.reply];
  const sourceRows = input.ranges.map(range => ({ range, units: unitSpans(range.surface), points: [...range.surface] }));
  const totalUnits = replyUnits.length + sourceRows.reduce((sum, row) => sum + row.units.length, 0);
  const maxTransitions = input.maxTransitions === undefined
    ? Math.max(4_096, Math.min(absoluteWorkLimit, totalUnits * 64))
    : Number.isFinite(input.maxTransitions) ? Math.max(1, Math.min(absoluteWorkLimit, Math.floor(input.maxTransitions))) : 1;
  let transitions = 0;
  const consume = () => ++transitions <= maxTransitions;
  const candidates: ContextualQaLiteralAnswerCandidate[] = [];
  for (const [rangeIndex, { range, units: sourceUnits, points: sourcePoints }] of sourceRows.entries()) {
    const sourceByUnit = new Map<string, number[]>();
    for (const [index, unit] of sourceUnits.entries()) {
      const positions = sourceByUnit.get(unit.surface) ?? []; positions.push(index); sourceByUnit.set(unit.surface, positions);
    }
    for (const [replyIndex, replyUnit] of replyUnits.entries()) {
      if (requestUnits.has(replyUnit.surface)) continue;
      for (const sourceIndex of sourceByUnit.get(replyUnit.surface) ?? []) {
        if (!consume()) return { status: "incomplete", phase: "generation", candidates, transitions, maxTransitions };
        const replyPrevious = replyUnits[replyIndex - 1], sourcePrevious = sourceUnits[sourceIndex - 1];
        if (replyPrevious && sourcePrevious && !requestUnits.has(replyPrevious.surface)
          && replyPrevious.surface === sourcePrevious.surface
          && literalGap(replyPoints, replyPrevious, replyUnit) === literalGap(sourcePoints, sourcePrevious, sourceUnits[sourceIndex]!)) continue;
        let length = 0;
        while (replyIndex + length < replyUnits.length && sourceIndex + length < sourceUnits.length) {
          if (!consume()) return { status: "incomplete", phase: "generation", candidates, transitions, maxTransitions };
          const left = replyUnits[replyIndex + length]!, right = sourceUnits[sourceIndex + length]!;
          if (requestUnits.has(left.surface) || left.surface !== right.surface) break;
          if (length > 0 && literalGap(replyPoints, replyUnits[replyIndex + length - 1]!, left)
            !== literalGap(sourcePoints, sourceUnits[sourceIndex + length - 1]!, right)) break;
          length++;
        }
        while (length > 0) {
          const trailing = replyUnits[replyIndex + length - 1]!;
          if ([...trailing.surface].length !== 1 || !isSentenceBoundarySymbol([...trailing.surface][0]!)) break;
          length--;
        }
        if (!length) continue;
        const replyNext = replyUnits[replyIndex + length], sourceNext = sourceUnits[sourceIndex + length];
        if (replyNext && sourceNext && requestUnits.has(replyNext.surface) && replyNext.surface === sourceNext.surface
          && literalGap(replyPoints, replyUnits[replyIndex + length - 1]!, replyNext)
            === literalGap(sourcePoints, sourceUnits[sourceIndex + length - 1]!, sourceNext)) continue;
        const replyStart = replyUnit.startCodePoint, replyEnd = replyUnits[replyIndex + length - 1]!.endCodePoint;
        const sourceStart = sourceUnits[sourceIndex]!.startCodePoint, sourceEnd = sourceUnits[sourceIndex + length - 1]!.endCodePoint;
        const answer = replyPoints.slice(replyStart, replyEnd).join("");
        if (!answer || answer !== sourcePoints.slice(sourceStart, sourceEnd).join("")) continue;
        candidates.push({ answer, rangeIndex, replyStartCodePoint: replyStart, replyEndCodePoint: replyEnd,
          sourceStartCodePoint: sourceStart, sourceEndCodePoint: sourceEnd, unitCount: length });
      }
    }
  }
  const distinctByCoordinates = new Map<string, ContextualQaLiteralAnswerCandidate>();
  for (const candidate of candidates) {
    if (!consume()) return { status: "incomplete", phase: "deduplication", candidates: [], transitions, maxTransitions };
    const key = `${candidate.rangeIndex}:${candidate.replyStartCodePoint}:${candidate.replyEndCodePoint}:${candidate.sourceStartCodePoint}:${candidate.sourceEndCodePoint}`;
    if (!distinctByCoordinates.has(key)) distinctByCoordinates.set(key, candidate);
  }
  const distinct = [...distinctByCoordinates.values()], maximal: ContextualQaLiteralAnswerCandidate[] = [];
  for (const candidate of distinct) {
    let contained = false;
    for (const other of distinct) {
      if (other === candidate) continue;
      if (!consume()) return { status: "incomplete", phase: "maximal_reduction", candidates: maximal, transitions, maxTransitions };
      if (other.rangeIndex === candidate.rangeIndex
        && other.replyStartCodePoint <= candidate.replyStartCodePoint && other.replyEndCodePoint >= candidate.replyEndCodePoint
        && other.sourceStartCodePoint <= candidate.sourceStartCodePoint && other.sourceEndCodePoint >= candidate.sourceEndCodePoint
        && (other.replyStartCodePoint < candidate.replyStartCodePoint || other.replyEndCodePoint > candidate.replyEndCodePoint
          || other.sourceStartCodePoint < candidate.sourceStartCodePoint || other.sourceEndCodePoint > candidate.sourceEndCodePoint)) {
        contained = true; break;
      }
    }
    if (contained) continue;
    maximal.push(candidate);
    // Preserve every alternative for family-level exclusion. Never qualify from a truncated candidate set.
    if (maximal.length > 32) return { status: "incomplete", phase: "maximal_reduction", candidates: [], transitions, maxTransitions };
  }
  if (!maximal.length) return { status: "absent", candidates: maximal };
  maximal.sort(compareCandidateCoordinates);
  if (maximal.length > 1) return { status: "ambiguous", candidates: maximal };
  return { status: "bound", candidates: maximal, selected: maximal[0]! };
}

function unitSpans(surface: string): UnitSpan[] {
  return segmentUnicodeSurface(surface)
    .filter(unit => unit.kind !== "whitespace" && unit.kind !== "control")
    .map(unit => ({ surface: normalizeCanonicalSurface(unit.surface),
      startCodePoint: unit.codePointStart, endCodePoint: unit.codePointEnd }));
}

function literalGap(points: readonly string[], left: UnitSpan, right: UnitSpan): string {
  return points.slice(left.endCodePoint, right.startCodePoint).join("");
}

function compareSurface(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCandidateCoordinates(left: ContextualQaLiteralAnswerCandidate, right: ContextualQaLiteralAnswerCandidate): number {
  return left.replyStartCodePoint - right.replyStartCodePoint || left.rangeIndex - right.rangeIndex
    || left.sourceStartCodePoint - right.sourceStartCodePoint || compareSurface(left.answer, right.answer);
}
function contextualQaQualifiedBindingId(hasher: Hasher, receipt: unknown): string {
  return `source.contextual_qa.qualified.${hasher.digestHex(canonicalStringify(toJsonValue(receipt)))}`;
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
    let matches = 0;
    const enumeration = createLearnedSurfaceInterpreter(surface, true).enumerate({ sequence }, {
      maxTransitions: Number(budget > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : budget), collect: false,
      // A header is an admissible request family only when its learned slots have one complete placement.
      // Broad anti-unified forms can otherwise split the same Unicode surface in multiple ways and falsely
      // advertise a typed demand that the full interpreter must later reject as ambiguous.
      visit: () => { matches++; return matches < 2; }
    });
    return enumeration.complete && matches === 1;
  } catch { return false; }
}

export function contextualQaRequestFeatures(text: string): string[] {
  return featureSet(text, Number.MAX_SAFE_INTEGER);
}

/**
 * Recreate supervised acquisition from current accessible source bytes; local hashes cannot invent a relation.
 *
 * Keep the rejection stage observable. Publication used to collapse every cold-replay failure into `undefined`,
 * which made a broken construction indistinguishable from a corpus that had learned nothing.
 */
export function inspectContextualQaConstructionVerification(input: { pattern: LanguagePatternRecord; evidence: readonly EvidenceSpan[]; hasher: Hasher }): ContextualQaConstructionVerification {
  const rejected = (reason: string, detail?: JsonValue): ContextualQaConstructionVerification => ({ status: "rejected", reason, ...(detail === undefined ? {} : { detail }) });
  try {
    const metadata = input.pattern.patternJson as Record<string, JsonValue>;
    if (metadata.schema !== LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA || metadata.componentRecipe !== RECIPE
      || metadata.compilerFingerprint !== CONTEXTUAL_QA_COMPILER_FINGERPRINT
      || metadata.sourceSystem !== SYSTEM || metadata.profileId !== input.pattern.profileId) return rejected("metadata_contract");
    const hydrated = hydrateLanguageConstructionPatterns({ patterns: [input.pattern], evidence: input.evidence, hasher: input.hasher });
    const bundle = hydrated.bundles[0];
    if (!bundle) return rejected("hydration", toJsonValue({ rejected: hydrated.rejected.map(row => ({ patternId: row.patternId ?? null, code: row.code })) }));
    const qualification = metadata.contextualQaQualification as unknown as { method?: unknown; witnesses?: unknown };
    const qualificationMethod = qualification?.method;
    const expectedStatus = qualificationMethod === "leave_one_source_family_out.v1" ? "document_heldout_qualified"
      : qualificationMethod === "independent_source_observed.v1" ? "source_observed" : undefined;
    if (!expectedStatus || bundle.acquisitionStatus !== expectedStatus) return rejected("acquisition_status", bundle.acquisitionStatus);
    const ownership = metadata.contextualQaOwnership as unknown as { languageIdentityId: string; authorship: string;
      members: Array<{ profileId: string; languageIdentityDigest: string }> };
    if (!ownership?.languageIdentityId || ownership.authorship !== "human_authored" || !Array.isArray(ownership.members)) return rejected("ownership_contract");
    const byId = new Map(input.evidence.filter(span => span.status === "promoted").map(span => [String(span.id), span]));
    if (!Array.isArray(qualification.witnesses)) return rejected("qualification_contract");
    const qualificationReceipt = { sourceSystem: metadata.sourceSystem, componentRecipe: metadata.componentRecipe,
      compilerFingerprint: metadata.compilerFingerprint, sourceId: metadata.sourceId, sourceVersionId: metadata.sourceVersionId,
      profileId: metadata.profileId, contextualQaOwnership: metadata.contextualQaOwnership,
      contextualQaQualification: metadata.contextualQaQualification, contextualQaRelationId: metadata.contextualQaRelationId,
      contextualQaRequestForm: metadata.contextualQaRequestForm,
      contextualQaRequestFeatures: metadata.contextualQaRequestFeatures };
    if (bundle.bindingId !== contextualQaQualifiedBindingId(input.hasher, qualificationReceipt)) return rejected("qualification_binding");
    const relationId = typeof metadata.contextualQaRelationId === "string" ? metadata.contextualQaRelationId : undefined;
    if (!relationId) return rejected("relation_contract");
    const graphBindings = bundle.sourceExamples.flatMap(example => [...example.roles, ...example.nullRoles]
      .flatMap(role => role.graphBinding ? [{ role, binding: role.graphBinding }] : []));
    if (!graphBindings.length || graphBindings.some(({ role, binding }) => binding.relationId !== relationId
      || binding.roleId !== `${relationId}.role.${role.slotIndex}`)) return rejected("relation_binding");
    type ReplayWitness = { sourceId: string; sourceVersionId: string; evidenceId: string; profileId: string; sourceRecordId: string;
      sourceFamilyId: string | null; requestStart: number; requestEnd: number; requestAuthority: RequestedAuthority;
      replyStart: number; replyEnd: number; contextStart: number; contextEnd: number;
      supportingSourceRanges: Array<{ startCodePoint: number; endCodePoint: number; answerRange?: { startCodePoint: number; endCodePoint: number } }>;
      requestDigest: string; replyDigest: string; contextDigest: string; selectedAnswerDigest: string;
      selectedAlignment: { startCodePoint: number; endCodePoint: number } | { method: string; segmentationRecipe: string; normalizationContractId: string;
        sourceAnswerStartCodePoint: number; sourceAnswerEndCodePoint: number } };
    const witnesses = qualification.witnesses as ReplayWitness[];
    const authorities: readonly RequestedAuthority[] = ["factual", "reasoned", "creative", "translation", "program", "action"];
    const replayRows: Array<{ witness: ReplayWitness; span: EvidenceSpan; request: string; selectedAnswer: string }> = [];
    for (const witness of witnesses) {
      const span = byId.get(witness.evidenceId);
      if (!span || String(span.sourceId) !== witness.sourceId || String(span.sourceVersionId) !== witness.sourceVersionId) {
        return rejected("evidence_owner", { evidenceId: witness.evidenceId, sourceId: witness.sourceId, sourceVersionId: witness.sourceVersionId });
      }
      const points = [...span.text];
      const validRange = (start: number, end: number) => Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start && end <= points.length;
      if (!validRange(witness.requestStart, witness.requestEnd) || !validRange(witness.replyStart, witness.replyEnd)
        || !validRange(witness.contextStart, witness.contextEnd) || !authorities.includes(witness.requestAuthority)
        || typeof witness.sourceRecordId !== "string" || !witness.sourceRecordId || !Array.isArray(witness.supportingSourceRanges)
        || !witness.supportingSourceRanges.length) return rejected("witness_replay_contract", witness.evidenceId);
      const request = points.slice(witness.requestStart, witness.requestEnd).join("");
      const reply = points.slice(witness.replyStart, witness.replyEnd).join("");
      const context = points.slice(witness.contextStart, witness.contextEnd).join("");
      if (input.hasher.digestHex(request) !== witness.requestDigest || input.hasher.digestHex(reply) !== witness.replyDigest
        || input.hasher.digestHex(context) !== witness.contextDigest) return rejected("witness_digest", witness.evidenceId);
      const selected = witness.selectedAlignment;
      if ("sourceAnswerStartCodePoint" in selected && (selected.method !== CONTEXTUAL_QA_DERIVED_ALIGNMENT_METHOD
        || selected.segmentationRecipe !== CONTEXTUAL_QA_ALIGNMENT_SEGMENTATION_RECIPE
        || selected.normalizationContractId !== canonicalNormalizationContract().id)) return rejected("derived_alignment_contract", witness.evidenceId);
      const selectedStart = "sourceAnswerStartCodePoint" in selected ? selected.sourceAnswerStartCodePoint : selected.startCodePoint;
      const selectedEnd = "sourceAnswerEndCodePoint" in selected ? selected.sourceAnswerEndCodePoint : selected.endCodePoint;
      if (!validRange(selectedStart, selectedEnd)
        || input.hasher.digestHex(points.slice(selectedStart, selectedEnd).join("")) !== witness.selectedAnswerDigest) return rejected("selected_answer_digest", witness.evidenceId);
      for (const range of witness.supportingSourceRanges) {
        if (!validRange(range.startCodePoint, range.endCodePoint)
          || range.answerRange && (!validRange(range.answerRange.startCodePoint, range.answerRange.endCodePoint)
            || range.answerRange.startCodePoint < range.startCodePoint || range.answerRange.endCodePoint > range.endCodePoint)) {
          throw new Error("invalid contextual QA witness supporting range");
        }
      }
      const member = ownership.members.filter(member => member.profileId === witness.profileId);
      if (member.length !== 1 || !member[0]!.languageIdentityDigest) return rejected("ownership_member", witness.profileId);
      replayRows.push({ witness, span, request, selectedAnswer: points.slice(selectedStart, selectedEnd).join("") });
    }
    if (!replayRows.length) return rejected("supervision_missing");
    const witnessByRequest = new Map(replayRows.map(row => [canonicalStringify([
      row.witness.evidenceId, row.witness.requestStart, row.witness.requestEnd
    ]), row.witness]));
    const supervised = bundle.sourceExamples.filter(example => example.contextualQaSupervision);
    if (!supervised.length) return rejected("supervision_missing");
    for (const example of supervised) {
      const witness = witnessByRequest.get(canonicalStringify([example.evidenceId, example.surfaceStartCodePoint, example.surfaceEndCodePoint]));
      if (!witness) return rejected("supervision_witness_missing", example.evidenceId);
      const selected = witness.selectedAlignment;
      const expected = { sourceRecordId: witness.sourceRecordId,
        ...(witness.sourceFamilyId ? { sourceFamilyId: witness.sourceFamilyId } : {}), sourceId: witness.sourceId, profileId: witness.profileId,
        supportingSourceRanges: witness.supportingSourceRanges,
        ...("sourceAnswerStartCodePoint" in selected ? { derivedAnswerAlignment: selected } : { answerRange: selected }),
        replyStartCodePoint: witness.replyStart, replyEndCodePoint: witness.replyEnd,
        contextStartCodePoint: witness.contextStart, contextEndCodePoint: witness.contextEnd };
      if (canonicalStringify(example.contextualQaSupervision) !== canonicalStringify(expected)) return rejected("supervision_mismatch", example.evidenceId);
    }
    const requestForm = metadata.contextualQaRequestForm as unknown as ContextualQaRequestForm;
    for (const { witness, span, request, selectedAnswer } of replayRows) {
      if (!contextualQaRequestMatches(requestForm, request)) return rejected("request_replay", witness.evidenceId);
      const audit = sourceConstructionRequestValueResolver({ bundles: [bundle], graph: { nodes: [], hyperedges: [] },
        sourceWindows: [{ evidenceId: String(span.id), startCodePoint: witness.contextStart, endCodePoint: witness.contextEnd }] }).inspect(request, [span]);
      if (audit.status !== "bound" || !audit.binding || audit.binding.value !== selectedAnswer
        || canonicalStringify(audit.binding.evidenceIds) !== canonicalStringify([String(span.id)])) {
        return rejected("source_replay", { evidenceId: witness.evidenceId, status: audit.status,
          ...(audit.ambiguityCause ? { ambiguityCause: audit.ambiguityCause } : {}),
          ...(audit.candidates ? { candidates: audit.candidates.map(candidate => ({ value: candidate.value, subject: candidate.subject ?? null })) } : {}) });
      }
    }
    return { status: "verified", bundle };
  } catch (error) {
    return rejected("exception", error instanceof Error ? error.message : String(error));
  }
}

/** Compatibility wrapper for callers that only need the verified construction. */
export function verifyContextualQaConstruction(input: { pattern: LanguagePatternRecord; evidence: readonly EvidenceSpan[]; hasher: Hasher }): DurableLanguageConstructionBundle | undefined {
  const result = inspectContextualQaConstructionVerification(input);
  return result.status === "verified" ? result.bundle : undefined;
}
