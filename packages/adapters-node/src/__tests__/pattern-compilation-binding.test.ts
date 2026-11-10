// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import type { LanguagePatternRecord } from "@scce/kernel";
import { inheritPatternCompilationBindings } from "../pattern-compilation-binding.js";

const pattern = (id: string, body: Record<string, import("@scce/kernel").JsonValue>): LanguagePatternRecord => ({
  id, profileId: "profile.source", patternKind: "semantic_role", support: 2, entropy: 0, evidenceIds: [], updatedAt: 1, patternJson: body
});
function host(rows: Array<{ id: string; profile_id: string; source_compilation_id: string }>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return { calls, table: (name: string) => `"fixture"."${name}"`,
    informationAccessPredicate: (alias: string, first: number) => ({ sql: `${alias}.information_label->>'tenantId'=$${first}`, params: ["tenant.source"] }),
    query: async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      calls.push({ sql, params }); return rows.filter(row => (params[0] as string[]).includes(row.id)) as T[];
    } };
}
describe("retained source compilation identities", () => {
  it("resolves the same protected identity before storage hashing without changing caller-owned records", async () => {
    const original = pattern("retained", { schema: "source.pattern", body: "e\u0301雪", values: [1, 2, 3] });
    const store = host([{ id: "retained", profile_id: original.profileId, source_compilation_id: "old.compilation" }]);
    const result = await inheritPatternCompilationBindings(store, [original]);
    expect(result).toEqual([{ ...original, patternJson: { ...original.patternJson as object, sourceCompilationId: "old.compilation" } }]);
    expect(original.patternJson).not.toHaveProperty("sourceCompilationId");
    expect(store.calls[0]!.sql).toContain("pattern.information_label->>'tenantId'=$2");
  });
  it("preserves explicit incoming bindings and nulls and needs no owner read for them", async () => {
    const originals = [pattern("new", { sourceCompilationId: "new.compilation" }), pattern("cleared", { sourceCompilationId: null })];
    const store = host([]);
    expect(await inheritPatternCompilationBindings(store, originals)).toBe(originals);
    expect(store.calls).toHaveLength(0);
  });
  it("bounds lookups and refuses another profile's retained compilation", async () => {
    const store = host([]), originals = Array.from({ length: 257 }, (_, i) => pattern(String(i), { schema: "source.pattern" }));
    expect(await inheritPatternCompilationBindings(store, originals)).toEqual(originals);
    expect(store.calls).toHaveLength(3);
    const foreign = host([{ id: "retained", profile_id: "profile.foreign", source_compilation_id: "foreign" }]);
    await expect(inheritPatternCompilationBindings(foreign, [pattern("retained", { schema: "source.pattern" })])).rejects.toThrow(/another profile/u);
  });
});
