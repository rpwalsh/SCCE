// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { induceLearnedConstructions, realizeLearnedSurface, CONVERSATION_INTERNAL_PROVENANCE_METHOD_ID,
  type AlignedSurfaceExample, type LearnedConstruction, type LearnedConstructionInduction } from "./language-construction.js";
import { createLearnedSurfaceInterpreter } from "./learned-surface-interpretation.js";
import type { ConversationalConstructionDocument } from "./conversational-construction-induction.js";
import { canonicalStringify, createHasher, toJsonValue, featureSet } from "./primitives.js";
import { SOURCE_SPAN_COMPLETION_REQUEST_SCHEMA, sourceSpanCompletionValueResolver,
  sourceSpanCompletionRangeCurrent, type SourceSpanCompletionRequest } from "./source-owned-span-completion.js";
import { SOURCE_CONSTRUCTION_READ_BUDGET } from "./request-language-hydration.js";
import { canonicalJsonByteLength } from "./canonical-json-digest.js";
import type { LanguagePatternProjection, LanguagePatternRecord, ScceStorage } from "./storage.js";
import type { EvidenceSpan, Hasher } from "./types.js";
import type { SemanticAnswerConstructFact, SemanticRealizationContract } from "./semantic-answer-construct.js";
import { factualRoundTripGate } from "./semantic-round-trip.js";

