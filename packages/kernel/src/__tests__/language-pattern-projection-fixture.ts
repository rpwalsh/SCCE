// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify } from "../primitives.js";
import { jsonRecord } from "../kernel-answer-primitives.js";
import type { LanguageMemoryStore } from "../storage.js";

type Publication = Parameters<NonNullable<LanguageMemoryStore["replaceLanguagePatternProjection"]>>[0];
const manifests = new WeakMap<LanguageMemoryStore, Map<string, Publication["projection"]>>();
const rawLists = new WeakMap<LanguageMemoryStore, LanguageMemoryStore["listLanguagePatterns"]>();

export function removeFixtureLanguagePatternProjections(store: LanguageMemoryStore): void {
  manifests.get(store)?.clear();
}

export function installFixtureLanguagePatternProjection(store: LanguageMemoryStore): void {
  let active = manifests.get(store);
  if (!active) {
    active = new Map();
    manifests.set(store, active);
    const list = store.listLanguagePatterns?.bind(store);
    if (list) rawLists.set(store, list);
    const scopes = active;
    if (list) store.listLanguagePatterns = async query => {
      const rows = await list(query ? { ...query, limit: undefined } : undefined);
      return rows.filter(row => {
        const metadata = jsonRecord(row.patternJson);
        if (metadata.schema !== "scce.language_construction_pattern.v1" && metadata.schema !== "scce.source_code_function_pattern.v1"
          && metadata.schema !== "scce.source_owned_test_contract.v1") return true;
        return [...scopes.values()].some(scope => scope.patternSchema === metadata.schema && scope.profileId === row.profileId
          && scope.sourceSystem === metadata.sourceSystem && scope.patternIds.includes(row.id)
          && canonicalStringify(scope.informationLabel) === canonicalStringify(row.informationLabel));
      }).slice(0, query?.limit ?? rows.length);
    };
  }
}

export async function getFixtureLanguagePatternProjection(this: LanguageMemoryStore,
  query: Parameters<NonNullable<LanguageMemoryStore["getLanguagePatternProjection"]>>[0]): Promise<Publication["projection"] | undefined> {
  installFixtureLanguagePatternProjection(this);
  const projection = [...manifests.get(this)!.values()].find(scope => scope.profileId === query.profileId && scope.sourceId === query.sourceId
    && scope.sourceVersionId === query.sourceVersionId && scope.sourceSystem === query.sourceSystem && scope.patternSchema === query.patternSchema
    && scope.componentRecipe === query.componentRecipe && canonicalStringify(scope.informationLabel) === canonicalStringify(query.informationLabel));
  if (!projection) return undefined;
  if (query.sourceCompilationId) {
    const rows = await rawLists.get(this)!({ profileIds: [query.profileId], patternSchemas: [query.patternSchema] });
    const ids = rows.filter(row => jsonRecord(row.patternJson).sourceCompilationId === query.sourceCompilationId).map(row => row.id).sort();
    if (canonicalStringify(ids) !== canonicalStringify(projection.patternIds)) return undefined;
  }
  return structuredClone(projection);
}

export async function replaceFixtureLanguagePatternProjection(this: LanguageMemoryStore, input: Publication): Promise<void> {
  installFixtureLanguagePatternProjection(this);
  const active = manifests.get(this)!;
  for (const id of input.projection.patternIds) {
    const row = input.patterns.find(pattern => pattern.id === id);
    if (!row || row.profileId !== input.projection.profileId || jsonRecord(row.patternJson).schema !== input.projection.patternSchema
      || jsonRecord(row.patternJson).sourceSystem !== input.projection.sourceSystem) throw new Error("invalid fixture active projection");
  }
  if (this.putLanguagePatterns) await this.putLanguagePatterns(input.patterns);
  else for (const pattern of input.patterns) await this.putLanguagePattern(pattern);
  active.set(canonicalStringify([input.projection.informationLabel.tenantId, input.projection.sourceId, input.projection.sourceSystem,
    input.projection.patternSchema]), structuredClone(input.projection));
}
