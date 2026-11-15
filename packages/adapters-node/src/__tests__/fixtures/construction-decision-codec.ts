// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify, type EvidenceSpan, type InformationLabel, type LanguagePatternRecord } from "@scce/kernel";
import { createConstructionSourceDecisionStore, type ConstructionSourceDecisionStorageHost } from "../../construction-source-decision-store.js";
import { decodeDurableArtifact } from "../../durable-artifact-storage.js";

export function constructionDecisionCodecFixture(evidence: () => readonly EvidenceSpan[]) {
  type Page = { id: string; owner_key: string; kind: string; value_json: Record<string, unknown>; information_label: InformationLabel };
  const pages = new Map<string, Page>(), physical = new Map<string, unknown>();
  const cold = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const host: ConstructionSourceDecisionStorageHost = {
    table: name => `"component_fixture"."${name}"`, transaction: async operation => operation(),
    requireWritableInformationLabel: value => { if (!value) throw new Error("missing explicit fixture label"); return value; },
    informationAccessPredicate: () => ({ sql: "TRUE", params: [] }), evidence: async ids => cold(evidence().filter(span => ids.includes(String(span.id)))),
    query: async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      if (sql.startsWith("INSERT")) {
        for (const row of JSON.parse(String(params[0])) as Page[]) {
          const prior = pages.get(row.id);
          if (prior && canonicalStringify(prior) !== canonicalStringify(row)) throw new Error("immutable fixture page changed");
          pages.set(row.id, cold(row));
        }
        return [];
      }
      if (sql.includes("JOIN jsonb_to_recordset")) return (JSON.parse(String(params[0])) as Page[])
        .filter(row => canonicalStringify(pages.get(row.id)) === canonicalStringify(row)).map(row => ({ id: row.id })) as T[];
      const wanted = params[0] as string[], owner = params[1];
      const selected = [...pages.values()].filter(row => wanted.includes(row.id) && row.owner_key === owner);
      if (sql.includes("octet_length")) return selected.map(row => ({ id: row.id, owner_key: row.owner_key, kind: row.kind,
        json_bytes: String(Buffer.byteLength(JSON.stringify(row.value_json))) })) as T[];
      return cold(selected) as T[];
    }
  };
  const store = createConstructionSourceDecisionStore(host);
  return { pages, physical, roundTrip: async (patterns: readonly LanguagePatternRecord[]): Promise<LanguagePatternRecord[]> => {
    const encoded = await store.encodeMany(patterns.map(pattern => ({ value: pattern.patternJson, logicalValue: pattern.patternJson, informationLabel: pattern.informationLabel })));
    const decoded = await store.decodeMany(cold(encoded));
    return patterns.map((pattern, index) => {
      const prior = physical.get(pattern.id);
      if (prior && canonicalStringify(prior) !== canonicalStringify(encoded[index])) throw new Error("immutable fixture construction changed");
      physical.set(pattern.id, cold(encoded[index]));
      const patternJson = decodeDurableArtifact(decoded[index]) as LanguagePatternRecord["patternJson"];
      if (canonicalStringify(patternJson) !== canonicalStringify(pattern.patternJson)) throw new Error("construction codec changed its logical pattern");
      return { ...pattern, patternJson };
    });
  } };
}
