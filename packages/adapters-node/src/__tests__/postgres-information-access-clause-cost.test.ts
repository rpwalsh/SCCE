// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";

const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { for (const adapter of adapters.splice(0)) await adapter.close(); });

function adapter(): PostgresStorageAdapter {
  const created = createPostgresStorageAdapter({
    url: "postgres://fixture:fixture@127.0.0.1/fixture",
    schema: "fixture",
    informationAccess: {
      tenantId: "tenant.fixture",
      principalId: "principal.fixture",
      compartments: ["compartment.fixture"],
      maximumExportClass: "restricted"
    }
  });
  adapters.push(created);
  return created;
}

/** Conjuncts a planner sees: AND tokens outside every parenthesis of the predicate, after its own outer pair. */
function plannerVisibleConjuncts(sql: string): number {
  const trimmed = sql.trim();
  const body = trimmed.startsWith("(") && trimmed.endsWith(")") ? trimmed.slice(1, -1) : trimmed;
  let depth = 0;
  let conjuncts = 1;
  for (let index = 0; index < body.length; index++) {
    const character = body[index]!;
    if (character === "(") depth++;
    else if (character === ")") depth--;
    else if (depth === 0 && body.startsWith("AND", index) && /\s/.test(body[index - 1] ?? " ") && /\s/.test(body[index + 3] ?? " ")) {
      conjuncts++;
      index += 2;
    }
  }
  return conjuncts;
}

describe("the information-access label is one decision, and costs the planner as one", () => {
  it("costs an order-and-limit bounded read as one clause, because four made it scan the whole population", () => {
    const bounded = plannerVisibleConjuncts(adapter().informationAccessPredicate("model", 1, "bounded_by_order_and_limit").sql);
    const unbounded = plannerVisibleConjuncts(adapter().informationAccessPredicate("model", 1).sql);

    console.log(`information-access predicate: bounded read ${bounded} planner-visible conjunct(s), unbounded read ${unbounded}`);
    expect(bounded).toBe(1);
    // The conjunct spelling survives only where no ORDER BY + LIMIT bounds the read; see the type's note.
    expect(unbounded).toBe(4);
  });

  it("reaches every guarded read that a language hydration makes", async () => {
    const created = adapter();
    const issued: string[] = [];
    created.query = async <T,>(sql: string): Promise<T[]> => { issued.push(sql); return [] as T[]; };

    await created.languageMemory.listNgramModels({ sourceSystem: "wikipedia", limit: 12 });
    await created.languageMemory.listLanguageUnits({ sourceSystem: "wikipedia", limit: 1536 });
    await created.languageMemory.listSemanticFrames({ sourceSystem: "wikipedia", limit: 1152 });

    console.log(`hydration reads costing the label as one decision: ${issued.filter(sql => sql.includes("CASE WHEN")).length} of ${issued.length}`);
    expect(issued).toHaveLength(3);
    for (const sql of issued) {
      expect(sql).toContain("CASE WHEN");
      expect(sql).toContain("ORDER BY");
      expect(sql).toContain("LIMIT");
    }
  });

  it("still decides on every facet of the label, with every parameter bound", () => {
    const access = adapter().informationAccessPredicate("model", 7, "bounded_by_order_and_limit");

    expect(access.sql).toContain("model.information_label->>'exportClass' = 'public'");
    expect(access.sql).toContain("model.information_label->>'tenantId' = $7");
    expect(access.sql).toContain("model.information_label->>'exportClass' = ANY($8::text[])");
    expect(access.sql).toContain("JSONB_ARRAY_LENGTH(model.information_label->'principals') = 0");
    expect(access.sql).toContain("(model.information_label->'principals') ? $9");
    expect(access.sql).toContain("(model.information_label->'compartments') <@ $10::jsonb");
    expect(access.params).toEqual([
      "tenant.fixture",
      ["public", "internal", "confidential", "restricted"],
      "principal.fixture",
      JSON.stringify(["compartment.fixture"])
    ]);
  });

  it("refuses an unsafe alias rather than interpolating it", () => {
    expect(() => adapter().informationAccessPredicate("model; DROP", 1)).toThrow(/unsafe information-label SQL alias/);
  });
});
