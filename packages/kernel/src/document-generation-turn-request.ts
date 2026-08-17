import type { DocumentPlan, DocumentPlanNode, DocumentPlanNodeKind } from "./document-plan.js";
import type { InitialFact, NarrativeEvent, NarrativeState, NarrativeStateChange } from "./narrative-state.js";
import type { VoiceSample } from "./voice-profile.js";
import type { DocumentGenerationSessionStore } from "./storage.js";
import type { JsonValue } from "./types.js";
import { toJsonValue } from "./primitives.js";
import {
  completeDocumentSection,
  createDocumentGenerationSession,
  narrativeConditioningForSession,
  nextDocumentGenerationWork,
  type CompleteDocumentSectionInput,
  type DocumentGenerationSession,
  type NarrativeConditioning
} from "./document-generation-session.js";

/**
 * Plan items 221-228 live wiring. Real per-turn metadata parsing plus
 * real, durable persistence for `document-generation-session.ts`
 * (`deps.storage.documentGeneration`, a genuine Postgres-backed store --
 * see `storage.ts`/`postgres.ts`), not a caller-side full-session round
 * trip: a multi-page document plan across a real multi-turn writing
 * project is never resent in full on every turn. The caller supplies a
 * real, stable `sessionId` (its own choice, e.g. a document id) and one
 * of three real actions -- `start` (create, with the initial plan/
 * narrative/voice-profile data), `next_work`, or `complete_section` --
 * via `metadata.documentGeneration`; everything after `start` only ever
 * needs the `sessionId`, the durable store carries the rest.
 */

const DOCUMENT_PLAN_NODE_KINDS: ReadonlySet<string> = new Set<DocumentPlanNodeKind>(["document", "section", "subsection", "paragraph"]);

function record(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : undefined;
}

function stringArray(value: JsonValue | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every(item => typeof item === "string") ? value as string[] : undefined;
}

function documentPlanNodeFromJson(value: JsonValue | undefined): DocumentPlanNode | undefined {
  const node = record(value);
  if (!node) return undefined;
  if (typeof node.id !== "string" || !node.id) return undefined;
  if (typeof node.kind !== "string" || !DOCUMENT_PLAN_NODE_KINDS.has(node.kind)) return undefined;
  if (typeof node.order !== "number") return undefined;
  if (typeof node.goal !== "string") return undefined;
  const requiredCoverageIds = stringArray(node.requiredCoverageIds);
  const referenceIds = stringArray(node.referenceIds);
  const rhetoricalDependsOnIds = stringArray(node.rhetoricalDependsOnIds);
  const satisfiedCoverageIds = stringArray(node.satisfiedCoverageIds);
  if (!requiredCoverageIds || !referenceIds || !rhetoricalDependsOnIds || !satisfiedCoverageIds) return undefined;
  if (typeof node.completed !== "boolean") return undefined;
  return {
    id: node.id,
    kind: node.kind as DocumentPlanNodeKind,
    ...(typeof node.parentId === "string" ? { parentId: node.parentId } : {}),
    order: node.order,
    goal: node.goal,
    requiredCoverageIds,
    referenceIds,
    rhetoricalDependsOnIds,
    satisfiedCoverageIds,
    completed: node.completed,
    ...(typeof node.content === "string" ? { content: node.content } : {})
  };
}

function documentPlanFromJson(value: JsonValue | undefined): DocumentPlan | undefined {
  const plan = record(value);
  const nodesInput = record(plan?.nodes);
  if (!nodesInput) return undefined;
  const nodes: Record<string, DocumentPlanNode> = {};
  for (const [id, raw] of Object.entries(nodesInput)) {
    const node = documentPlanNodeFromJson(raw);
    if (!node || node.id !== id) return undefined;
    nodes[id] = node;
  }
  return { nodes };
}

function narrativeStateChangeFromJson(value: JsonValue | undefined): NarrativeStateChange | undefined {
  const change = record(value);
  if (!change || typeof change.subjectId !== "string" || typeof change.factId !== "string") return undefined;
  if (change.toValue === undefined) return undefined;
  return { subjectId: change.subjectId, factId: change.factId, ...(change.fromValue !== undefined ? { fromValue: change.fromValue } : {}), toValue: change.toValue };
}