export const SOURCE_REQUEST_EDIT_SCHEMA = "scce.source_request_edit_program.v1" as const;
export const SOURCE_REQUEST_EDIT_RECIPE = "kernel.source_request_edit_program.v1" as const;
export const SOURCE_REQUEST_EDIT_PUBLICATION = { patternSchema: SOURCE_REQUEST_EDIT_SCHEMA, componentRecipe: SOURCE_REQUEST_EDIT_RECIPE } as const;
const LEFT = "source_edit.left", VALUE = "source_edit.value", RIGHT = "source_edit.right";
type Range = { startCodePoint: number; endCodePoint: number };
interface Witness {
  sourceId: string; sourceVersionId: string; contentHash: string; evidenceId: string; recordId: string; profileId: string;
  request: Range; reply: Range;
}
interface Observation { witness: Witness; request: string; reply: string; profileId: string; ownership: string; }
interface Run { requestStart: number; replyStart: number; length: number; }
interface Edit { observation: Observation; left: Run; right: Run; key: string; }
interface Family {
  pattern: LanguagePatternRecord; input: LearnedConstructionInduction; output: LearnedConstructionInduction;
  rows: Edit[]; sourceDependencies: NonNullable<LanguagePatternProjection["sourceDependencies"]>;
}
export interface SourceRequestEditAcquisition {
  families: Family[];
  pairs: number;
  rejected: Array<{ recordId: string; reason: string }>;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function slice(text: string, start: number, end: number): string { return [...text].slice(start, end).join(""); }
function at(text: string, range: Range): string { return slice(text, range.startCodePoint, range.endCodePoint); }

export interface SourceRequestEditAlignment {
  status: "single_exchange" | "non_unique_copy_alignment" | "single_exchange_not_identified";
  runs: readonly Run[];
  work: { requestCodePoints: number; replyCodePoints: number; automatonStates: number; replyTransitions: number };
}
/** Maximal copy ownership is measured once; ambiguous/multiple edits are not forced into a single exchange. */
export function inspectSourceRequestEditAlignment(requestText: string, replyText: string): SourceRequestEditAlignment {
  const request = [...requestText], reply = [...replyText], runs: Run[] = [];
  type State = { length: number; link: number; end: number; occurrences: number; next: Map<string, number> };
  const states: State[] = [{ length: 0, link: -1, end: -1, occurrences: 0, next: new Map() }];
  let last = 0;
  for (const [end, point] of request.entries()) {
    const current = states.length;
    states.push({ length: states[last]!.length + 1, link: 0, end, occurrences: 1, next: new Map() });
    let previous = last;
    while (previous >= 0 && !states[previous]!.next.has(point)) { states[previous]!.next.set(point, current); previous = states[previous]!.link; }
    if (previous >= 0) {
      const target = states[previous]!.next.get(point)!;
      if (states[previous]!.length + 1 === states[target]!.length) states[current]!.link = target;
      else {
        const clone = states.length;
        states.push({ ...states[target]!, length: states[previous]!.length + 1, occurrences: 0, next: new Map(states[target]!.next) });
        while (previous >= 0 && states[previous]!.next.get(point) === target) { states[previous]!.next.set(point, clone); previous = states[previous]!.link; }
        states[target]!.link = clone; states[current]!.link = clone;
      }
    }
    last = current;
  }
  const order = states.map((_, index) => index).sort((a, b) => states[b]!.length - states[a]!.length);
  for (const index of order) if (states[index]!.link >= 0) states[states[index]!.link]!.occurrences += states[index]!.occurrences;
  let ambiguous = false, replyTransitions = 0;
  for (let start = 0; start < reply.length;) {
    let state = 0, end = start;
    while (end < reply.length) {
      replyTransitions++;
      const next = states[state]!.next.get(reply[end]!);
      if (next === undefined) break;
      state = next; end++;
    }
    if (end > start) {
      if (states[state]!.occurrences !== 1) ambiguous = true;
      else runs.push({ requestStart: states[state]!.end - (end - start) + 1, replyStart: start, length: end - start });
    }
    start = Math.max(start + 1, end);
  }
  const [left, right] = runs;
  return { status: ambiguous ? "non_unique_copy_alignment" : runs.length === 2 && left && right
    && left.requestStart + left.length < right.requestStart && left.replyStart + left.length < right.replyStart
    ? "single_exchange" : "single_exchange_not_identified", runs,
    work: { requestCodePoints: request.length, replyCodePoints: reply.length, automatonStates: states.length, replyTransitions } };
}
function edits(observation: Observation): Edit[] {
  const alignment = inspectSourceRequestEditAlignment(observation.request, observation.reply);
  if (alignment.status !== "single_exchange") return [];
  const [left, right] = alignment.runs as readonly [Run, Run];
    const key = canonicalStringify([
      slice(observation.request, 0, left.requestStart),
      slice(observation.request, left.requestStart + left.length, right.requestStart),
      slice(observation.request, right.requestStart + right.length, [...observation.request].length),
      slice(observation.reply, 0, left.replyStart),
      slice(observation.reply, right.replyStart + right.length, [...observation.reply].length)
    ]);
  return [{ observation, left, right, key }];
}
function examples(rows: readonly Edit[], side: "request" | "reply", profileId: string): AlignedSurfaceExample[] {
  return rows.map(row => {
    const text = row.observation[side], left = side === "request" ? row.left.requestStart : row.left.replyStart,
      right = side === "request" ? row.right.requestStart : row.right.replyStart;
    const spans = [{ roleId: LEFT, start: left, end: left + row.left.length },
      ...(side === "reply" ? [{ roleId: VALUE, start: left + row.left.length, end: right }] : []),
      { roleId: RIGHT, start: right, end: right + row.right.length }];
    const utf16 = (offset: number) => slice(text, 0, offset).length;
    return { id: canonicalStringify([row.observation.witness, side]), profileKey: profileId, surface: text,
      evidenceIds: [row.observation.witness.evidenceId], roleSpans: spans.map(span => ({ ...span,
        start: utf16(span.start), end: utf16(span.end), surface: slice(text, span.start, span.end),
        evidenceIds: [row.observation.witness.evidenceId] })) };
  });
}
function diverse(rows: readonly Edit[]): boolean {
  return [LEFT, VALUE, RIGHT].every(role => new Set(rows.map(row => {
    const start = role === LEFT ? row.left.replyStart : role === VALUE ? row.left.replyStart + row.left.length : row.right.replyStart;
    const end = role === LEFT ? start + row.left.length : role === VALUE ? row.right.replyStart : start + row.right.length;
    return slice(row.observation.reply, start, end);
  })).size > 1);
}
function compile(rows: readonly Edit[], profileId: string, hasher: Hasher) {
  return { input: induceLearnedConstructions({ examples: examples(rows, "request", profileId), hasher }),
    output: induceLearnedConstructions({ examples: examples(rows, "reply", profileId), hasher }) };
}
function parseRequest(text: string, constructions: readonly LearnedConstruction[]): SourceSpanCompletionRequest | undefined {
  const parses = new Map<string, SourceSpanCompletionRequest>();
  const interpreter = createLearnedSurfaceInterpreter(text);
  for (const construction of constructions) {
    const roles = interpreter.interpret(construction), left = roles?.find(role => role.roleId === LEFT), right = roles?.find(role => role.roleId === RIGHT);
    if (!roles || roles.length !== 2 || !left || !right || left.endCodePoint >= right.startCodePoint) continue;
    const request: SourceSpanCompletionRequest = { schema: SOURCE_SPAN_COMPLETION_REQUEST_SCHEMA, requestText: text,
      templateRange: { startCodePoint: left.startCodePoint, endCodePoint: right.endCodePoint },
      gapRange: { startCodePoint: left.endCodePoint, endCodePoint: right.startCodePoint } };
    parses.set(canonicalStringify(request), request);
  }
  return parses.size === 1 ? parses.values().next().value : undefined;
}
function realize(request: SourceSpanCompletionRequest, output: LearnedConstructionInduction, evidence: readonly EvidenceSpan[], hasher: Hasher): string | undefined {
  const binding = sourceSpanCompletionValueResolver(request).resolve(request.requestText, evidence);
  if (!binding || typeof binding === "string" || !sourceSpanCompletionRangeCurrent({ ...binding, subject: binding.subject ?? "" }, evidence)) return undefined;
  const construction = output.constructions[0];
  if (!construction || output.constructions.length !== 1) return undefined;
  const turnId = `source_edit.request.${hasher.digestHex(request.requestText)}`;
  const ranges = new Map([[LEFT, { startCodePoint: request.templateRange.startCodePoint, endCodePoint: request.gapRange.startCodePoint }],
    [RIGHT, { startCodePoint: request.gapRange.endCodePoint, endCodePoint: request.templateRange.endCodePoint }]]);
  const result = realizeLearnedSurface({ constructions: output.constructions, formClasses: output.formClasses, hasher,
    conversationTurns: [{ turnId, turnIndex: 0, surface: request.requestText }],
    plan: { id: turnId, profileKey: construction.profileKey, roleSignature: construction.roleSignature,
      slots: construction.roleOccurrences.map(occurrence => {
        const range = ranges.get(occurrence.roleId), surface = range ? at(request.requestText, range) : binding.value;
        return { ...occurrence, variants: [{ id: `${turnId}.${occurrence.roleId}`, profileKey: construction.profileKey, surface,
          evidenceIds: range ? [] : binding.evidenceIds,
          ...(range ? { conversationInternalLicence: { schema: CONVERSATION_INTERNAL_PROVENANCE_METHOD_ID,
            variantId: `${turnId}.${occurrence.roleId}`, slotIndex: construction.roleOccurrences.indexOf(occurrence),
            conversationId: turnId, sourceTurnId: turnId, ...range } } : {}) }] };
      }) } });
  return result.status === "realized" && factualRoundTripGate({ intendedText: binding.subject ?? "", realizedText: result.realization.text,
    requireComplete: true, hasher }).accepted ? result.realization.text : undefined;
}
function acquire(observations: readonly Observation[], hasher: Hasher, updatedAt: number): SourceRequestEditAcquisition {
  const groups = new Map<string, Edit[]>(), rejected: SourceRequestEditAcquisition["rejected"] = [];
  const extents = new Map<string, Set<string>>();
  for (const observation of observations) for (const edit of edits(observation)) {
    const key = canonicalStringify([observation.ownership, edit.key]), rows = groups.get(key) ?? [];
    rows.push(edit); groups.set(key, rows);
    const frame = canonicalStringify([observation.ownership, (JSON.parse(edit.key) as string[]).slice(0, 3)]), variants = extents.get(frame) ?? new Set<string>();
    variants.add(edit.key); extents.set(frame, variants);
  }
  const families: Family[] = [];
  for (const rows of groups.values()) {
    if (extents.get(canonicalStringify([rows[0]!.observation.ownership, (JSON.parse(rows[0]!.key) as string[]).slice(0, 3)]))!.size !== 1) continue;
    if (new Set(rows.map(row => row.observation.witness.recordId)).size !== rows.length || !diverse(rows)) continue;
    const profileId = rows.map(row => row.observation.profileId).sort()[0]!, compiled = compile(rows, profileId, hasher);
    if (compiled.input.rejected.length || compiled.output.rejected.length || compiled.input.constructions.length !== 1 || compiled.output.constructions.length !== 1) continue;
    let qualified = true;
    for (const heldOut of rows) {
      const fit = rows.filter(row => row.observation.witness.sourceVersionId !== heldOut.observation.witness.sourceVersionId
        && row.observation.witness.sourceId !== heldOut.observation.witness.sourceId);
      if (!diverse(fit)) { qualified = false; break; }
      const model = compile(fit, profileId, hasher), request = parseRequest(heldOut.observation.request, model.input.constructions);
      const source = { id: heldOut.observation.witness.evidenceId, sourceVersionId: heldOut.observation.witness.sourceVersionId,
        status: "promoted", text: heldOut.observation.reply } as EvidenceSpan;
      if (!request || realize(request, model.output, [source], hasher) !== heldOut.observation.reply) { qualified = false; break; }
    }
    if (!qualified) continue;
    const witnesses = rows.map(row => row.observation.witness).sort((a, b) => canonicalStringify(a).localeCompare(canonicalStringify(b)));
    const owner = rows.find(row => row.observation.profileId === profileId)!.observation.witness;
    const literals = JSON.parse(rows[0]!.key) as string[], sourceEditRequestFeatures = [...new Set([literals[0]!, literals[2]!]
      .flatMap(text => featureSet(text, Number.MAX_SAFE_INTEGER)))].sort();
    if (!sourceEditRequestFeatures.length) continue;
    const body = { schema: SOURCE_REQUEST_EDIT_SCHEMA, componentRecipe: SOURCE_REQUEST_EDIT_RECIPE,
      operation: "source_span_completion", responseExtent: "observed_full_reply", profileId, sourceId: owner.sourceId,
      sourceVersionId: owner.sourceVersionId, witnesses, frame: rows[0]!.key, sourceEditRequestFeatures };
    const dependencies = new Map<string, NonNullable<LanguagePatternProjection["sourceDependencies"]>[number]>();
    for (const witness of witnesses) {
      const prior = dependencies.get(witness.sourceVersionId);
      dependencies.set(witness.sourceVersionId, { sourceId: witness.sourceId as EvidenceSpan["sourceId"],
        sourceVersionId: witness.sourceVersionId as EvidenceSpan["sourceVersionId"],
        evidenceIds: [...new Set([...(prior?.evidenceIds ?? []), witness.evidenceId as EvidenceSpan["id"]])] });
    }
    families.push({ ...compiled, rows, sourceDependencies: [...dependencies.values()], pattern: {
      id: `source_request_edit.${hasher.digestHex(canonicalStringify(body))}`, profileId, patternKind: "semantic_role",
      support: rows.length, entropy: 0, evidenceIds: [...new Set(witnesses.map(row => row.evidenceId as EvidenceSpan["id"]))],
      updatedAt, patternJson: toJsonValue(body) } });
  }
  const covered = new Set(families.flatMap(family => family.rows.map(row => row.observation.witness.recordId)));
  for (const observation of observations) if (!covered.has(observation.witness.recordId)) rejected.push({ recordId: observation.witness.recordId,
    reason: "independent_held_out_edit_program_not_identified" });
  return { families, pairs: observations.length, rejected };
}

/** Human paired edits supervise text operations, never the truth of a later supplied value. */
export function acquireSourceRequestEditPrograms(input: { documents: readonly ConversationalConstructionDocument[]; authorship: string; hasher: Hasher; updatedAt: number }): SourceRequestEditAcquisition {
  if (input.authorship !== "human_authored") return { families: [], pairs: 0, rejected: [{ recordId: "", reason: "human_source_required" }] };
  const observations: Observation[] = [];
  const rejected: SourceRequestEditAcquisition["rejected"] = []; let pairs = 0;
  for (const document of input.documents) for (const reply of document.transcriptTurns ?? []) {
    const request = document.transcriptTurns?.find(turn => turn.index === reply.replyToTurnIndex);
    if (!request) continue;
    pairs++;
    if (!reply.sourceRecordId || reply.sourceRecordId !== request.sourceRecordId) {
      rejected.push({ recordId: reply.sourceRecordId ?? "", reason: "independent_record_owner_required" }); continue;
    }
    const spans = document.spans.filter(span => span.status === "promoted" && String(span.sourceVersionId) === document.sourceVersionId
      && String(span.contentHash) === `sha256_${input.hasher.digestHex(span.text)}`
      && span.charEnd - span.charStart === [...span.text].length && [request, reply].every(turn => turn.startCodePoint >= span.charStart
        && turn.endCodePoint <= span.charEnd && slice(span.text, turn.startCodePoint - span.charStart, turn.endCodePoint - span.charStart) === turn.surface));
    if (spans.length !== 1) { rejected.push({ recordId: reply.sourceRecordId, reason: "complete_pair_owner_evidence_required" }); continue; }
    const span = spans[0]!;
    observations.push({ request: request.surface, reply: reply.surface, profileId: document.profileId,
      ownership: canonicalStringify([document.languageIdentityId && document.languageIdentityDigest ? document.languageIdentityId : document.profileId,
        span.informationLabel ?? null]), witness: {
        sourceId: String(span.sourceId), sourceVersionId: String(span.sourceVersionId), contentHash: String(span.contentHash), evidenceId: String(span.id), recordId: reply.sourceRecordId, profileId: document.profileId,
        request: { startCodePoint: request.startCodePoint - span.charStart, endCodePoint: request.endCodePoint - span.charStart },
        reply: { startCodePoint: reply.startCodePoint - span.charStart, endCodePoint: reply.endCodePoint - span.charStart } } });
  }
  const result = acquire(observations, input.hasher, input.updatedAt);
  return { ...result, pairs, rejected: [...rejected, ...result.rejected] };
}

export interface LearnedSourceRequestEdit {
  request: SourceSpanCompletionRequest;
  patternIds: readonly string[];
  evidenceIds: readonly string[];
  responseExtent: "observed_full_reply";
  realize(evidence: readonly EvidenceSpan[]): string | undefined;
}
const verifiedLearnedEdits = new WeakSet<LearnedSourceRequestEdit>();

/** Recompile owned observations before admitting an executable construction from durable storage. */
export async function learnedSourceRequestEditForText(input: { storage: ScceStorage; requestText: string }): Promise<LearnedSourceRequestEdit | undefined> {
  const hasher = createHasher(), patterns = await input.storage.languageMemory.listLanguagePatterns({
    patternSchemas: [SOURCE_REQUEST_EDIT_SCHEMA], sourceEditRequestFeatures: featureSet(input.requestText, Number.MAX_SAFE_INTEGER),
    ...SOURCE_CONSTRUCTION_READ_BUDGET, requireComplete: true });
  if (patterns.length > SOURCE_CONSTRUCTION_READ_BUDGET.limit || canonicalJsonByteLength(patterns.map(pattern => pattern.patternJson),
    SOURCE_CONSTRUCTION_READ_BUDGET.maxTotalJsonBytes) > SOURCE_CONSTRUCTION_READ_BUDGET.maxTotalJsonBytes) throw Error("source request edit read exceeds complete artifact allowance");
  const matches: Array<{ family: Family; request: SourceSpanCompletionRequest }> = [];
  for (const pattern of patterns) {
    const body = record(pattern.patternJson);
    if (body?.schema !== SOURCE_REQUEST_EDIT_SCHEMA || !Array.isArray(body.witnesses)) continue;
    const owners = await input.storage.evidence.getEvidenceBatch(pattern.evidenceIds), observations: Observation[] = [];
    if (owners.length !== pattern.evidenceIds.length) continue;
    for (const candidate of body.witnesses) {
      const item = record(candidate);
      if (!item || ["sourceId", "sourceVersionId", "contentHash", "evidenceId", "recordId", "profileId"].some(key => typeof item[key] !== "string" || !item[key])) break;
      const witness = candidate as Witness, span = owners.find(owner => String(owner.id) === witness.evidenceId);
      if (!span || span.status !== "promoted" || String(span.sourceId) !== witness.sourceId || String(span.sourceVersionId) !== witness.sourceVersionId
        || String(span.contentHash) !== witness.contentHash || String(span.contentHash) !== `sha256_${hasher.digestHex(span.text)}`
        || !validRange(witness.request, [...span.text].length) || !validRange(witness.reply, [...span.text].length)) break;
      observations.push({ witness, request: at(span.text, witness.request), reply: at(span.text, witness.reply), profileId: witness.profileId,
        ownership: canonicalStringify(span.informationLabel ?? null) });
    }
    if (observations.length !== body.witnesses.length) continue;
    for (const family of acquire(observations, hasher, pattern.updatedAt).families) {
      const compiledBody = record(family.pattern.patternJson)!;
      if (family.pattern.id !== pattern.id || canonicalStringify(compiledBody) !== canonicalStringify(Object.fromEntries(
        Object.keys(compiledBody).map(key => [key, body[key]])))) continue;
      const request = parseRequest(input.requestText, family.input.constructions);
      if (request) matches.push({ family, request });
    }
  }
  const meanings = new Set(matches.map(match => canonicalStringify([match.request, match.family.output.constructions.map(construction =>
    construction.sequence.map(part => part.kind === "literal" ? part.surface : { role: part.roleId }))])));
  if (meanings.size !== 1) return undefined;
  const selected = matches[0]!;
  Object.freeze(selected.request.templateRange); Object.freeze(selected.request.gapRange); Object.freeze(selected.request);
  const learned: LearnedSourceRequestEdit = Object.freeze({ request: selected.request, responseExtent: "observed_full_reply" as const,
    patternIds: Object.freeze(matches.map(match => match.family.pattern.id)),
    evidenceIds: Object.freeze([...new Set(matches.flatMap(match => match.family.pattern.evidenceIds))]),
    realize: (evidence: readonly EvidenceSpan[]) => realize(selected.request, selected.family.output, evidence, hasher) });
  verifiedLearnedEdits.add(learned);
  return learned;
}

export function sourceRequestEditDependencies(patterns: readonly LanguagePatternRecord[]): NonNullable<LanguagePatternProjection["sourceDependencies"]> {
  const dependencies = new Map<string, NonNullable<LanguagePatternProjection["sourceDependencies"]>[number]>();
  for (const pattern of patterns) {
    const body = record(pattern.patternJson);
    if (body?.schema !== SOURCE_REQUEST_EDIT_SCHEMA || !Array.isArray(body.witnesses)) continue;
    for (const witness of body.witnesses as Witness[]) {
      const prior = dependencies.get(witness.sourceVersionId);
      if (prior && prior.sourceId !== witness.sourceId) throw Error("conflicting source edit ownership");
      dependencies.set(witness.sourceVersionId, { sourceId: witness.sourceId as EvidenceSpan["sourceId"],
        sourceVersionId: witness.sourceVersionId as EvidenceSpan["sourceVersionId"],
        evidenceIds: [...new Set([...(prior?.evidenceIds ?? []), witness.evidenceId as EvidenceSpan["id"]])] });
    }
  }
  return [...dependencies.values()];
}

export interface SourceRequestEditResponseProgram { readonly schema: "scce.bound_source_request_edit_response.v1"; readonly patternIds: readonly string[]; }
const verifiedPrograms = new WeakMap<SourceRequestEditResponseProgram, { factIdentity: string; learned: LearnedSourceRequestEdit; evidence: readonly EvidenceSpan[] }>();
function factIdentity(fact: SemanticAnswerConstructFact): string {
  return canonicalStringify([fact.subject, fact.predicate, fact.object, fact.relationId, fact.requestedSlotId, fact.relationRoleId,
    fact.sourceVersionId, fact.sourceSpan, fact.evidenceIds]);
}
export function bindSourceRequestEditResponse(learned: LearnedSourceRequestEdit | undefined, fact: SemanticAnswerConstructFact,
  evidence: readonly EvidenceSpan[]): SourceRequestEditResponseProgram | undefined {
  if (!learned) return undefined;
  const program: SourceRequestEditResponseProgram = Object.freeze({ schema: "scce.bound_source_request_edit_response.v1", patternIds: Object.freeze([...learned.patternIds]) });
  if (verifiedLearnedEdits.has(learned) && sourceSpanCompletionRangeCurrent({ ...fact, value: fact.object, requestedRoleId: fact.relationRoleId,
    evidenceIds: fact.evidenceIds ?? [] }, evidence) && learned.realize(evidence)) {
    verifiedPrograms.set(program, { factIdentity: factIdentity(fact), learned, evidence: structuredClone(evidence) });
  }
  return program;
}
export function sourceRequestEditResponseForContract(contract: Pick<SemanticRealizationContract, "sourceFact" | "responseProgram">,
  evidence?: readonly EvidenceSpan[]): string | undefined {
  const bound = contract.responseProgram ? verifiedPrograms.get(contract.responseProgram) : undefined;
  return bound && bound.factIdentity === factIdentity(contract.sourceFact) ? bound.learned.realize(evidence ?? bound.evidence) : undefined;
}
function validRange(value: unknown, length: number): value is Range {
  const row = record(value);
  return Boolean(row && Number.isSafeInteger(row.startCodePoint) && Number.isSafeInteger(row.endCodePoint)
    && (row.startCodePoint as number) >= 0 && (row.endCodePoint as number) > (row.startCodePoint as number) && (row.endCodePoint as number) <= length);
}
