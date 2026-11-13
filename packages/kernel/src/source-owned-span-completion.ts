// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { RequestValueBinding, RequestValueResolver, ResolvedRequestValue } from "./semantic-answer-construct.js";
import type { EvidenceSpan, GraphNode, Hasher, Hyperedge } from "./types.js";
import type { TypedProofScope } from "./typed-proof-scope.js";
import { canonicalStringify } from "./primitives.js";
import { evidenceProofBoundary } from "./proof-boundary.js";

export const SOURCE_SPAN_COMPLETION_REQUEST_SCHEMA = "scce.source_span_completion_request.v1" as const;
export const SOURCE_SPAN_COMPLETION_RELATION_ID = "relation.source_span_completion" as const;
export const SOURCE_SPAN_COMPLETION_ROLE_ID = "role.source_span_completion.value" as const;

export interface SourceSpanCompletionDeclaration {
  schema: typeof SOURCE_SPAN_COMPLETION_REQUEST_SCHEMA;
  requestText?: string;
  templateRange: { startCodePoint: number; endCodePoint: number };
  gapRange: { startCodePoint: number; endCodePoint: number };
  sourceVersionIds?: readonly string[];
  evidenceIds?: readonly string[];
}

export interface SourceSpanCompletionRequest extends SourceSpanCompletionDeclaration { requestText: string; }

export interface SourceSpanCompletionRange {
  evidenceId: string;
  contextStartCodePoint: number;
  contextEndCodePoint: number;
  valueStartCodePoint: number;
  valueEndCodePoint: number;
}

export function sourceSpanCompletionRangeFromJson(value: unknown): SourceSpanCompletionRange | undefined {
  const row = record(value);
  if (!row || typeof row.evidenceId !== "string" || !row.evidenceId) return undefined;
  const fields = [row.contextStartCodePoint, row.contextEndCodePoint, row.valueStartCodePoint, row.valueEndCodePoint];
  if (fields.some(field => typeof field !== "number" || !Number.isSafeInteger(field))) return undefined;
  const [contextStartCodePoint, contextEndCodePoint, valueStartCodePoint, valueEndCodePoint] = fields as number[];
  if (contextStartCodePoint! < 0 || valueStartCodePoint! <= contextStartCodePoint!
    || valueEndCodePoint! <= valueStartCodePoint! || contextEndCodePoint! <= valueEndCodePoint!) return undefined;
  return { evidenceId: row.evidenceId, contextStartCodePoint: contextStartCodePoint!, contextEndCodePoint: contextEndCodePoint!,
    valueStartCodePoint: valueStartCodePoint!, valueEndCodePoint: valueEndCodePoint! };
}

/** Exact coordinates certify subword spans without relaxing whole-word factual relation matching. */
export function sourceSpanCompletionRangeCurrent(input: {
  sourceSpan?: SourceSpanCompletionRange; subject: string; value: string; relationId?: string; requestedRoleId?: string;
  evidenceIds: readonly string[]; sourceVersionId?: string;
}, evidence: readonly EvidenceSpan[]): boolean {
  const span = sourceSpanCompletionRangeFromJson(input.sourceSpan);
  if (!span || input.relationId !== SOURCE_SPAN_COMPLETION_RELATION_ID || input.requestedRoleId !== SOURCE_SPAN_COMPLETION_ROLE_ID
    || input.evidenceIds.length !== 1 || input.evidenceIds[0] !== span.evidenceId) return false;
  const owners = evidence.filter(owner => String(owner.id) === span.evidenceId && owner.status === "promoted"
    && (!input.sourceVersionId || String(owner.sourceVersionId) === input.sourceVersionId));
  if (owners.length !== 1) return false;
  const points = [...owners[0]!.text];
  return span.contextEndCodePoint <= points.length
    && points.slice(span.contextStartCodePoint, span.contextEndCodePoint).join("") === input.subject
    && points.slice(span.valueStartCodePoint, span.valueEndCodePoint).join("") === input.value;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function invalid(): never { throw new Error("Invalid source-span-completion request declaration"); }
function range(value: unknown, length: number): { startCodePoint: number; endCodePoint: number } {
  const row = record(value);
  if (!row || typeof row.startCodePoint !== "number" || typeof row.endCodePoint !== "number"
    || !Number.isSafeInteger(row.startCodePoint) || !Number.isSafeInteger(row.endCodePoint)
    || row.startCodePoint < 0 || row.endCodePoint <= row.startCodePoint || row.endCodePoint > length) return invalid();
  return { startCodePoint: row.startCodePoint, endCodePoint: row.endCodePoint };
}
function ids(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(id => typeof id !== "string" || id.length === 0)
    || new Set(value).size !== value.length) return invalid();
  return value;
}

