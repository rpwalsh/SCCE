// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { LanguagePatternRecord } from "@scce/kernel";
import type { CreativeEventStorageHost } from "./canonical-creative-event-store.js";

/** Resolve the existing protected binding before calculating storage identities and decoded byte budgets. */
export async function inheritPatternCompilationBindings(
  host: Pick<CreativeEventStorageHost, "table" | "query" | "informationAccessPredicate">,
  patterns: readonly LanguagePatternRecord[]
): Promise<readonly LanguagePatternRecord[]> {
  const missing = patterns.filter(pattern => pattern.patternJson && typeof pattern.patternJson === "object"
    && !Array.isArray(pattern.patternJson) && !Object.hasOwn(pattern.patternJson, "sourceCompilationId"));
  if (!missing.length) return patterns;
  const inherited = new Map<string, { profile_id: string; source_compilation_id: string }>();
  for (let offset = 0; offset < missing.length; offset += 128) {
    const params: unknown[] = [missing.slice(offset, offset + 128).map(pattern => pattern.id)];
    const access = host.informationAccessPredicate("pattern", params.length + 1); params.push(...access.params);
    const rows = await host.query<{ id: string; profile_id: string; source_compilation_id: string }>(
      `SELECT pattern.id,pattern.profile_id,pattern.source_compilation_id FROM ${host.table("language_patterns")} pattern
       WHERE pattern.id=ANY($1::text[]) AND pattern.source_compilation_id IS NOT NULL AND ${access.sql}`, params);
    for (const row of rows) {
      if (typeof row.source_compilation_id !== "string" || !row.source_compilation_id || inherited.has(row.id)
        || !(params[0] as string[]).includes(row.id)) throw Error("invalid retained source compilation binding");
      inherited.set(row.id, row);
    }
  }
  return patterns.map(pattern => {
    const previous = inherited.get(pattern.id);
    if (!previous) return pattern;
    if (previous.profile_id !== pattern.profileId) throw Error("retained source compilation belongs to another profile");
    return { ...pattern, patternJson: { ...(pattern.patternJson as Record<string, import("@scce/kernel").JsonValue>),
      sourceCompilationId: previous.source_compilation_id } };
  });
}
