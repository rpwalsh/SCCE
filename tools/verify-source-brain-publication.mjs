// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function parseSourceBrainPublicationArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!['--config', '--output'].includes(flag) || !value || value.startsWith('--') || result[flag])
      throw Error('Usage: node tools/verify-source-brain-publication.mjs --config <fresh-local-config.json> [--output <receipt.json>]');
    result[flag] = value;
  }
  if (!result['--config']) throw Error('A fresh, migrated local verification database config is required');
  if (result['--output'] && path.resolve(result['--output']).toLowerCase() === path.resolve(result['--config']).toLowerCase()) throw Error('Receipt output must not replace the input config');
  return { configPath: result['--config'], outputPath: result['--output'] };
}

export async function verifySourceBrainPublication(options) {
  const { readScceRuntimeConfig } = await import('../packages/adapters-node/dist/config.js');
  const { createPostgresStorageAdapter } = await import('../packages/adapters-node/dist/postgres.js');
  const { trainLanguageCorpusText } = await import('../packages/adapters-node/dist/language-corpus-trainer.js');
  const { trainDialogueCorpus } = await import('../packages/adapters-node/dist/dialogue-corpus.js');
  const { trainOssCorpus } = await import('../packages/adapters-node/dist/oss-corpus.js');
  const { trainGutenbergCorpus } = await import('../packages/adapters-node/dist/gutenberg-corpus.js');
  const { trainStoredCorpusConstructions } = await import('../packages/adapters-node/dist/stored-corpus-construction-training.js');
  const { completeInitialSourceBrainBuild, createSourceBrainFileAdmission, sourceBrainSelectedItemsFromReports } = await import('../packages/adapters-node/dist/source-brain-build.js');
  const { finalizeCorpusBrainManifest } = await import('../packages/cli/dist/corpus-brain-manifest.js');
  const { POSTGRES_REQUIRED_TABLES, CORPUS_SOURCE_SYSTEM_IDS, CODE_SURFACE_RECIPE_ID, canonicalStringify, createClock, createHasher, createIdFactory, createLanguageAcquisitionEngine,
    evidenceSourceFamilyId, preparePooledLanguageProfileBinding } = await import('../packages/kernel/dist/index.js');
  const config = await readScceRuntimeConfig(options.configPath);
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(config.database.url).hostname)) throw Error('Rollback-only publication verification requires local PostgreSQL');
  const access = config.security.informationAccess;
  if (!access || !access.maximumExportClass || access.maximumExportClass === 'public') throw Error('Publication fixture requires an owner-private information-access context');
  const storage = createPostgresStorageAdapter({ ...config.database, informationAccess: access });
  const hasher = createHasher(), suffix = randomUUID(), clock = createClock({ fixedTime: 1 });
  const ids = createIdFactory({ hasher, clock, namespace: `native-publication.${suffix}`, deterministicReplay: true });
  const label = { tenantId: access.tenantId, principals: [access.principalId], compartments: [...access.compartments], exportClass: access.maximumExportClass, mergePolicy: 'isolated' };
  const report = { schema: 'scce.native_source_brain_publication.v1', at: new Date().toISOString(), capabilityEvaluation: false,
    isolation: 'fresh_physical_database_single_backend_outer_rollback_with_adapter_savepoints',
    segmentation: 'explicit_fixture_local_bootstrap', checks: [], fixtureRolledBack: false, stages: [] };
  const tables = POSTGRES_REQUIRED_TABLES.filter(name => name !== 'storage_meta');
  let physical, outerOpen = false, root, stage = 'preflight', initial, sequence = 0;
  let queryTail = Promise.resolve();
  const physicalQuery = (sql, params) => {
    const next = queryTail.then(() => physical.query(sql, params));
    queryTail = next.then(() => undefined, () => undefined);
    return next;
  };
  const originalConnect = storage.pool.connect, originalQuery = storage.pool.query;
  const check = (name, operation) => { operation(); report.checks.push({ name, passed: true }); };
  const mark = value => { stage = value; report.stages.push({ phase: value, at: new Date().toISOString() }); };
  const counts = async () => Object.fromEntries((await storage.query(tables.map(name => `SELECT '${name}' AS name,count(*)::text AS count FROM ${storage.table(name)}`).join(' UNION ALL '))).map(row => [row.name, Number(row.count)]));
  const snapshot = async () => ({ revision: await storage.languageMemory.readRevision(), active: await storage.brainImports.active(),
    counts: await counts(), metadataDigest: hasher.digestHex(canonicalStringify(await storage.query(`SELECT key,value_json FROM ${storage.table('storage_meta')} ORDER BY key COLLATE "C"`))) });
  try {
    assert.equal((await storage.verify()).ok, true, 'Fresh verification database must already be migrated');
    initial = await snapshot();
    check('fresh-physical-database-has-no-source-learned-or-lifecycle-state', () => {
      assert.ok(Object.values(initial.counts).every(count => count === 0));
      assert.equal(initial.active.activeBrainVersion, undefined); assert.deepEqual(initial.active.activeImportRunIds, []);
    });
    physical = await storage.pool.connect();
    await physicalQuery('BEGIN'); outerOpen = true;
    storage.pool.query = physicalQuery;
    storage.pool.connect = async () => {
      const name = `publication_adapter_${++sequence}`;
      return { async query(sql, params) {
        if (sql === 'BEGIN') return physicalQuery(`SAVEPOINT ${name}`);
        if (sql === 'COMMIT') return physicalQuery(`RELEASE SAVEPOINT ${name}`);
        if (sql === 'ROLLBACK') { await physicalQuery(`ROLLBACK TO SAVEPOINT ${name}`); return physicalQuery(`RELEASE SAVEPOINT ${name}`); }
        return physicalQuery(sql, params);
      }, release() {} };
    };
    root = await mkdtemp(path.join(tmpdir(), 'scce-native-publication-'));
    const settings = { ngramMaxOrder: 2, ngramMaxCountersPerOrder: 256, ngramVocabularyLimit: 512 };
    const publicFixtureBytes = await readFile(new URL('../packages/kernel/src/__tests__/fixtures/squad-contextual-qa-family.json', import.meta.url));
    const publicFixture = JSON.parse(publicFixtureBytes.toString('utf8'));
    const rows = publicFixture.records.filter((row, index, all) => all.findIndex(other => other.context === row.context) === index).slice(0, 2);
    assert.equal(rows.length, 2, 'Committed human training fixture needs two distinct unchanged contexts');
    report.sources = { dataset: publicFixture.dataset, split: publicFixture.split, committedFixtureSha256: hasher.digestHex(publicFixtureBytes), contexts: rows.length };
    mark('normal-public-source-training');
    const publicReports = [], pages = [];
    for (const [index, row] of rows.entries()) {
      const uri = `fixture://native-publication/${suffix}/public/${index}`;
      const trained = await trainLanguageCorpusText({ storage, ...settings, languageOnly: true, skipNgramObservationPersistence: true,
        sourceSystem: 'wikipedia', sourceUri: uri, streamUri: uri, text: row.context, informationLabel: label, createdAt: 1, idFactory: ids,
        corpusMetadata: { authorship: 'human_authored', dataset: publicFixture.dataset, originalTrainingSha256: publicFixture.sha256, articleTitle: row.articleTitle, originalRecordId: row.qa.id },
        originalSource: { bytes: Buffer.from(JSON.stringify(row)), sourceUri: `${uri}/record.json`, transformId: 'native-fixture.squad-record-context.v1', kind: 'extracted-text', originalCoordinateSpace: 'source-bytes' } });
      const evidence = await storage.evidence.getEvidenceBatch(trained.artifacts.evidenceIds);
      assert.ok(evidence.length && evidence.every(span => span.status === 'promoted' && span.sourceVersionId === trained.sourceVersionId));
      const source = await storage.evidence.sourceVersionById(trained.sourceVersionId);
      assert.ok(source?.derivation && source.derivation.derivedFromSourceVersionId === trained.originalSourceVersionId);
      const ownedText = Buffer.from(await storage.blobs.get(source.contentHash)).toString('utf8');
      assert.equal(ownedText, row.context, 'Public fixture context must remain byte-exact through normal source training');
      publicReports.push(trained); pages.push({ text: ownedText, source, evidence });
    }
    check('normal-public-trainer-produced-real-derived-source-owners', () => assert.equal(publicReports.length, 2));
    mark('normal-pooled-owner-training');
    const text = pages.map(page => page.text).join('\n\n'), virtualVersion = ids.sourceVersionId(`pool:${suffix}:${text}`);
    const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId: virtualVersion, text, createdAt: 1 });
    let offset = 0;
    const sourceFamilyRanges = pages.map(page => { const row = { start: offset, end: offset + page.text.length,
      sourceFamilyId: evidenceSourceFamilyId(page.evidence[0]), sourceVersionId: page.source.sourceVersionId }; offset = row.end + 2; return row; });
    const evidence = pages.flatMap(page => page.evidence);
    const profileBinding = preparePooledLanguageProfileBinding({ profile, sourceVersionId: virtualVersion, text, evidence,
      parentSourceVersionIds: pages.map(page => page.source.sourceVersionId), sourceFamilyRanges, hasher });
    const pooled = await trainLanguageCorpusText({ storage, ...settings, sourceSystem: 'wikipedia', sourceUri: `scce://native-publication/${suffix}/pool`,
      streamUri: `scce://native-publication/${suffix}/pool`, sourceVersionId: virtualVersion, text, profile, profileBinding, sourceFamilyRanges, evidence,
      persistSource: false, persistProfile: true, languageOnly: true, skipNgramObservationPersistence: true, informationLabel: label, createdAt: 1, idFactory: ids });
    const pooledHeader = await storage.model.listLanguageProfileHeaders({ profileIds: [pooled.artifacts.languageProfileId], limit: 1 });
    const pooledModels = await storage.languageMemory.listNgramModelHeaders({ modelIds: pooled.artifacts.ngramModelIds, profileIds: [pooled.artifacts.languageProfileId], limit: pooled.artifacts.ngramModelIds.length });
    check('native-pooled-profile-header-retains-real-current-evidence-owners', () => {
      assert.equal(pooledHeader.length, 1); assert.equal(pooledHeader[0].sourceVersionId, virtualVersion);
      assert.deepEqual([...pooledHeader[0].parentSourceVersionIds].sort(), pages.map(page => page.source.sourceVersionId).sort());
      assert.equal(pooledModels.length, pooled.artifacts.ngramModelIds.length); assert.ok(pooledModels.every(row => row.profileId === pooled.artifacts.languageProfileId));
    });
    const virtualSource = await storage.evidence.sourceVersionById(virtualVersion);
    check('pooled-profile-has-no-fabricated-source-version', () => assert.equal(virtualSource, null));
    mark('normal-human-dialogue-training');
    const humanBytes = await readFile(new URL('../packages/kernel/src/__tests__/fixtures/dolly-human-creative-pair.json', import.meta.url));
    const dialogueRoot = path.join(root, 'dialogue');
    const { mkdir } = await import('node:fs/promises'); await mkdir(dialogueRoot);
    const humanPath = path.join(dialogueRoot, 'human.json'); await writeFile(humanPath, humanBytes);
    const dialogue = await trainDialogueCorpus({ storage, ...settings, rootPath: dialogueRoot, authorship: 'human_authored', informationLabel: label });
    check('normal-human-dialogue-producer-completed-without-standalone-activation', () => {
      assert.equal(dialogue.selection.languageTrainingComplete, true); assert.equal(dialogue.filesTrained, 1); assert.deepEqual(dialogue.filesSkipped, []);
      assert.equal(dialogue.sourceBrainBuild, undefined);
    });
    mark('normal-mixed-public-oss-and-book-training');
    const codeBytes = await readFile(new URL('../packages/adapters-node/src/path-glob.ts', import.meta.url));
    const docsBytes = await readFile(new URL('../README.md', import.meta.url));
    const bookFixtureBytes = await readFile(new URL('../packages/kernel/src/__tests__/fixtures/alice-acquisition-excerpt.txt', import.meta.url));
    // Same contiguous public-domain prefix used by the mixed-manifest producer regression.
    const bookBytes = Buffer.from(bookFixtureBytes.toString('utf8').slice(0, 2200));
    const repoRoot = path.join(root, 'repo'), booksRoot = path.join(root, 'books'), bookPath = path.join(booksRoot, 'alice.txt');
    await mkdir(path.join(repoRoot, 'src'), { recursive: true }); await mkdir(booksRoot);
    await writeFile(path.join(repoRoot, 'src', 'path-glob.ts'), codeBytes); await writeFile(path.join(repoRoot, 'README.md'), docsBytes); await writeFile(bookPath, bookBytes);
    const ossUri = `fixture://native-publication/${suffix}/repo`;
    const mixedPlanItems = [
      { canonicalUri: `${ossUri}#path=src%2Fpath-glob.ts`, contentHash: hasher.digestHex(codeBytes), sourceFileHash: hasher.digestHex(codeBytes), byteLength: codeBytes.byteLength,
        projections: [{ sourceSystemId: CORPUS_SOURCE_SYSTEM_IDS.ossCode, projection: 'code_surface_tokens', transformId: `${CODE_SURFACE_RECIPE_ID}:code_surface_tokens` },
          { sourceSystemId: CORPUS_SOURCE_SYSTEM_IDS.ossDocs, projection: 'code_adjacent_prose' }] },
      { canonicalUri: `${ossUri}#path=README.md`, contentHash: hasher.digestHex(docsBytes), sourceFileHash: hasher.digestHex(docsBytes), byteLength: docsBytes.byteLength,
        projections: [{ sourceSystemId: CORPUS_SOURCE_SYSTEM_IDS.ossDocs, projection: 'verbatim' }] },
      { canonicalUri: pathToFileURL(bookPath).href, contentHash: hasher.digestHex(bookBytes), sourceFileHash: hasher.digestHex(bookBytes), byteLength: bookBytes.byteLength,
        projections: [{ sourceSystemId: CORPUS_SOURCE_SYSTEM_IDS.gutenberg, transformId: 'scce.gutenberg.boilerplate-strip.v1' }] }
    ];
    const beforeSourceTraining = createSourceBrainFileAdmission({ schema: 'scce.storedSourceBrainPlan.v1', sourceId: `native-publication.${suffix}`,
      rootPath: root, selectedItems: mixedPlanItems, reportFiles: [{ path: 'oss.json' }, { path: 'books.json' }] });
    const oss = await trainOssCorpus({ storage, ...settings, beforeSourceTraining, rootPath: repoRoot, sourceUriBase: ossUri, maxFiles: 20, maxFilesPerRun: 20 });
    const books = await trainGutenbergCorpus({ storage, ...settings, beforeSourceTraining, rootPath: booksRoot, maxFilesPerRun: 20 });
    check('normal-oss-and-gutenberg-producers-complete-without-separate-activation', () => {
      assert.deepEqual(oss.filesSkipped, []); assert.equal(oss.sourceContractClosure.complete, true); assert.equal(oss.reports.length, 3);
      assert.deepEqual(books.filesSkipped, []); assert.equal(books.reports.length, 1); assert.equal(books.stoppedByHeapSafetyBound, false);
      assert.equal(oss.sourceBrainBuild, undefined); assert.equal(books.sourceBrainBuild, undefined);
    });
    const rawCodeParents = [];
    for (const item of oss.reports.filter(row => row.streamUri.endsWith('src/path-glob.ts'))) {
      const parent = await storage.evidence.sourceVersionById(item.originalSourceVersionId); assert.ok(parent);
      assert.equal(parent.canonicalUri, mixedPlanItems[0].canonicalUri); assert.deepEqual(Buffer.from(await storage.blobs.get(parent.contentHash)), codeBytes);
      rawCodeParents.push(parent.sourceVersionId);
    }
    check('code-and-adjacent-prose-retain-distinct-real-raw-parents', () => { assert.equal(rawCodeParents.length, 2); assert.equal(new Set(rawCodeParents).size, 2); });
    report.mixedPublicSources = { code: { path: 'packages/adapters-node/src/path-glob.ts', sha256: hasher.digestHex(codeBytes), bytes: codeBytes.byteLength },
      docs: { path: 'README.md', sha256: hasher.digestHex(docsBytes), bytes: docsBytes.byteLength },
      book: { path: 'packages/kernel/src/__tests__/fixtures/alice-acquisition-excerpt.txt', committedSha256: hasher.digestHex(bookFixtureBytes), prefixCodeUnits: 2200, sha256: hasher.digestHex(bookBytes), bytes: bookBytes.byteLength } };
    mark('normal-explicit-stored-replay');
    const stored = await trainStoredCorpusConstructions({ storage, ...settings, sourceSystem: 'wikipedia', languageOnly: true,
      sourceVersionIds: pages.map(page => page.source.sourceVersionId), minArticleBytes: 0, maxArticleBytes: 1024 * 1024,
      maxTotalBytes: 1024 * 1024, batchBytes: 1024 * 1024, maxSourceAttempts: pages.length, sourcePageSize: pages.length });
    check('normal-stored-replay-reports-full-current-owner-artifacts', () => {
      assert.equal(stored.selection.languageTrainingComplete, true); assert.equal(stored.articlesTrained, pages.length);
      assert.deepEqual(stored.sourcesSkipped, []); assert.deepEqual(stored.batchesFailed, []);
      assert.ok(stored.reports.every(row => row.segmentation.mode === 'local_bootstrap' && row.ngramModels > 0));
    });
    const reports = [...stored.reports, ...dialogue.reports, ...oss.reports, ...books.reports];
    const profiles = await storage.model.listLanguageProfileHeaders({ profileIds: reports.map(row => row.artifacts.languageProfileId), limit: reports.length });
    const models = await storage.languageMemory.listNgramModelHeaders({ modelIds: reports.flatMap(row => row.artifacts.ngramModelIds), profileIds: profiles.map(row => row.id), limit: reports.reduce((sum, row) => sum + row.artifacts.ngramModelIds.length, 0) });
    check('native-direct-profile-and-model-headers-match-normal-reports', () => {
      assert.equal(profiles.length, reports.length);
      assert.equal(models.length, reports.reduce((sum, row) => sum + row.artifacts.ngramModelIds.length, 0));
      assert.ok(reports.every(row => profiles.some(profile => profile.id === row.artifacts.languageProfileId && profile.sourceVersionId === row.sourceVersionId)));
    });
    const storedBytes = Buffer.from(JSON.stringify(stored)), dialogueBytes = Buffer.from(JSON.stringify(dialogue)), ossBytes = Buffer.from(JSON.stringify(oss)), booksBytes = Buffer.from(JSON.stringify(books));
    await writeFile(path.join(root, 'stored.json'), storedBytes); await writeFile(path.join(root, 'dialogue.json'), dialogueBytes);
    await writeFile(path.join(root, 'oss.json'), ossBytes); await writeFile(path.join(root, 'books.json'), booksBytes);
    const selected = sourceBrainSelectedItemsFromReports(reports), selectedItems = [];
    for (const item of sourceBrainSelectedItemsFromReports([...stored.reports, ...dialogue.reports])) {
      const version = await storage.evidence.sourceVersionById(item.sourceVersionId);
      selectedItems.push({ ...item, canonicalUri: version.canonicalUri,
        ...(version.canonicalUri === pathToFileURL(humanPath).href ? { sourceFileHash: hasher.digestHex(humanBytes) } : {}) });
    }
    selectedItems.push(...mixedPlanItems);
    const plan = { schema: 'scce.storedSourceBrainPlan.v1', sourceId: `native-publication.${suffix}`, rootPath: root, selectedItems,
      reportFiles: [{ path: 'stored.json', sha256: hasher.digestHex(storedBytes) }, { path: 'dialogue.json', sha256: hasher.digestHex(dialogueBytes) },
        { path: 'oss.json', sha256: hasher.digestHex(ossBytes) }, { path: 'books.json', sha256: hasher.digestHex(booksBytes) }] };
    const manifestBytes = Buffer.from(JSON.stringify(plan)), manifestPath = path.join(root, 'plan.json'); await writeFile(manifestPath, manifestBytes);
    const byteBudget = manifestBytes.byteLength + storedBytes.byteLength + dialogueBytes.byteLength + ossBytes.byteLength + booksBytes.byteLength;
    const finalizerInput = { storage, informationLabel: label, manifestPath, maxTotalBytes: byteBudget };
    mark('partial-cohort-refusal');
    const partialBytes = Buffer.from(JSON.stringify({ ...stored, stoppedByHeapSafetyBound: true }));
    const partialPlan = { ...plan, reportFiles: [{ path: 'partial-stored.json', sha256: hasher.digestHex(partialBytes) }, ...plan.reportFiles.slice(1)] };
    const partialManifestBytes = Buffer.from(JSON.stringify(partialPlan)), partialPath = path.join(root, 'partial-plan.json');
    await writeFile(path.join(root, 'partial-stored.json'), partialBytes); await writeFile(partialPath, partialManifestBytes);
    await assert.rejects(finalizeCorpusBrainManifest({ ...finalizerInput, manifestPath: partialPath,
      maxTotalBytes: partialManifestBytes.byteLength + partialBytes.byteLength + dialogueBytes.byteLength + ossBytes.byteLength + booksBytes.byteLength }), /complete stored-source/);
    const missingProjection = { ...oss, reports: oss.reports.filter(row => row.sourceSystemId !== CORPUS_SOURCE_SYSTEM_IDS.ossDocs || !row.streamUri.endsWith('src/path-glob.ts')), docsTrained: oss.docsTrained - 1 };
    const missingBytes = Buffer.from(JSON.stringify(missingProjection)); await writeFile(path.join(root, 'missing-projection.json'), missingBytes);
    const missingPlan = { ...plan, reportFiles: plan.reportFiles.map(item => item.path === 'oss.json' ? { path: 'missing-projection.json', sha256: hasher.digestHex(missingBytes) } : item) };
    const missingPlanBytes = Buffer.from(JSON.stringify(missingPlan)), missingPlanPath = path.join(root, 'missing-projection-plan.json'); await writeFile(missingPlanPath, missingPlanBytes);
    await assert.rejects(finalizeCorpusBrainManifest({ ...finalizerInput, manifestPath: missingPlanPath,
      maxTotalBytes: missingPlanBytes.byteLength + storedBytes.byteLength + dialogueBytes.byteLength + missingBytes.byteLength + booksBytes.byteLength }), /projection/);
    check('missing-owned-code-prose-projection-cannot-register-a-brain', () => {});
    const partialBooksBytes = Buffer.from(JSON.stringify({ ...books, stoppedByHeapSafetyBound: true })); await writeFile(path.join(root, 'partial-books.json'), partialBooksBytes);
    const partialBooksPlan = { ...plan, reportFiles: plan.reportFiles.map(item => item.path === 'books.json' ? { path: 'partial-books.json', sha256: hasher.digestHex(partialBooksBytes) } : item) };
    const partialBooksPlanBytes = Buffer.from(JSON.stringify(partialBooksPlan)), partialBooksPath = path.join(root, 'partial-books-plan.json'); await writeFile(partialBooksPath, partialBooksPlanBytes);
    await assert.rejects(finalizeCorpusBrainManifest({ ...finalizerInput, manifestPath: partialBooksPath,
      maxTotalBytes: partialBooksPlanBytes.byteLength + storedBytes.byteLength + dialogueBytes.byteLength + ossBytes.byteLength + partialBooksBytes.byteLength }), /complete normal Gutenberg/);
    check('partial-normal-book-report-cannot-register-a-brain', () => {});
    const afterPartialActive = await storage.brainImports.active(), beforeReady = await counts();
    check('partial-cohort-never-registers-or-activates', () => {
      assert.deepEqual(afterPartialActive.activeImportRunIds, []); assert.equal(afterPartialActive.activeBrainVersion, undefined);
      assert.equal(beforeReady.brain_import_lifecycle, 0);
    });
    mark('canonical-projection-parent-refusal');
    const codeProjection = oss.reports.find(row => row.sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.ossCode);
    assert.ok(codeProjection, 'Native fixture needs a normal code projection');
    const adjacentProjection = oss.reports.find(row => row.sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.ossDocs && row.originalSourceVersionId !== codeProjection.originalSourceVersionId
      && rawCodeParents.includes(row.originalSourceVersionId));
    assert.ok(adjacentProjection, 'Native fixture needs both real same-file projection parents');
    await physicalQuery('SAVEPOINT publication_missing_parent');
    await storage.query(`UPDATE ${storage.table('source_versions')} SET metadata_json=jsonb_set(metadata_json,'{_scceSourceVersion,derivation}','null'::jsonb) WHERE id=$1`, [codeProjection.sourceVersionId]);
    await assert.rejects(finalizeCorpusBrainManifest(finalizerInput), /exact canonical source\/parent/);
    assert.equal((await counts()).brain_import_lifecycle, 0);
    await physicalQuery('ROLLBACK TO SAVEPOINT publication_missing_parent'); await physicalQuery('RELEASE SAVEPOINT publication_missing_parent');
    check('missing-canonical-projection-derivation-cannot-register-a-brain', () => {});
    await physicalQuery('SAVEPOINT publication_foreign_parent');
    await storage.query(`UPDATE ${storage.table('source_versions')} SET metadata_json=jsonb_set(metadata_json,'{_scceSourceVersion,derivation,derivedFromSourceVersionId}',to_jsonb($2::text)) WHERE id=$1`, [codeProjection.sourceVersionId, adjacentProjection.originalSourceVersionId]);
    await assert.rejects(finalizeCorpusBrainManifest(finalizerInput), /exact canonical source\/parent/);
    assert.equal((await counts()).brain_import_lifecycle, 0);
    await physicalQuery('ROLLBACK TO SAVEPOINT publication_foreign_parent'); await physicalQuery('RELEASE SAVEPOINT publication_foreign_parent');
    check('same-uri-same-bytes-foreign-projection-parent-cannot-register-a-brain', () => {});
    mark('canonical-ready-validation');
    const selectedIds = selected.map(row => row.sourceVersionId);
    const ready = await completeInitialSourceBrainBuild({ storage, informationLabel: label, sourceId: plan.sourceId, sourceSchema: plan.schema,
      rootPath: plan.rootPath, sourceManifestHash: hasher.digestHex(manifestBytes), selectedItems: selected, reports,
      configuration: { maxTotalBytes: byteBudget }, completion: { explicitSelection: true, selectedItemIds: selectedIds, completedItemIds: selectedIds,
        stoppedByHeapSafetyBound: false, interrupted: false, skippedRequiredItemIds: [] }, activate: false });
    check('canonical-validation-produces-ready-with-learned-identities', () => {
      assert.equal(ready.lifecycle.state, 'READY'); assert.equal(ready.report.disposition, 'PASSED'); assert.equal(ready.active, false);
      assert.ok(ready.report.checks.every(row => row.passed));
    });
    const parentIds = pages.map(page => page.source.derivation.derivedFromSourceVersionId);
    check('replay-manifest-retains-real-source-parent-chain', () => assert.ok(parentIds.every(id => ready.lifecycle.manifest.replayManifest.componentIds.includes(id))));
    const mixedParentIds = [...oss.reports, ...books.reports].map(row => row.originalSourceVersionId);
    check('mixed-manifest-retains-every-real-code-prose-docs-book-parent', () => assert.ok(mixedParentIds.every(id => ready.lifecycle.manifest.replayManifest.componentIds.includes(id))));
    const invalidatedId = stored.reports[0].artifacts.evidenceIds[0];
    mark('stale-ready-refusal');
    await physicalQuery('SAVEPOINT publication_ready_negative');
    await storage.query(`UPDATE ${storage.table('evidence_spans')} SET status='quarantined' WHERE id=$1`, [invalidatedId]);
    await assert.rejects(finalizeCorpusBrainManifest(finalizerInput), /ready source brain no longer satisfies canonical source\/artifact validation/);
    const staleReadyActive = await storage.brainImports.active(), staleReadyLifecycle = await storage.brainImports.getLifecycle(ready.lifecycle.importRunId);
    await physicalQuery('ROLLBACK TO SAVEPOINT publication_ready_negative'); await physicalQuery('RELEASE SAVEPOINT publication_ready_negative');
    check('fresh-failed-validation-cannot-activate-existing-ready', () => {
      assert.deepEqual(staleReadyActive.activeImportRunIds, []); assert.equal(staleReadyActive.activeBrainVersion, undefined); assert.equal(staleReadyLifecycle.state, 'READY');
    });
    mark('canonical-manifest-finalization');
    const active = await finalizeCorpusBrainManifest(finalizerInput);
    check('combined-manifest-activates-the-same-validated-ready-brain', () => {
      assert.equal(active.status, 'activated'); assert.equal(active.active, true); assert.equal(active.importRunId, ready.lifecycle.importRunId);
      assert.deepEqual((active.checks ?? []).filter(row => !row.passed), []);
    });
    const activeMarker = await storage.brainImports.active();
    assert.equal(activeMarker.activeBrainVersion, ready.lifecycle.brainVersion); assert.deepEqual(activeMarker.activeImportRunIds, [ready.lifecycle.importRunId]);
    const revisionBeforeReplay = await storage.languageMemory.readRevision();
    const replay = await finalizeCorpusBrainManifest(finalizerInput);
    check('same-current-cohort-finalization-is-idempotent', () => { assert.equal(replay.active, true); assert.equal(replay.idempotent, true); assert.equal(replay.importRunId, active.importRunId); });
    const revisionAfterReplay = await storage.languageMemory.readRevision();
    check('idempotent-finalization-does-not-rewrite-language-state', () => assert.equal(revisionAfterReplay, revisionBeforeReplay));
    mark('stale-active-refusal');
    await physicalQuery('SAVEPOINT publication_active_negative');
    await storage.query(`UPDATE ${storage.table('evidence_spans')} SET status='quarantined' WHERE id=$1`, [invalidatedId]);
    await assert.rejects(finalizeCorpusBrainManifest(finalizerInput), /active source brain no longer satisfies canonical source\/artifact validation/);
    const revokedPooled = await storage.model.listLanguageProfileHeaders({ profileIds: [pooled.artifacts.languageProfileId], limit: 1 });
    const revokedModels = await storage.languageMemory.listNgramModelHeaders({ modelIds: pooled.artifacts.ngramModelIds, profileIds: [pooled.artifacts.languageProfileId], limit: pooled.artifacts.ngramModelIds.length });
    await physicalQuery('ROLLBACK TO SAVEPOINT publication_active_negative'); await physicalQuery('RELEASE SAVEPOINT publication_active_negative');
    check('active-replay-and-pooled-headers-refuse-revoked-current-support', () => { assert.deepEqual(revokedPooled, []); assert.deepEqual(revokedModels, []); });
    report.fixtureArtifacts = { selectedOwners: selected.length, directReportedProfiles: profiles.length, directReportedNgramStructures: models.length,
      pooledProfiles: pooledHeader.length, pooledNgramStructures: pooledModels.length, parentVersions: parentIds.length, mixedRawParentVersions: mixedParentIds.length,
      activeBrainVersion: active.activeBrainVersion, observedFixtureCounts: await counts() };
  } catch (error) {
    report.error = { stage, name: error?.name ?? 'Error', code: typeof error?.code === 'string' ? error.code : null,
      lastPassedCheck: report.checks.at(-1)?.name ?? null };
  } finally {
    if (outerOpen) { try { await physicalQuery('ROLLBACK'); report.fixtureRolledBack = true; }
      catch (error) { report.error ??= { stage: 'outer-rollback', name: error?.name ?? 'Error', code: typeof error?.code === 'string' ? error.code : null }; } }
    try {
      if (initial && report.fixtureRolledBack) {
        const restored = await snapshot();
        check('outer-rollback-retains-zero-fixture-source-and-learned-records', () => assert.deepEqual(restored.counts, initial.counts));
        check('outer-rollback-restores-revision-and-storage-metadata', () => { assert.equal(restored.revision, initial.revision); assert.equal(restored.metadataDigest, initial.metadataDigest); });
        check('outer-rollback-restores-empty-active-marker', () => assert.deepEqual(restored.active, initial.active));
      }
    } catch (error) { report.error ??= { stage: 'rollback-verification', name: error?.name ?? 'Error', code: typeof error?.code === 'string' ? error.code : null }; }
    storage.pool.connect = originalConnect; storage.pool.query = originalQuery; physical?.release(); await storage.close();
    if (root) {
      const resolved = path.resolve(root);
      if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('scce-native-publication-')) throw Error('Unexpected disposable fixture directory');
      await rm(resolved, { recursive: true, force: true });
    }
  }
  report.passed = !report.error && report.fixtureRolledBack;
  if (options.outputPath) await writeFile(options.outputPath, JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await verifySourceBrainPublication(parseSourceBrainPublicationArgs(process.argv.slice(2)));
    console.log(JSON.stringify(report));
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({ schema: 'scce.native_source_brain_publication.v1', capabilityEvaluation: false, passed: false,
      error: { stage: 'startup-or-cleanup', name: error?.name ?? 'Error', code: typeof error?.code === 'string' ? error.code : null } }));
    process.exitCode = 1;
  }
}
