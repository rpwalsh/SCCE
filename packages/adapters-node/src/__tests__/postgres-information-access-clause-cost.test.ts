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

  it("filters stored replay by its source metadata before reading evidence and keeps information access enforced", async () => {
    const created = adapter();
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    created.query = async <T,>(sql: string, params: unknown[] = []): Promise<T[]> => { calls.push({ sql, params }); return []; };
    await created.evidence.listEvidenceBackedSourceVersions!({ sourceSystems: ["opaque.dialogue", "dialogue"], limit: 32 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("COALESCE(sv.metadata_json->>'sourceSystemId', sv.metadata_json->>'sourceSystem') = ANY($1::text[])");
    expect(calls[0]!.sql).toContain("e.status='promoted'");
    expect(calls[0]!.sql).toContain("sv.information_label");
    expect(calls[0]!.sql).toContain("LIMIT");
    expect(calls[0]!.params[0]).toEqual(["opaque.dialogue", "dialogue"]);
  });

  it("uses a bounded source-ID keyset and counts excluded article sizes without an OFFSET scan", async () => {
    const created = adapter();
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    created.query = async <T,>(sql: string, params: unknown[] = []): Promise<T[]> => {
      calls.push({ sql, params });
      return sql.includes("AS total") ? [{ total: "11", derived: "2", eligible: "6", below: "1", above: "2" }] as T[] : [];
    };
    const query = { sourceSystem: "dialogue", sourceSystems: ["dialogue"], afterSourceVersionId: "sv-100001", orderBySourceVersionId: true,
      minByteLength: 20, maxByteLength: 50, excludeTrainingDerived: true, limit: 17 };
    await created.evidence.listEvidenceBackedSourceVersions!(query);
    const inventory = await created.evidence.countEvidenceBackedSourceVersions!(query);
    expect(inventory).toEqual({ evidenceBackedSources: 11, derivedTrainingSources: 2, eligibleSources: 6, belowMinArticleBytes: 1, aboveMaxArticleBytes: 2 });
    expect(calls[0]!.sql).toContain('ORDER BY sv.id COLLATE "C" ASC');
    expect(calls[0]!.params.at(-1)).toBe(17);
    for (const call of calls) {
      expect(call.sql).toContain('sv.id COLLATE "C" >');
      expect(call.sql).toContain("sv.information_label");
      expect(call.sql).toContain("construction_training");
      expect(call.sql).toContain("scce://construction-probe/%");
      expect(call.sql).toContain("sourceClass");
      expect(call.sql).toContain("e.provenance_json->>'sourceSystem'");
      expect(call.sql).not.toContain("e.provenance->");
      expect(call.sql).not.toContain("OFFSET");
      expect(call.params).toContain("sv-100001");
    }
    expect(calls[1]!.sql).toContain("COUNT(DISTINCT sv.id) FILTER");
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
