// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const refusal = message => Object.assign(Error(message), { publicMessage: message });

export function parseArguments(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = { '--config': 'config', '--output-config': 'outputConfig', '--database-name': 'databaseName' }[args[index]];
    const value = args[index + 1];
    if (!key || parsed[key] !== undefined || !value || value.startsWith('--')) throw refusal('Expected --config <local-config.json> --output-config <new-ignored-path> [--database-name <new-name>]');
    parsed[key] = value;
  }
  if (!parsed.config || !parsed.outputConfig) throw refusal('Both --config and --output-config are required');
  if (parsed.databaseName !== undefined) validateDatabaseName(parsed.databaseName);
  return parsed;
}

export function validateDatabaseName(name) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw refusal('Database name must be 1–63 lowercase ASCII letters/digits/underscores, starting with a letter');
  return name;
}

const exists = async target => { try { await lstat(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
export async function verifyOutputPath(target) {
  const absolute = path.resolve(target);
  if (await exists(absolute)) throw refusal('Output config already exists; refusing overwrite');
  if (await exists(absolute.replace(/(\.json)?$/i, '') + '.local.json')) throw refusal('Output config has an existing local overlay; choose a new path');
  const parent = await realpath(path.dirname(absolute));
  const physical = path.join(parent, path.basename(absolute));
  let root;
  try { root = execFileSync('git', ['-C', parent, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { throw refusal('Output config must be inside a Git worktree with an existing parent directory'); }
  const relative = path.relative(await realpath(root), physical);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw refusal('Output config escapes its Git worktree');
  const gitPath = relative.split(path.sep).join('/');
  try { execFileSync('git', ['-C', root, 'ls-files', '--error-unmatch', '--', gitPath], { stdio: 'ignore' }); }
  catch (error) { if (error.status !== 1) throw refusal('Could not verify output tracking status'); }
  // check-ignore without --no-index also refuses tracked paths, even when an ignore rule matches them.
  try { execFileSync('git', ['-C', root, 'check-ignore', '--quiet', '--', gitPath], { stdio: 'ignore' }); }
  catch { throw refusal('Output config is not Git-ignored; credentials must never be written to a tracked/public path'); }
  return physical;
}

export async function createBrainDatabase(options, dependencies = {}) {
  if ((dependencies.environment ?? process.env).SCCE_DATABASE_URL?.trim()) throw refusal('Unset SCCE_DATABASE_URL before creating a brain; it would override the new config database');
  const output = await verifyOutputPath(options.outputConfig);
  const api = dependencies.api ?? await import('../packages/adapters-node/dist/index.js');
  const base = await api.readScceRuntimeConfig(options.config);
  const url = new URL(base.database.url);
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)) throw refusal('New brain creation supports configured local PostgreSQL only');
  const databaseName = validateDatabaseName(options.databaseName ?? `scce_brain_${randomBytes(12).toString('hex')}`);
  if (decodeURIComponent(url.pathname.slice(1)) === databaseName) throw refusal('New database name equals the configured existing database');
  const admin = api.createPostgresStorageAdapter({ ...base.database, informationAccess: base.security.informationAccess });
  const report = { schema: 'scce.new_brain_database.v1', databaseName, databaseSchema: base.database.schema,
    at: new Date().toISOString(), createdDatabase: false, migrated: false, verified: false, configWritten: false,
    learnedDataCopied: false, capabilityEvaluation: false, checks: [] };
  let handle, fresh;
  try {
    const existing = await admin.query('SELECT 1 AS present FROM pg_database WHERE datname=$1', [databaseName]);
    if (existing.length) throw refusal('Database already exists; refusing reuse');
    // Reserve the ignored output before CREATE DATABASE; wx refuses concurrent output creation/symlinks.
    handle = await open(output, 'wx', 0o600);
    await admin.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0 ENCODING 'UTF8'`);
    report.createdDatabase = true;
    url.pathname = `/${databaseName}`;
    const next = structuredClone(base);
    next.database = { ...next.database, url: url.toString() };
    delete next.runtime.corpusSegmentation;
    api.validateConfig(next, 'new brain config');
    // The canonical loader resolves paths/overlays first; serializing its effective config preserves those paths
    // even when the new config lives in another directory. No old global segmentation declaration survives.
    await handle.writeFile(JSON.stringify(next, null, 2));
    await handle.sync();
    report.configWritten = true;
    fresh = api.createPostgresStorageAdapter({ ...next.database, informationAccess: next.security.informationAccess });
    await fresh.migrate(); report.migrated = true;
    const verified = await fresh.verify();
    if (!verified.ok) throw refusal('Fresh database schema verification failed');
    report.verified = true;
    const tables = ['sources', 'source_versions', 'evidence_spans', 'language_profiles', 'language_profile_signatures',
      'language_identities', 'ngram_models', 'ngram_observations', 'language_units', 'language_unit_evidence_sets',
      'language_unit_information_labels', 'language_patterns', 'semantic_frames',
      'induced_language_models', 'segmentation_population_models', 'segmentation_consolidation_runs', 'brain_import_lifecycle',
      'creative_event_templates', 'creative_event_lexemes', 'creative_event_witnesses', 'creative_event_occurrences',
      'model_state', 'translation_alignments', 'correction_rules', 'target_profile_patterns', 'locale_bundles',
      'segmentation_aggregates', 'segmentation_consolidation_active'];
    report.counts = {};
    for (const table of tables) {
      const [row] = await fresh.query(`SELECT count(*)::text AS count FROM ${fresh.table(table)}`);
      if (row.count !== '0') throw refusal('Fresh database contains source or learned rows');
      report.counts[table] = 0;
    }
    report.checks.push('new_physical_database', 'template0_utf8', 'canonical_migration_verified', 'source_and_learned_tables_empty', 'previous_segmentation_declaration_removed');
    report.passed = true;
    return report;
  } catch (error) {
    // Never DROP a database, including a partially initialized one. Preserve its new config for diagnosis.
    if (handle && !report.createdDatabase) { await handle.close(); handle = undefined; await unlink(output); }
    const message = report.createdDatabase ? 'New database retained after initialization failure; inspect the ignored output config and rerun verification' : error.publicMessage ?? 'Database creation failed; inspect local configuration and permissions';
    const safe = refusal(message);
    safe.receipt = { ...report, passed: false, error: message, errorCode: typeof error.code === 'string' ? error.code : null };
    throw safe;
  } finally {
    await handle?.close();
    await fresh?.close();
    await admin.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await createBrainDatabase(parseArguments(process.argv.slice(2))))); }
  catch (error) {
    // Driver messages can contain connection details. Only the nonsecret receipt leaves this process.
    console.error(JSON.stringify(error.receipt ?? { schema: 'scce.new_brain_database.v1', passed: false, capabilityEvaluation: false, error: error.publicMessage ?? 'Configuration or database setup failed; inspect the local configuration and permissions' }));
    process.exitCode = 1;
  }
}
