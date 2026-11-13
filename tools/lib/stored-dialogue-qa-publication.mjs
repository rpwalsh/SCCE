// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

export const STORED_DIALOGUE_QA_PUBLICATION_SCHEMA = "scce.stored_dialogue_qa_publication.v2";

/**
 * Finalize the dialogue capability from canonical blobs already retained by a brain.
 * This path deliberately cannot read corpus files or invoke language training.
 */
export async function runStoredDialogueQaPublication(input) {
  const report = await input.adapters.trainStoredCorpusConstructions({
    storage: input.storage,
    sourceSystem: "dialogue",
    contextualQaOnly: true,
    minArticleBytes: 0,
    maxArticleBytes: input.maxArticleBytes,
    maxTotalBytes: input.maxTotalBytes,
    maxSourceAttempts: input.maxSourceAttempts,
    sourcePageSize: input.sourcePageSize,
    ...(input.includeUriPrefix ? { includeUriPrefixes: [input.includeUriPrefix] } : {}),
    ...(input.contextualQaJointPool ? { contextualQaJointPool: input.contextualQaJointPool } : {}),
    ...(input.contextualQaExecution ? { contextualQaExecution: input.contextualQaExecution } : {})
  });

  const schema = safeSchemaIdentifier(input.databaseSchema);
  const predicate = `pattern_schema='${sqlLiteral(input.kernel.LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA)}'
      AND pattern_json->>'componentRecipe'='${sqlLiteral(input.kernel.CONTEXTUAL_QA_CONSTRUCTION_RECIPE)}'`;
  // Establish completion across the same cold persistence boundary used by a
  // restarted server; the publisher may still hold transaction-local caches.
  const verificationStorage = input.createVerificationStorage
    ? await input.createVerificationStorage()
    : input.storage;
  const closeVerificationStorage = verificationStorage !== input.storage;
  let physicalContextualQaPatterns;
  let activePatterns;
  let coldVerifiedPatternIds;
  try {
    const [countRows, idRows] = await Promise.all([
      verificationStorage.query(`SELECT count(*)::bigint AS count FROM "${schema}".language_patterns WHERE ${predicate}`),
      verificationStorage.query(`SELECT DISTINCT member.pattern_id AS id
        FROM "${schema}".storage_meta active_projection
        CROSS JOIN LATERAL jsonb_array_elements_text(CASE
          WHEN jsonb_typeof(active_projection.value_json->'patternIds')='array'
          THEN active_projection.value_json->'patternIds' ELSE '[]'::jsonb END) member(pattern_id)
        WHERE active_projection.value_json->>'schema'='scce.language_pattern_active_projection.v1'
          AND active_projection.value_json->>'patternSchema'='${sqlLiteral(input.kernel.LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA)}'
          AND active_projection.value_json->>'componentRecipe'='${sqlLiteral(input.kernel.CONTEXTUAL_QA_CONSTRUCTION_RECIPE)}'
        ORDER BY member.pattern_id LIMIT 64`)
    ]);
    physicalContextualQaPatterns = Number(countRows[0]?.count ?? 0);
    const candidateIds = [...new Set(idRows.map(row => String(row.id)).filter(Boolean))];
    // Exact-ID reads intentionally fail closed as a set when any requested row is
    // inactive. Read projection members independently so a retired physical row
    // cannot hide every current member during completion verification.
    activePatterns = (await Promise.all(candidateIds.map(patternId =>
      verificationStorage.languageMemory.listLanguagePatterns({
        patternIds: [patternId],
        patternSchemas: [input.kernel.LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA],
        sourceSystem: "dialogue",
        limit: 1,
        maxTotalJsonBytes: 64 * 1024 * 1024,
        requireComplete: true
      })))).flat();
    const evidenceIds = [...new Set(activePatterns.flatMap(pattern => pattern.evidenceIds))];
    const evidence = evidenceIds.length ? await verificationStorage.evidence.getEvidenceBatch(evidenceIds) : [];
    const hasher = input.kernel.createHasher();
    coldVerifiedPatternIds = activePatterns.flatMap(pattern =>
      input.kernel.verifyContextualQaConstruction({ pattern, evidence, hasher }) ? [pattern.id] : []);
  } finally {
    if (closeVerificationStorage) await verificationStorage.close();
  }

  return {
    report,
    result: summarizeStoredDialogueQaPublication({
      report,
      physicalContextualQaPatterns,
      activeContextualQaPatterns: activePatterns.length,
      coldVerifiedPatternIds
    })
  };
}

