import type { PromotionDecision, ScceStorage } from "./storage.js";

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

export async function reviewHeldSource(storage: ReviewStorage, input: { id: string; decision: "promoted" | "rejected"; reason?: string; reviewer?: string; now?: number }): Promise<HeldSourceReview> {
  const item = await storage.quarantine.get(input.id);
  if (!item) throw new Error(`held source not found: ${input.id}`);
  if (item.decision !== "pending") throw new Error(`held source already ${item.decision}: ${input.id}`);
  const decision: PromotionDecision = {
    decision: input.decision,
    decidedAt: input.now ?? Date.now(),
    reason: input.reason ?? (input.decision === "promoted" ? "owner confirmed the material as truthful" : "owner rejected the material"),
    ...(input.reviewer ? { reviewer: input.reviewer } : {})
  };
  await storage.quarantine.markDecision(input.id, decision);
  let promotedEvidence = 0;
  if (input.decision === "promoted") {
    const spans = await storage.evidence.searchEvidence({ sourceVersionId: item.sourceVersionId, status: "quarantined", limit: 1000 });
    if (spans.length) promotedEvidence = await storage.evidence.promoteEvidence(spans.map(result => result.span.id), decision.reason);
  }
  return { id: input.id, uri: item.uri, decision: input.decision, promotedEvidence };
}
