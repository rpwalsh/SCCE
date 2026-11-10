// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { GraphQLError, type GraphQLFieldResolver } from "graphql";
import type { EvidenceId, EvidenceSpan, JsonValue, ScceStorage, SourceVersionId } from "@scce/kernel";
import { ApplicationError, TurnApplication, type ApplicationTurnInput } from "./turn-application.js";
import type { TurnTaskFrame, TurnTaskSnapshot } from "./turn-task-registry.js";

export interface LocalGraphqlServices {
  scope: string;
  generation: string;
  turns: TurnApplication;
  storage: ScceStorage;
  readiness(): { phase: string; ok: boolean } | Promise<{ phase: string; ok: boolean }>;
}
export interface LocalGraphqlContext { services: LocalGraphqlServices; signal: AbortSignal; nodes: Map<string, Promise<unknown>> }
const nodeTypes = ["TurnTask", "TurnResult", "TurnFrame", "SourceVersion", "EvidenceSpan"];

export function localNodeId(scope: string, type: string, key: string): string {
  return Buffer.from(JSON.stringify([1, scope, type, key])).toString("base64url");
}
export function decodeLocalNodeId(scope: string, id: string, type?: string): { type: string; key: string } {
  const parts = unpack(id);
  if (parts.length !== 4 || parts[0] !== 1 || parts[1] !== scope || !nodeTypes.includes(String(parts[2]))
    || typeof parts[3] !== "string" || !parts[3] || (type && type !== parts[2])) throw badId();
  return { type: String(parts[2]), key: parts[3] };
}

/** Per-operation batching preserves input order and duplicate IDs without a resident entity cache. */
async function nodes(context: LocalGraphqlContext, ids: string[]): Promise<unknown[]> {
  if (ids.length > 64) throw new ApplicationError("RESOURCE_LIMIT", "nodes accepts at most 64 identifiers");
  const missing = [...new Set(ids)].filter(id => !context.nodes.has(id));
  const decoded = missing.map(id => ({ id, ...decodeLocalNodeId(context.services.scope, id) }));
  const evidence = decoded.filter(node => node.type === "EvidenceSpan");
  if (evidence.length) {
    const batch = context.services.storage.evidence.getEvidenceBatch(evidence.map(node => node.key as EvidenceId));
    for (const node of evidence) context.nodes.set(node.id, batch.then(rows => {
      const row = rows.find(row => String(row.id) === node.key);
      return row?.status === "promoted" ? { ...row, __typename: "EvidenceSpan", id: node.id } : null;
    }));
  }
  for (const node of decoded.filter(node => node.type !== "EvidenceSpan")) {
    context.nodes.set(node.id, loadNode(context, node));
  }
  return Promise.all(ids.map(id => context.nodes.get(id)!));
}

async function loadNode(context: LocalGraphqlContext, node: { id: string; type: string; key: string }): Promise<unknown> {
  const { services } = context;
  if (node.type === "SourceVersion") {
    const source = await services.storage.evidence.sourceVersionById?.(node.key as SourceVersionId);
    return source ? { ...source, __typename: node.type, id: node.id } : null;
  }
  let taskKey = node.key;
  let sequence: number | undefined;
  if (node.type === "TurnFrame") {
    const split = node.key.lastIndexOf(":");
    taskKey = node.key.slice(0, split);
    sequence = Number(node.key.slice(split + 1));
    if (split < 1 || !Number.isSafeInteger(sequence) || sequence < 1) throw badId();
  }
  const task = await services.turns.get(taskKey);
  if (!task) return null;
  if (node.type === "TurnTask") return taskNode(services, task);
  if (node.type === "TurnResult") return resultNode(services, task);
  const frame = task.frames.find(frame => frame.sequence === sequence);
  return frame ? frameNode(services, frame) : null;
}

export function taskNode(services: LocalGraphqlServices, task: TurnTaskSnapshot) {
  return { ...task, __typename: "TurnTask", id: localNodeId(services.scope, "TurnTask", task.taskId) };
}
function resultNode(services: LocalGraphqlServices, task: TurnTaskSnapshot) {
  const frame = task.frames.filter(frame => ["result", "error", "cancelled"].includes(frame.type)).at(-1);
  if (!frame) return null;
  const value = frame.value && typeof frame.value === "object" && !Array.isArray(frame.value)
    ? frame.value as Record<string, JsonValue> : {};
  return { __typename: "TurnResult", id: localNodeId(services.scope, "TurnResult", task.taskId),
    answer: typeof value.answer === "string" ? value.answer : null,
    episodeId: typeof value.episodeId === "string" ? value.episodeId : null,
    error: frame.error ?? (typeof value.error === "string" ? value.error : null), httpStatus: frame.status };
}
function frameNode(services: LocalGraphqlServices, frame: TurnTaskFrame) {
  return { ...frame, __typename: "TurnFrame", id: localNodeId(services.scope, "TurnFrame", `${frame.taskId}:${frame.sequence}`), kind: frame.type };
}

