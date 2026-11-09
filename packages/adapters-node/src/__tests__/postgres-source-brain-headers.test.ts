// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it } from "vitest";
import { informationLabelAllowsRead, type InformationLabel } from "@scce/kernel";
import { PostgresStorageAdapter } from "../postgres.js";
const label: InformationLabel = { tenantId: "owner", principals: ["reader"], compartments: [], exportClass: "restricted", mergePolicy: "isolated" };
const access = { tenantId: "owner", principalId: "reader", compartments: [], maximumExportClass: "restricted" as const };
const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { for (const a of adapters.splice(0)) await a.close(); });
function fixture() {
  const adapter = new PostgresStorageAdapter({ url: "postgres://offline.invalid/no", schema: "brain_headers", informationAccess: access }); adapters.push(adapter);
  const calls: { sql: string; params: unknown[] }[] = [];
  const profiles = [{ id: "wanted", source_version_id: "source", information_label: label },
    { id: "foreign", source_version_id: "foreign-source", information_label: { ...label, principals: ["other"] } }];
  const models = [{ id: "wanted-model", profile_id: "wanted", information_label: label },
    { id: "foreign-model", profile_id: "foreign", information_label: label }];
  const current = { source: true };
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    calls.push({ sql, params });
    expect(sql).toContain("ANY($1::text[])"); expect(sql).toContain("sv.id=");
    expect(sql).toContain("information_label"); expect(sql).toContain("pooled_evidence.status='promoted'");
    expect(sql).not.toMatch(/SELECT[^]*\b(?:profile_json|model_json)\s*(?:,|FROM)/);
    const ids = new Set(params[0] as string[]);
    if (sql.startsWith("SELECT lp.id")) return profiles.filter(p => ids.has(p.id) && current.source && informationLabelAllowsRead(p.information_label, access)).slice(0, Number(params.at(-1))) as T[];
    expect(sql).toContain("model_profile.id=model.profile_id");
    const requestedProfiles = sql.includes("model.profile_id=ANY($2::text[])") ? new Set(params[1] as string[]) : undefined;
    return models.filter(m => ids.has(m.id) && (!requestedProfiles || requestedProfiles.has(m.profile_id)) && current.source
      && profiles.some(p => p.id === m.profile_id && informationLabelAllowsRead(p.information_label, access)))
      .slice(0, Number(params.at(-1))) as T[];
  };
  return { adapter, calls, current };
}
it("retrieves only exact owned profile/model headers without returning artifact bodies", async () => {
  const f = fixture();
  expect(await f.adapter.model.listLanguageProfileHeaders!({ profileIds: ["wanted", "foreign"], limit: 2 })).toEqual([{ id: "wanted", sourceVersionId: "source", informationLabel: label }]);
  expect(await f.adapter.languageMemory.listNgramModelHeaders!({ modelIds: ["wanted-model", "foreign-model"], profileIds: ["wanted"], limit: 2 })).toEqual([{ id: "wanted-model", profileId: "wanted", informationLabel: label }]);
  expect(await f.adapter.languageMemory.listNgramModelHeaders!({ modelIds: ["wanted-model"], profileIds: ["foreign"], limit: 2 })).toEqual([]);
  f.current.source = false;
  expect(await f.adapter.model.listLanguageProfileHeaders!({ profileIds: ["wanted"], limit: 1 })).toEqual([]);
  expect(await f.adapter.languageMemory.listNgramModelHeaders!({ modelIds: ["wanted-model"], limit: 1 })).toEqual([]);
});
it("does no lookup for an empty exact selection and refuses invalid work-page limits", async () => {
  const f = fixture();
  expect(await f.adapter.model.listLanguageProfileHeaders!({ profileIds: [], limit: 1 })).toEqual([]);
  expect(await f.adapter.languageMemory.listNgramModelHeaders!({ modelIds: [], limit: 1 })).toEqual([]);
  expect(f.calls).toEqual([]);
  await expect(f.adapter.model.listLanguageProfileHeaders!({ profileIds: ["wanted"], limit: Infinity })).rejects.toThrow("positive safe integer");
  await expect(f.adapter.languageMemory.listNgramModelHeaders!({ modelIds: ["wanted-model"], limit: 0 })).rejects.toThrow("positive safe integer");
});
