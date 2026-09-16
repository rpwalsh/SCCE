// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
export const WITHHELD_SURFACE_SCHEMA = "scce.runtime.withheld_surface.v1";

// Presentation only. The kernel emits the reason id; none of this wording exists anywhere in cognition.
const WITHHELD_MESSAGES: Record<string, string> = {
  "withheld.no_admitted_evidence": "Nothing in the corpus was admitted for this request, so nothing is being stated as known.",
  "withheld.surface_refused": "Evidence was admitted, but every answer built from it was refused, so nothing is being stated as known."
};

export interface WithheldSurfaceView {
  reasonId: string;
  text: string;
  detail: Record<string, unknown>;
}

/** The typed withheld record a turn carried, or undefined when the payload is not one. */
export function parseWithheldSurface(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  if (record.schema !== WITHHELD_SURFACE_SCHEMA) return undefined;
  return typeof record.reasonId === "string" && record.reasonId ? record : undefined;
}

export function withheldSurfaceView(payload: unknown): WithheldSurfaceView | undefined {
  const record = parseWithheldSurface(payload);
  if (!record) return undefined;
  const reasonId = String(record.reasonId);
  const text = WITHHELD_MESSAGES[reasonId] ?? "";
  return text ? { reasonId, text, detail: record } : undefined;
}
