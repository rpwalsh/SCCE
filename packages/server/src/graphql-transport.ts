// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type http from "node:http";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import {
  buildSchema, execute, getOperationAST, GraphQLError, Kind, parse, subscribe, validate,
  type DocumentNode, type ExecutionResult, type GraphQLSchema, type SelectionSetNode
} from "graphql";
import { ApplicationError } from "./turn-application.js";
import { localFieldResolver, localTaskSubscription, type LocalGraphqlContext, type LocalGraphqlServices } from "./graphql-schema.js";

export const LOCAL_GRAPHQL_PROTOCOL = "scce.graphql.v1";
export type OperationDocuments = Record<string, string>;
export const localGraphqlSchema = buildSchema(readFileSync(new URL("../schema.graphql", import.meta.url), "utf8"));
const subscriptionField = localGraphqlSchema.getSubscriptionType()!.getFields().turnTaskUpdated!;
subscriptionField.subscribe = localTaskSubscription;
subscriptionField.resolve = payload => payload.turnTaskUpdated;

/** Documents are compiled with Relay and installed with the application, never supplied by a request. */
export function compileLocalOperations(documents: OperationDocuments, schema = localGraphqlSchema): ReadonlyMap<string, DocumentNode> {
  if (Object.keys(documents).length > 128) throw new Error("too many registered GraphQL documents");
  const compiled = new Map<string, DocumentNode>();
  for (const [name, text] of Object.entries(documents)) {
    if (text.length > 24_576) throw new Error(`GraphQL document ${name} exceeds byte budget`);
    const document = parse(text, { maxTokens: 4096 });
    const errors = validate(schema, document);
    if (errors.length) throw new Error(`${name}: ${errors.map(error => error.message).join("; ")}`);
    const operation = getOperationAST(document, name);
    if (!operation || document.definitions.filter(node => node.kind === Kind.OPERATION_DEFINITION).length !== 1) {
      throw new Error(`expected exactly one named operation ${name}`);
    }
    if (operation.operation === "mutation" && operation.selectionSet.selections.length !== 1) throw new Error("one command per mutation document");
    validateWork(document, operation.selectionSet);
    compiled.set(name, document);
  }
  return compiled;
}

export interface LocalGraphqlHandler {
  (req: http.IncomingMessage, res: http.ServerResponse, body: unknown, requestId: string): Promise<void>;
}
export function createLocalGraphqlHandler(services: LocalGraphqlServices, documents: OperationDocuments): LocalGraphqlHandler {
  const operations = compileLocalOperations(documents);
  let activeSubscriptions = 0;
  return async (req, res, body, requestId) => {
    const controller = new AbortController();
    const closed = () => controller.abort();
    res.once("close", closed);
    let streaming = false;
    try {
      const envelope = validateEnvelope(body, services.generation);
      const document = operations.get(envelope.operationName);
      if (!document) throw new ApplicationError("UNKNOWN_OPERATION", "operation is not registered in this application build");
      const operation = getOperationAST(document, envelope.operationName)!;
      if (operation.operation !== "query" && envelope.generation !== services.generation) {
        throw new ApplicationError("STALE_GENERATION", "refresh local runtime status before issuing a command");
      }
      const context: LocalGraphqlContext = { services, signal: controller.signal, nodes: new Map() };
      const args = { schema: localGraphqlSchema, document, operationName: envelope.operationName,
        variableValues: envelope.variables, contextValue: context, fieldResolver: localFieldResolver };
      if (operation.operation === "subscription") {
        if (!String(req.headers.accept ?? "").includes("text/event-stream")) throw new ApplicationError("BAD_TRANSPORT", "subscriptions require text/event-stream");
        if (activeSubscriptions >= 8) throw new ApplicationError("RESOURCE_LIMIT", "eight subscriptions are already active");
        activeSubscriptions++;
        try {
          const result = await subscribe(args);
          res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store",
            "x-accel-buffering": "no", "x-request-id": requestId });
          res.flushHeaders();
          streaming = true;
          if (Symbol.asyncIterator in result) {
            for await (const payload of result) {
              if (controller.signal.aborted) break;
              await writeEvent(res, "next", decorate(payload, services.generation, requestId), controller.signal);
            }
          } else await writeEvent(res, "next", decorate(result, services.generation, requestId), controller.signal);
          if (!controller.signal.aborted) await writeEvent(res, "complete", {}, controller.signal);
        } finally { activeSubscriptions--; }
      } else {
        const result = await execute(args);
        const text = JSON.stringify(decorate(result, services.generation, requestId));
        if (Buffer.byteLength(text) > 1024 * 1024) throw new ApplicationError("RESOURCE_LIMIT", "GraphQL response exceeds one MiB");
        res.writeHead(200, { "content-type": "application/graphql-response+json; charset=utf-8", "cache-control": "no-store", "x-request-id": requestId });
        res.end(text);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const payload = decorate({ errors: [new GraphQLError(error instanceof Error ? error.message : "local operation failed", {
        extensions: { code: error instanceof ApplicationError ? error.code : "INTERNAL_ERROR" }
      })] }, services.generation, requestId);
      if (streaming) await writeEvent(res, "next", payload, controller.signal);
      else {
        res.writeHead(400, { "content-type": "application/graphql-response+json; charset=utf-8", "cache-control": "no-store", "x-request-id": requestId });
        res.end(JSON.stringify(payload));
      }
    } finally {
      res.off("close", closed);
      controller.abort();
      if (!res.writableEnded) res.end();
    }
  };
}

