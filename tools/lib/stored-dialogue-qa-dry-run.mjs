// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
export function createReadOnlyDialogueQaPublicationStorage(storage, kernel) {
  const checkpoints = new Map(), projections = new Map(), patterns = new Map(), plans = [];
  const projectionKey = value => kernel.canonicalStringify([value.profileId, value.sourceId, value.sourceVersionId,
    value.sourceSystem, value.patternSchema, value.componentRecipe, value.informationLabel]);
  const read = (object, name) => object[name]?.bind(object);
  const facade = {
    transaction: async callback => {
      const saved = [new Map(checkpoints), new Map(projections), new Map(patterns)], count = plans.length;
      try { return await callback(); }
      catch (error) {
        [checkpoints, projections, patterns].forEach((map, index) => { map.clear(); for (const [key, value] of saved[index]) map.set(key, value); });
        plans.length = count;
        throw error;
      }
    },
    evidence: Object.fromEntries(["listEvidenceBackedSourceVersions", "countEvidenceBackedSourceVersions", "searchEvidence",
      "sourceVersionsForEvidence"].map(name => [name, read(storage.evidence, name)])),
    blobs: { get: read(storage.blobs, "get") },
    model: { listLanguageProfiles: read(storage.model, "listLanguageProfiles") },
    languageIdentities: { listIdentities: read(storage.languageIdentities, "listIdentities"),
      listProfileLanguages: read(storage.languageIdentities, "listProfileLanguages") },
    ingestion: { get: async id => checkpoints.get(id) ?? await storage.ingestion.get(id),
      put: async row => { checkpoints.set(row.id, structuredClone(row)); } },
    languageMemory: {
      getLanguagePatternProjection: async key => projections.get(projectionKey(key)) ?? await storage.languageMemory.getLanguagePatternProjection(key),
      listLanguagePatterns: async query => {
        const current = await storage.languageMemory.listLanguagePatterns(query);
        const selected = [...patterns.values()].filter(pattern => query?.patternIds?.includes(pattern.id));
        return [...new Map([...current, ...selected].map(pattern => [pattern.id, pattern])).values()];
      },
      replaceLanguagePatternProjection: async input => {
        const { patternIds: _ids, sourceDependencies: _dependencies, ...key } = input.projection;
        const previous = await facade.languageMemory.getLanguagePatternProjection(key);
        projections.set(projectionKey(input.projection), structuredClone(input.projection));
        for (const pattern of input.patterns) patterns.set(pattern.id, structuredClone(pattern));
        plans.push({ projection: structuredClone(input.projection), previousPatternIds: previous?.patternIds ?? [],
          newPatternIds: input.patterns.filter(pattern => !previous?.patternIds.includes(pattern.id)).map(pattern => pattern.id).sort() });
      }
    }
  };
  return { storage: facade, plans };
}

export async function dryRunStoredDialogueQaPublication({ storage, adapters, kernel, trainingOptions }) {
  const dry = createReadOnlyDialogueQaPublicationStorage(storage, kernel);
  const report = await adapters.trainStoredCorpusConstructions({ ...trainingOptions, storage: dry.storage,
    sourceSystem: "dialogue", contextualQaOnly: true });
  return { schema: "scce.stored_dialogue_qa_publication_plan.v1", mode: "read_only",
    exhausted: report.exhausted, sourcesAttempted: report.sourcesAttempted, reports: report.contextualQa?.reports.map(item => ({
      pairs: item.pairs, qualifiedFamilies: item.qualifiedFamilies, patternsPersisted: item.patternsPersisted, unchanged: item.unchanged,
      deferredProjections: item.deferredProjections ?? [], execution: item.execution })),
    deferred: report.contextualQa?.deferred ?? [], skipped: report.sourcesSkipped, failed: report.batchesFailed,
    affectedProjections: dry.plans.length,
    activeKnowledgePreserved: dry.plans.every(plan => plan.previousPatternIds.every(id => plan.projection.patternIds.includes(id))),
    retainedActivePatternIds: [...new Set(dry.plans.flatMap(plan => plan.previousPatternIds))].sort(),
    newPatternIds: [...new Set(dry.plans.flatMap(plan => plan.newPatternIds))].sort(), plans: dry.plans };
}