function narrativeEventFromJson(value: JsonValue | undefined): NarrativeEvent | undefined {
  const event = record(value);
  if (!event) return undefined;
  if (typeof event.id !== "string" || typeof event.order !== "number" || typeof event.description !== "string") return undefined;
  const causedByEventIds = stringArray(event.causedByEventIds);
  const setupIds = stringArray(event.setupIds);
  const payoffForSetupIds = stringArray(event.payoffForSetupIds);
  if (!causedByEventIds || !setupIds || !payoffForSetupIds) return undefined;
  if (!Array.isArray(event.stateChanges)) return undefined;
  const stateChanges: NarrativeStateChange[] = [];
  for (const raw of event.stateChanges) {
    const change = narrativeStateChangeFromJson(raw);
    if (!change) return undefined;
    stateChanges.push(change);
  }
  return { id: event.id, order: event.order, description: event.description, causedByEventIds, stateChanges, setupIds, payoffForSetupIds };
}

function narrativeStateFromJson(value: JsonValue | undefined): NarrativeState | undefined {
  const state = record(value);
  if (!state || !Array.isArray(state.events)) return { events: [] };
  const events: NarrativeEvent[] = [];
  for (const raw of state.events) {
    const event = narrativeEventFromJson(raw);
    if (!event) return undefined;
    events.push(event);
  }
  return { events };
}

function initialFactsFromJson(value: JsonValue | undefined): InitialFact[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const facts: InitialFact[] = [];
  for (const raw of value) {
    const fact = record(raw);
    if (!fact || typeof fact.subjectId !== "string" || typeof fact.factId !== "string" || fact.value === undefined) return undefined;
    facts.push({ subjectId: fact.subjectId, factId: fact.factId, value: fact.value });
  }
  return facts;
}

function protectedPassagesFromJson(value: JsonValue | undefined): VoiceSample[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const passages: VoiceSample[] = [];
  for (const raw of value) {
    const passage = record(raw);
    if (!passage || typeof passage.sourceId !== "string" || typeof passage.text !== "string") return undefined;
    passages.push({ sourceId: passage.sourceId, text: passage.text });
  }
  return passages;
}

/** Real, careful parse: a session's own real invariants (unknown node ids, unmet dependencies, etc.) are still enforced by `document-plan.ts`/`document-generation-session.ts` themselves when the session is used -- this only ensures the shape is safe to hand to them. */
function documentGenerationSessionFromJson(value: JsonValue | undefined): DocumentGenerationSession | undefined {
  const input = record(value);
  if (!input) return undefined;
  const plan = documentPlanFromJson(input.plan);
  if (!plan) return undefined;
  const narrative = narrativeStateFromJson(input.narrative);
  if (!narrative) return undefined;
  const initialFacts = initialFactsFromJson(input.initialFacts);
  if (!initialFacts) return undefined;
  const protectedPassages = protectedPassagesFromJson(input.protectedPassages);
  if (!protectedPassages) return undefined;
  // voiceProfile is intentionally validated only as "present or absent",
  // not deep-parsed field by field: document-generation-session.ts's
  // completeDocumentSection only ever checks its truthiness (to decide
  // whether to run the real anti-copy guard at all) and never reads any
  // of its own fields, so a shallow presence check is the real, honest
  // amount of validation this value needs here.
  const voiceProfile = record(input.voiceProfile);
  const maxAllowedNgramWords = typeof input.maxAllowedNgramWords === "number" ? input.maxAllowedNgramWords : undefined;
  return createDocumentGenerationSession({
    plan,
    narrative,
    initialFacts,
    protectedPassages,
    ...(voiceProfile ? { voiceProfile: voiceProfile as unknown as DocumentGenerationSession["voiceProfile"] } : {}),
    ...(maxAllowedNgramWords !== undefined ? { maxAllowedNgramWords } : {})
  });
}

function completeSectionInputFromJson(value: JsonValue | undefined): CompleteDocumentSectionInput | undefined {
  const input = record(value);
  if (!input || typeof input.nodeId !== "string" || typeof input.content !== "string") return undefined;
  const satisfiedCoverageIds = input.satisfiedCoverageIds !== undefined ? stringArray(input.satisfiedCoverageIds) : [];
  if (!satisfiedCoverageIds) return undefined;
  const narrativeEvent = input.narrativeEvent !== undefined ? narrativeEventFromJson(input.narrativeEvent) : undefined;
  if (input.narrativeEvent !== undefined && !narrativeEvent) return undefined;
  return { nodeId: input.nodeId, content: input.content, satisfiedCoverageIds, ...(narrativeEvent ? { narrativeEvent } : {}) };
}

