// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
export const WITHHELD_SURFACE_SCHEMA = "scce.runtime.withheld_surface.v1";

export interface WithheldSurfaceView {
  reasonId: string;
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
  return { reasonId, detail: record };
}