/** A caller or learned request interpreter declares the omitted range; text alone never activates this operator. */
export function sourceSpanCompletionRequestFromMetadata(metadata: unknown, requestText: string): SourceSpanCompletionRequest | undefined {
  const root = record(metadata);
  if (!root || !Object.hasOwn(root, "sourceSpanCompletion")) return undefined;
  const row = record(root.sourceSpanCompletion);
  if (!row || row.schema !== SOURCE_SPAN_COMPLETION_REQUEST_SCHEMA
    || row.requestText !== undefined && row.requestText !== requestText) return invalid();
  const length = [...requestText].length;
  const templateRange = range(row.templateRange, length), gapRange = range(row.gapRange, length);
  if (gapRange.startCodePoint <= templateRange.startCodePoint || gapRange.endCodePoint >= templateRange.endCodePoint) return invalid();
  return {
    schema: SOURCE_SPAN_COMPLETION_REQUEST_SCHEMA, requestText, templateRange, gapRange,
    ...(row.sourceVersionIds === undefined ? {} : { sourceVersionIds: ids(row.sourceVersionIds) }),
    ...(row.evidenceIds === undefined ? {} : { evidenceIds: ids(row.evidenceIds) })
  };
}

export interface SourceSpanCompletionProofProjection {
  claimText: string;
  nodes: GraphNode[];
  evidence: EvidenceSpan[];
  scope: TypedProofScope;
}

/** Replay the declared operator before deriving a typed text relation from its current source bytes. */
export function sourceSpanCompletionProofProjection(input: {
  request: SourceSpanCompletionRequest | undefined; binding: RequestValueBinding | undefined;
  evidence: readonly EvidenceSpan[]; hasher: Hasher; createdAt: number;
}): SourceSpanCompletionProofProjection | undefined {
  if (!input.request || !input.binding || input.binding.resolverId !== "resolver.source_span_completion") return undefined;
  const replay = sourceSpanCompletionValueResolver(input.request).resolve(input.request.requestText, input.evidence);
  if (!replay || typeof replay === "string") return undefined;
  const identity = (row: ResolvedRequestValue) => canonicalStringify({
    subject: row.subject, value: row.value, relationId: row.relationId, requestedRoleId: row.requestedRoleId,
    evidenceIds: [...row.evidenceIds].sort(), sourceSpan: row.sourceSpan
  });
  if (identity(replay) !== identity(input.binding) || !sourceSpanCompletionRangeCurrent(input.binding, input.evidence)) return undefined;
  const evidence = input.evidence.filter(span => input.binding!.evidenceIds.includes(String(span.id)));
  if (evidence.length !== 1 || !evidence.every(span => evidenceProofBoundary(span).certifiesFactualProof)) return undefined;
  const owner = evidence[0]!, key = input.hasher.digestHex(canonicalStringify({
    schema: "scce.source_span_completion_proof.v1", request: input.request, binding: replay,
    sourceVersionId: String(owner.sourceVersionId), contentHash: String(owner.contentHash)
  }));
  const contextId = ("source_span.context." + key) as GraphNode["id"];
  const valueId = ("source_span.value." + key) as GraphNode["id"];
  const contextRole = "role.source_span_completion.context";
  const contextKind = "kind.text.context", valueKind = "kind.text.span";
  const nodes: GraphNode[] = [
    { id: contextId, typeId: contextKind as GraphNode["typeId"], representation: { surface: replay.subject! },
      alpha: owner.alpha, evidenceIds: [owner.id], features: [], createdAt: input.createdAt, updatedAt: input.createdAt,
      metadata: { sourceVersionId: String(owner.sourceVersionId), contentHash: String(owner.contentHash) } },
    { id: valueId, typeId: valueKind as GraphNode["typeId"], representation: { surface: replay.value },
      alpha: owner.alpha, evidenceIds: [owner.id], features: [], createdAt: input.createdAt, updatedAt: input.createdAt,
      metadata: { sourceVersionId: String(owner.sourceVersionId), contentHash: String(owner.contentHash) } }
  ];
  const relation: Hyperedge = {
    schema: "scce.hyperedge.v2", id: ("source_span.relation." + key) as Hyperedge["id"],
    relationId: SOURCE_SPAN_COMPLETION_RELATION_ID as Hyperedge["relationId"],
    participantPorts: [
      { portId: "context", roleId: contextRole, nodeId: contextId, valueKind: contextKind, realization: "observed", evidenceIds: [owner.id] },
      { portId: "value", roleId: SOURCE_SPAN_COMPLETION_ROLE_ID, nodeId: valueId, valueKind, realization: "observed", evidenceIds: [owner.id] }
    ], memberNodeIds: [contextId, valueId], qualifiers: {}, modality: {}, temporalScope: { status: "atemporal" },
    evidenceIds: [owner.id], weightVector: {}, provenanceRefs: [String(owner.id)],
    createdAt: input.createdAt, updatedAt: input.createdAt, informationLabel: owner.informationLabel
  };
  return {
    claimText: replay.value, nodes, evidence,
    scope: { status: "active", reason: "declared_source_span_relation", scopedHyperedges: 1, typedRelations: [relation], proofClaims: [{
      id: "proof.claim.source_span." + key, requiredSourceBinding: true,
      subject: { id: contextId, kindId: contextKind, roleId: contextRole, surface: replay.subject },
      relationId: SOURCE_SPAN_COMPLETION_RELATION_ID,
      object: { id: valueId, kindId: valueKind, roleId: SOURCE_SPAN_COMPLETION_ROLE_ID, surface: replay.value }
    }] }
  };
}