function validateEnvelope(body: unknown, generation: string) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApplicationError("BAD_ENVELOPE", "operation envelope must be an object");
  const envelope = body as Record<string, unknown>;
  if (Object.keys(envelope).some(key => !["protocolVersion", "operationName", "variables", "generation"].includes(key))
    || envelope.protocolVersion !== LOCAL_GRAPHQL_PROTOCOL || typeof envelope.operationName !== "string"
    || envelope.operationName.length > 128 || (envelope.generation !== undefined && typeof envelope.generation !== "string")
    || (envelope.variables !== undefined && (!envelope.variables || typeof envelope.variables !== "object" || Array.isArray(envelope.variables)))) {
    throw new ApplicationError("BAD_ENVELOPE", "invalid local GraphQL operation envelope");
  }
  if (envelope.generation !== undefined && envelope.generation !== generation) throw new ApplicationError("STALE_GENERATION", "server generation changed");
  const variables = (envelope.variables ?? {}) as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(variables)) > 65_536) throw new ApplicationError("RESOURCE_LIMIT", "variables exceed 64 KiB");
  return { operationName: envelope.operationName, variables, generation: envelope.generation };
}
function decorate(result: ExecutionResult, generation: string, requestId: string) {
  return { ...result, extensions: { protocolVersion: LOCAL_GRAPHQL_PROTOCOL, generation, requestId } };
}
async function writeEvent(res: http.ServerResponse, event: string, value: unknown, signal: AbortSignal) {
  const text = `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
  if (Buffer.byteLength(text) > 1024 * 1024) throw new ApplicationError("RESOURCE_LIMIT", "subscription frame exceeds one MiB");
  if (!res.destroyed && !res.writableEnded && !res.write(text)) {
    try { await once(res, "drain", { signal }); } catch { /* disconnected subscriber */ }
  }
}
function validateWork(document: DocumentNode, root: SelectionSetNode) {
  const fragments = new Map(document.definitions.filter(definition => definition.kind === Kind.FRAGMENT_DEFINITION).map(definition => [definition.name.value, definition.selectionSet]));
  let fields = 0;
  function walk(set: SelectionSetNode, depth: number): void {
    if (depth > 12) throw new Error("GraphQL document exceeds depth budget");
    for (const selection of set.selections) {
      if (++fields > 256) throw new Error("GraphQL document exceeds total selection budget");
      if (selection.kind === Kind.FRAGMENT_SPREAD) walk(fragments.get(selection.name.value)!, depth + 1);
      else if (selection.selectionSet) walk(selection.selectionSet, depth + 1);
    }
  }
  walk(root, 0);
}