export function summarizeStoredDialogueQaPublication(input) {
  const report = input.report;
  const componentReports = report?.contextualQa?.reports ?? [];
  return {
    exhausted: report?.exhausted === true,
    stoppedByStorageFailure: report?.stoppedByStorageFailure === true,
    stoppedByInterruption: report?.stoppedByInterruption === true,
    stoppedByHeapSafetyBound: report?.stoppedByHeapSafetyBound === true,
    sourcesEnumerated: report?.sourcesEnumerated ?? 0,
    sourcesConsidered: report?.sourcesConsidered ?? 0,
    sourcesAttempted: report?.sourcesAttempted ?? 0,
    languageTrainingReports: report?.reports?.length ?? 0,
    contextualQaReports: componentReports.length,
    contextualQaFamilies: componentReports.reduce((sum, item) => sum + item.qualifiedFamilies, 0),
    contextualQaPatternsPersisted: componentReports.reduce((sum, item) => sum + item.patternsPersisted, 0),
    physicalContextualQaPatterns: input.physicalContextualQaPatterns,
    activeContextualQaPatterns: input.activeContextualQaPatterns,
    coldVerifiedContextualQaPatterns: input.coldVerifiedPatternIds.length,
    coldVerifiedPatternIds: [...input.coldVerifiedPatternIds].sort(),
    unchangedComponents: componentReports.filter(item => item.unchanged).length,
    components: componentReports.map(item => ({
      compilerFingerprint: item.compilerFingerprint,
      pairs: item.pairs,
      patternsPersisted: item.patternsPersisted,
      qualifiedFamilies: item.qualifiedFamilies,
      unchanged: item.unchanged,
      rejectedByReason: Object.fromEntries([...item.rejected.reduce((counts, row) => {
        counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1);
        return counts;
      }, new Map())].sort(([left], [right]) => left.localeCompare(right))),
      rejectedExamples: item.rejected.filter(row => row.detail !== undefined).slice(0, 8).map(row => ({
        bindingId: row.bindingId,
        reason: row.reason,
        detail: row.detail
      }))
    })),
    deferred: report?.contextualQa?.deferred ?? [],
    sourcesSkipped: report?.sourcesSkipped ?? [],
    batchesFailed: report?.batchesFailed ?? []
  };
}

/** A brain cannot be complete merely because rows exist; at least one must cold-hydrate and verify. */
export function assertStoredDialogueQaPublication(result) {
  if (result.languageTrainingReports !== 0) throw new Error("retained dialogue finalization unexpectedly invoked language training");
  if (result.stoppedByStorageFailure || result.stoppedByInterruption || result.stoppedByHeapSafetyBound || !result.exhausted) {
    throw new Error("stored dialogue publication did not exhaust its bounded source inventory");
  }
  if (result.deferred.length || !result.contextualQaReports) {
    throw new Error(`stored dialogue publication is incomplete (exhausted=${result.exhausted}, reports=${result.contextualQaReports}, deferred=${result.deferred.length})`);
  }
  if (result.physicalContextualQaPatterns < 1) throw new Error("stored dialogue publication produced no contextual-QA patterns");
  if (result.activeContextualQaPatterns < 1) throw new Error("stored dialogue publication has no active contextual-QA projection");
  if (result.coldVerifiedContextualQaPatterns < 1) throw new Error("stored dialogue publication has no cold-verifiable contextual-QA construction");
  return result;
}

function safeSchemaIdentifier(value) {
  const schema = String(value);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(schema)) throw new Error("database schema is not a safe SQL identifier");
  return schema;
}

function sqlLiteral(value) {
  return String(value).replaceAll("'", "''");
}