/** Bind the one missing span between both unchanged context anchors in current source evidence. */
export function sourceSpanCompletionValueResolver(declaration: SourceSpanCompletionRequest): RequestValueResolver {
  const request = sourceSpanCompletionRequestFromMetadata({ sourceSpanCompletion: declaration }, declaration.requestText)!;
  const points = [...request.requestText];
  const left = points.slice(request.templateRange.startCodePoint, request.gapRange.startCodePoint).join("");
  const right = points.slice(request.gapRange.endCodePoint, request.templateRange.endCodePoint).join("");
  return {
    id: "resolver.source_span_completion",
    resolve(requestText, evidence) {
      if (requestText !== request.requestText) return undefined;
      const owners = evidence.filter(span => span.status === "promoted"
        && (!request.sourceVersionIds || request.sourceVersionIds.includes(String(span.sourceVersionId)))
        && (!request.evidenceIds || request.evidenceIds.includes(String(span.id))));
      let selected: { binding: ResolvedRequestValue; ownerKey: string } | undefined;
      for (const span of owners) {
        for (let start = span.text.indexOf(left); start >= 0; start = span.text.indexOf(left, start + 1)) {
          const valueStart = start + left.length;
          for (let end = span.text.indexOf(right, valueStart); end >= 0; end = span.text.indexOf(right, end + 1)) {
            const value = span.text.slice(valueStart, end);
            if (!value) continue;
            const binding: ResolvedRequestValue = {
              subject: span.text.slice(start, end + right.length), value,
              relationId: SOURCE_SPAN_COMPLETION_RELATION_ID, requestedRoleId: SOURCE_SPAN_COMPLETION_ROLE_ID,
              evidenceIds: [String(span.id)], sourceSpan: { evidenceId: String(span.id),
                contextStartCodePoint: [...span.text.slice(0, start)].length, contextEndCodePoint: [...span.text.slice(0, end + right.length)].length,
                valueStartCodePoint: [...span.text.slice(0, valueStart)].length, valueEndCodePoint: [...span.text.slice(0, end)].length }
            };
            if (selected && selected.binding.value !== value) return undefined;
            const ownerKey = JSON.stringify([String(span.sourceVersionId), String(span.id), start, end]);
            if (!selected || ownerKey < selected.ownerKey) selected = { binding, ownerKey };
          }
        }
      }
      return selected?.binding;
    }
  };
}