function frames(context: LocalGraphqlContext, task: TurnTaskSnapshot, first: number, after?: string) {
  if (!Number.isInteger(first) || first < 1 || first > 50) throw new ApplicationError("RESOURCE_LIMIT", "page size must be between 1 and 50");
  let sequence = 0;
  const { services } = context;
  if (after) {
    const cursor = unpack(after);
    if (cursor.length !== 6 || cursor[0] !== 1 || cursor[1] !== services.scope || cursor[2] !== services.generation
      || cursor[3] !== "frames" || cursor[4] !== task.taskId || typeof cursor[5] !== "number"
      || !Number.isSafeInteger(cursor[5]) || cursor[5] < 0 || cursor[5] > task.latestSequence) {
      throw new ApplicationError("INVALID_CURSOR", "cursor does not belong to this task and server generation");
    }
    sequence = cursor[5];
  }
  const page = task.frames.filter(frame => frame.sequence > sequence).slice(0, first);
  const edges = page.map(frame => ({ node: frameNode(services, frame), cursor: Buffer.from(JSON.stringify([
    1, services.scope, services.generation, "frames", task.taskId, frame.sequence
  ])).toString("base64url") }));
  return { edges, pageInfo: { hasPreviousPage: sequence > 0,
    hasNextPage: (page.at(-1)?.sequence ?? sequence) < task.latestSequence,
    startCursor: edges[0]?.cursor ?? null, endCursor: edges.at(-1)?.cursor ?? null } };
}

export const localFieldResolver: GraphQLFieldResolver<any, LocalGraphqlContext> = async (source, args, context, info) => {
  try {
    const { services } = context;
    if (info.parentType.name === "Query") {
      if (info.fieldName === "runtime") {
        const readiness = await services.readiness();
        return { protocolVersion: "scce.graphql.v1", generation: services.generation, phase: readiness.phase, ready: readiness.ok };
      }
      if (info.fieldName === "nodes") return await nodes(context, args.ids);
      if (info.fieldName === "turnTask") decodeLocalNodeId(services.scope, args.id, "TurnTask");
      return (await nodes(context, [args.id]))[0];
    }
    if (info.parentType.name === "Mutation") {
      const input = args.input;
      let task: TurnTaskSnapshot;
      if (info.fieldName === "reserveTurn") task = await services.turns.reserve();
      else {
        const key = decodeLocalNodeId(services.scope, input.operationId ?? input.taskId, "TurnTask").key;
        if (info.fieldName === "cancelTurn") task = await services.turns.cancel(key);
        else {
          const turn: ApplicationTurnInput = { text: input.text,
            ...(input.sessionId == null ? {} : { sessionId: input.sessionId }),
            ...(input.conversationId == null ? {} : { conversationId: input.conversationId }),
            ...(input.requestedAuthority == null ? {} : { requestedAuthority: input.requestedAuthority }) };
          task = await services.turns.start(key, turn);
        }
      }
      return { task: taskNode(services, task), clientMutationId: input.clientMutationId };
    }
    if (info.parentType.name === "TurnTask") {
      if (info.fieldName === "frames") return frames(context, source, args.first, args.after);
      if (info.fieldName === "result") return resultNode(services, source);
      if (info.fieldName === "latestFrame") {
        const frame = (source as TurnTaskSnapshot).frames.at(-1);
        return frame ? frameNode(services, frame) : null;
      }
    }
    if (info.parentType.name === "EvidenceSpan" && info.fieldName === "sourceVersion") {
      return (await nodes(context, [localNodeId(services.scope, "SourceVersion", (source as EvidenceSpan).sourceVersionId)]))[0];
    }
    return source?.[info.fieldName];
  } catch (error) {
    if (error instanceof ApplicationError) throw new GraphQLError(error.message, { extensions: { code: error.code } });
    throw error;
  }
};

export async function* localTaskSubscription(_source: unknown, args: { id: string; afterSequence: number }, context: LocalGraphqlContext) {
  if (args.afterSequence < 0) throw new ApplicationError("INVALID_CURSOR", "negative task sequence");
  const key = decodeLocalNodeId(context.services.scope, args.id, "TurnTask").key;
  for await (const task of context.services.turns.updates(key, args.afterSequence, context.signal)) {
    // Each payload has an isolated loader cache; changes cannot reuse stale refetch results.
    context.nodes.clear();
    yield { turnTaskUpdated: taskNode(context.services, task) };
  }
}
function unpack(value: string): unknown[] {
  if (typeof value !== "string" || value.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw badId();
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw badId();
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(parsed)) throw badId();
    return parsed;
  } catch { throw badId(); }
}
function badId() { return new ApplicationError("BAD_ID", "invalid local object identifier"); }
