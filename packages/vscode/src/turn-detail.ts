import type { TurnAnswer, TurnAnswerEvidenceSpan } from "./client.js";

export interface TurnSource {
  id: string;
  title: string;
  preview: string;
}

export function turnDetail(answer: TurnAnswer): unknown {
  return {
    conversationId: answer?.dialogue?.conversationId ?? null,
    proof: answer?.entailment?.proof ?? null,
    events: (answer?.events ?? []).slice(0, 40).map(event => ({ typeId: event.typeId, id: event.id })),
    sources: turnSources(answer),
    learning: turnLearning(answer)
  };
}

export interface TurnLearning {
  status: "awaiting_consent" | "held_for_review";
  planId?: string;
  heldSources: Array<{ id: string; uri: string; title: string; snippet: string }>;
}

/** Consent and truthfulness prompts come from the kernel's runtime motion: ask before searching, confirm before learning. */
export function turnLearning(answer: TurnAnswer): TurnLearning | null {
  const motion = answer?.runtimeMotion;
  if (!motion || typeof motion !== "object" || Array.isArray(motion)) return null;
  const record = motion as Record<string, unknown>;
  if (record.status === "awaiting_consent") {
    const consent = record.consent && typeof record.consent === "object" ? record.consent as Record<string, unknown> : {};
    return typeof consent.planId === "string" ? { status: "awaiting_consent", planId: consent.planId, heldSources: [] } : null;
  }
  if (record.status === "held_for_review" && Array.isArray(record.heldSources) && record.heldSources.length) {
    return { status: "held_for_review", heldSources: record.heldSources.map(item => { const row = item as Record<string, unknown>; return { id: String(row.id ?? ""), uri: String(row.uri ?? ""), title: String(row.title ?? ""), snippet: String(row.snippet ?? "") }; }).filter(item => item.id) };
  }
  return null;
}

// Evidence is a citation, not a requirement: when the turn found real
// sources, they're offered here for the user to inspect; an empty list
// just means this particular answer wasn't source-backed, which is a
// normal, honest outcome, not something to hide or apologize for.
export function turnSources(answer: TurnAnswer): TurnSource[] {
  return (answer?.evidence ?? []).slice(0, 12).map(span => ({
    id: String(span.id ?? ""),
    title: sourceTitle(span),
    preview: String(span.textPreview ?? "").slice(0, 240)
  }));
}

export function sourceTitle(span: Pick<TurnAnswerEvidenceSpan, "sourceId" | "provenance">): string {
  const provenance = span.provenance && typeof span.provenance === "object" && !Array.isArray(span.provenance)
    ? span.provenance as Record<string, unknown>
    : {};
  for (const key of ["title", "sourceUri", "canonicalUri", "uri", "sourcePath"]) {
    const value = provenance[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return String(span.sourceId ?? "source");
}