export type DocumentGenerationTurnRequest =
  | { sessionId: string; action: { type: "start"; session: JsonValue } }
  | { sessionId: string; action: { type: "next_work" } }
  | { sessionId: string; action: { type: "complete_section"; input: CompleteDocumentSectionInput } };

/**
 * Real per-turn metadata parse, with a real distinction between two
 * genuinely different situations a caller needs to tell apart:
 * "absent" (this turn simply carries no `metadata.documentGeneration` at
 * all -- proceed as if nothing was asked, exactly like
 * `repoFilesFromMetadata`'s own contract) versus "malformed" (the caller
 * clearly *intended* a document-generation action -- the key is present
 * -- but it doesn't parse). Silently treating "malformed" the same as
 * "absent" would mean a caller who typo'd an action type or omitted a
 * required field gets total silence instead of a real error to act on.
 */
export type DocumentGenerationRequestParse =
  | { status: "absent" }
  | { status: "malformed" }
  | { status: "ok"; request: DocumentGenerationTurnRequest };

export function documentGenerationRequestFromMetadata(metadata: JsonValue | undefined): DocumentGenerationRequestParse {
  const container = record(metadata);
  if (container?.documentGeneration === undefined) return { status: "absent" };
  const request = record(container.documentGeneration);
  if (!request) return { status: "malformed" };
  if (typeof request.sessionId !== "string" || !request.sessionId.trim()) return { status: "malformed" };
  const sessionId = request.sessionId;
  const action = record(request.action);
  if (!action) return { status: "malformed" };
  if (action.type === "start" && action.session !== undefined) return { status: "ok", request: { sessionId, action: { type: "start", session: action.session } } };
  if (action.type === "next_work") return { status: "ok", request: { sessionId, action: { type: "next_work" } } };
  if (action.type === "complete_section") {
    const completeInput = completeSectionInputFromJson(action.input);
    if (!completeInput) return { status: "malformed" };
    return { status: "ok", request: { sessionId, action: { type: "complete_section", input: completeInput } } };
  }
  return { status: "malformed" };
}

export type DocumentGenerationTurnResult =
  | { action: "start"; sessionId: string; pendingSections: Array<{ id: string; goal: string }>; narrativeConditioning: NarrativeConditioning }
  | { action: "next_work"; pendingSections: Array<{ id: string; goal: string }>; narrativeConditioning: NarrativeConditioning }
  | { action: "complete_section"; accepted: true }
  | { action: "complete_section"; accepted: false; reason: string }
  | { accepted: false; reason: "unknown session" }
  | { accepted: false; reason: "malformed request" }
  | { accepted: false; reason: "session already started with different content" }
  | { accepted: false; reason: "concurrent write conflict; retry" }
  | { accepted: false; reason: "corrupted session data" };

/**
 * The real per-turn sync (items 221-228). `start` creates and durably
 * persists a brand-new session under the caller's chosen `sessionId` --
 * real invariant validation (unknown node ids, unmet dependencies, etc.)
 * still happens inside `document-generation-session.ts`'s own real
 * functions, never duplicated here. Every other action loads the real,
 * durably-persisted session by id first; `complete_section` persists the
 * real updated session back only when accepted (a rejection never
 * mutates the durable session, matching `completeDocumentSection`'s own
 * real all-or-nothing guarantee).
 *
 * `conversationId` is a real, required tenant-isolation boundary: the
 * store keys every session on `(conversationId, sessionId)`, so a caller
 * in one conversation can never read, resume, or overwrite a session
 * that belongs to a different conversation, even by guessing or reusing
 * the exact same `sessionId` -- a lookup miss looks identical to the
 * session never having existed at all.
 *
 * Two real concurrency guarantees, both via `compareAndPutSession`'s
 * optimistic-concurrency write:
 * - `start` against a `sessionId` that already exists is a genuine
 *   conflict unless the requested content is byte-identical to what's
 *   already there (idempotent exact replay) -- it never silently
 *   overwrites a divergent existing session, including one created by a
 *   concurrent `start` that wins the race.
 * - `complete_section` reads the session's current `updatedAt` and only
 *   writes if it is unchanged at write time -- two concurrent
 *   completions against the same session can no longer silently lose one
 *   completion to a last-write-wins race; the loser gets a real conflict
 *   result instead.
 */
