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
    sources: turnSources(answer)
  };
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
