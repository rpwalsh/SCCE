// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { toJsonValue } from "./primitives.js";
import type { PromotionDecision, ScceStorage } from "./storage.js";
import type { CapabilityPlan, IngestInput, IngestResult, JsonValue, SourceAdmissionContext } from "./types.js";

/** The approval-session fingerprint for consent to search the web about one query; the kernel and every surface build it here. */
export function learningConsentInput(query: string, hasher: { digestHex(input: string): string }): JsonValue {
  return toJsonValue({ schema: "scce.learning_consent.v1", capabilityId: "network.search", query, queryHash: hasher.digestHex(query) });
}

export const LEARNING_SOURCE_ACQUISITION_KIND = "learning_source_acquisition";

/** A self-proposed curriculum item: a learning plan the kernel wants pursued, waiting for the owner. */
export interface LearningCurriculumItem {
  planId: string;
  capabilityId: string;
  query: string;
  rationale: string;
  utility: number;
}

export function curriculumItemFromPlan(plan: Pick<CapabilityPlan, "id" | "capabilityId" | "input">): LearningCurriculumItem | undefined {
  const input = plan.input && typeof plan.input === "object" && !Array.isArray(plan.input) ? plan.input as Record<string, JsonValue> : {};
  if (input.kind !== LEARNING_SOURCE_ACQUISITION_KIND || typeof input.query !== "string" || !input.query.trim()) return undefined;
  return { planId: String(plan.id), capabilityId: plan.capabilityId, query: input.query, rationale: typeof input.rationale === "string" ? input.rationale : "", utility: typeof input.utility === "number" ? input.utility : 0 };
}

/** Owner review of material acquired at runtime: held sources stay quarantined until confirmed truthful here. */

export interface HeldSource {
  id: string;
  uri: string;
  mediaType: string;
  fetchedAt: number;
  title: string;
  preview: string;
  evidenceCount: number;
}

export interface HeldSourceReview {
  id: string;
  uri: string;
  decision: "promoted" | "rejected";
  promotedEvidence: number;
}

type ReviewStorage = Pick<ScceStorage, "quarantine" | "evidence">;

export async function listHeldSources(storage: ReviewStorage, limit = 20): Promise<HeldSource[]> {
  const pending = await storage.quarantine.listPending({ limit });
  const held: HeldSource[] = [];
  for (const item of pending) {
    const spans = (await storage.evidence.searchEvidence({ sourceVersionId: item.sourceVersionId, status: "quarantined", limit: 6 })).map(result => result.span);
    const first = spans[0] as { title?: unknown } | undefined;
    held.push({
      id: item.id,
      uri: item.uri,
      mediaType: item.mediaType,
      fetchedAt: item.fetchedAt,
      title: typeof first?.title === "string" ? first.title : "",
      preview: spans.map(span => span.text).join(" ").replace(/\s+/gu, " ").trim().slice(0, 700),
      evidenceCount: spans.length
    });
  }
  return held;
}

export async function reviewHeldSource(storage: ReviewStorage & Partial<Pick<ScceStorage, "blobs">>, input: { id: string; decision: "promoted" | "rejected"; reason?: string; reviewer?: string; now?: number }, activation?: { ingest(input: IngestInput): Promise<IngestResult> }): Promise<HeldSourceReview> {
  const item = await storage.quarantine.get(input.id);
  if (!item) throw new Error(`held source not found: ${input.id}`);
  if (item.decision !== "pending") throw new Error(`held source already ${item.decision}: ${input.id}`);
  const decision: PromotionDecision = {
    decision: input.decision,
    decidedAt: input.now ?? Date.now(),
    reason: input.reason ?? (input.decision === "promoted" ? "owner confirmed the material as truthful" : "owner rejected the material"),
    ...(input.reviewer ? { reviewer: input.reviewer } : {})
  };
  let promotedEvidence = 0;
  if (input.decision === "promoted") {
    if (!activation || !storage.blobs || !storage.evidence.sourceVersionById) throw new Error("held-source promotion requires canonical ingestion and owned source storage");
    const source = await storage.evidence.sourceVersionById(item.sourceVersionId);
    if (!source || source.sourceId !== item.sourceId) throw new Error(`held source version not found: ${item.sourceVersionId}`);
    const original = source.derivation ? await storage.evidence.sourceVersionById(source.derivation.derivedFromSourceVersionId) : source;
    if (!original || original.sourceId !== source.sourceId) throw new Error("held source original ownership is unavailable");
    const permission = recordOf(item.permissionVector);
    const context = recordOf(permission.sourceAdmission) as unknown as SourceAdmissionContext;
    if (!context.sourceClass || !context.intendedUse) throw new Error("held source admission context is unavailable");
    const derivativeBytes = source.derivation ? await storage.blobs.get(source.contentHash) : undefined;
    const replay = await activation.ingest({
      uri: original.canonicalUri, namespace: original.namespace, mediaType: original.mediaType,
      content: await storage.blobs.get(original.contentHash), metadata: original.metadata,
      sourceTrust: original.sourceTrust, informationLabel: original.informationLabel,
      sourceAdmission: { ...context, intendedUse: context.intendedUse === "quarantine_only" ? "direct_evidence" : context.intendedUse, promotionAuthority: "owner" },
      ...(source.derivation && derivativeBytes ? { evidenceDerivative: {
        bytes: derivativeBytes, text: Buffer.from(derivativeBytes).toString("utf8"),
        kind: source.derivation.kind, transformId: source.derivation.transformId,
        originalCoordinateSpace: source.derivation.originalCoordinateSpace, redactionMap: source.derivation.redactionMap
      } } : {})
    });
    if (!replay.events.some(event => event.typeId === "SourcePromoted" && recordOf(event.payload).sourceVersionId === item.sourceVersionId)) {
      throw new Error("owner-reviewed source did not pass canonical admission");
    }
    promotedEvidence = replay.evidence;
  }
  await storage.quarantine.markDecision(input.id, decision);
  return { id: input.id, uri: item.uri, decision: input.decision, promotedEvidence };
}

function recordOf(value: unknown): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}