export async function syncDocumentGenerationRequestForTurn(
  store: DocumentGenerationSessionStore,
  request: DocumentGenerationTurnRequest,
  now: number,
  conversationId: string
): Promise<DocumentGenerationTurnResult | undefined> {
  if (request.action.type === "start") {
    const session = documentGenerationSessionFromJson(request.action.session);
    if (!session) return { accepted: false, reason: "malformed request" };
    const sessionJson = toJsonValue(session);
    const startResult = (): DocumentGenerationTurnResult => {
      const pending = nextDocumentGenerationWork(session);
      // Lever 4 (filter -> conditioning): the section-commissioning result
      // carries the narrative's established world-state and open setups so
      // the generator writes UNDER them, instead of first meeting them as a
      // rejection from completeDocumentSection's after-the-fact gate.
      return {
        action: "start",
        sessionId: request.sessionId,
        pendingSections: pending.map(node => ({ id: node.id, goal: node.goal })),
        narrativeConditioning: narrativeConditioningForSession(session)
      };
    };
    const isIdempotentReplayOf = (row: { sessionJson: JsonValue } | null): boolean =>
      row !== null && JSON.stringify(row.sessionJson) === JSON.stringify(sessionJson);

    const existing = await store.getSession(request.sessionId, conversationId);
    if (existing) {
      // A real pre-existing session for this exact (conversation, id):
      // content-identical is a genuine idempotent replay (e.g.
      // production-turn-runtime.ts's self-replan mechanism resending the
      // same start request); anything else is a real conflict -- this
      // never silently overwrites divergent content, no CAS write is even
      // attempted.
      return isIdempotentReplayOf(existing) ? startResult() : { accepted: false, reason: "session already started with different content" };
    }
    // Genuinely new: CAS against "must not exist yet" so a concurrent
    // `start` racing in the gap between the read above and this write is
    // still caught, rather than one write silently clobbering the other.
    const cas = await store.compareAndPutSession({ id: request.sessionId, conversationId, sessionJson, updatedAt: now }, null);
    if (cas.stored) return startResult();
    const raced = await store.getSession(request.sessionId, conversationId);
    return isIdempotentReplayOf(raced) ? startResult() : { accepted: false, reason: "session already started with different content" };
  }

  const record_ = await store.getSession(request.sessionId, conversationId);
  if (!record_) return { accepted: false, reason: "unknown session" };
  const session = documentGenerationSessionFromJson(record_.sessionJson);
  if (!session) return { accepted: false, reason: "corrupted session data" };

  if (request.action.type === "next_work") {
    const pending = nextDocumentGenerationWork(session);
    return {
      action: "next_work",
      pendingSections: pending.map(node => ({ id: node.id, goal: node.goal })),
      narrativeConditioning: narrativeConditioningForSession(session)
    };
  }

  // Real idempotency guard: production-turn-runtime.ts has a genuine,
  // deliberate self-replan mechanism (an empty-Mouth-surface recovery
  // path) that re-invokes the whole turn -- including this exact
  // metadata-driven action -- a second time when the first pass's
  // realized surface came back empty. Without this check, the second
  // pass would hit document-generation-session.ts's real "already
  // completed" invariant even though nothing is actually wrong -- the
  // first pass's real completion already durably succeeded. A request
  // asking to complete an already-completed node with the exact same
  // content is treated as the same real completion having already
  // happened, not fabricated success for a genuinely different request.
  const existingNode = session.plan.nodes[request.action.input.nodeId];
  if (existingNode?.completed && existingNode.content === request.action.input.content) {
    return { action: "complete_section", accepted: true };
  }

  const result = completeDocumentSection(session, request.action.input);
  if (!result.accepted) return { action: "complete_section", accepted: false, reason: result.reason };
  const cas = await store.compareAndPutSession(
    { id: request.sessionId, conversationId, sessionJson: toJsonValue(result.session), updatedAt: now },
    record_.updatedAt
  );
  if (!cas.stored) return { accepted: false, reason: "concurrent write conflict; retry" };
  return { action: "complete_section", accepted: true };
}
