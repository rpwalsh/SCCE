import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { captureHostConfiguration } from '../sealed-eval/harness/lib/host-configuration.mjs';
import { fileHash, hash } from './protocol.mjs';
import { verifyCandidateFinalization } from './candidate-finalization.mjs';

export const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const exec = promisify(execFile);
export async function discoverConfig(configFile = path.join(REPOSITORY_ROOT, 'scce.config.json')) {
  const modulePath = new URL('../../packages/adapters-node/dist/index.js', import.meta.url);
  const adapter = await import(modulePath.href);
  const config = await adapter.readScceRuntimeConfig(configFile);
  const supplied = process.env.SCCE_API_BEARER_TOKEN?.trim() || config.security?.apiBearerToken;
  const token = supplied?.startsWith('enc:v1:') ? adapter.resolveSecret(supplied, config, 'SCCE API bearer token') : supplied;
  const server = new URL(config.server.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(server.hostname) || server.username || server.password) throw new Error('Default campaign requires a credential-free local SCCE URL');
  return { configFile: path.resolve(configFile), server: server.href, schema: config.database.schema, allowedRoots: config.runtime.allowedRoots, token, publicConfigHash: hash({ server: server.href, schema: config.database.schema, runtime: { workspaceRoot: config.runtime.workspaceRoot, allowedRoots: config.runtime.allowedRoots, excludedPaths: config.runtime.excludedPaths }, policy: config.policy, patchValidation: config.runtime.patchValidation }) };
}
async function executable(name) {
  if (path.isAbsolute(name)) { await access(name); return name; }
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) for (const ext of ['', ...extensions]) {
    const target = path.join(dir, name + ext.toLowerCase());
    try { await access(target); return target; } catch {}
  }
  return null;
}
export async function discoverNativeTools(budgets, dependencies = {}) {
  const find = dependencies.executable ?? executable;
  const resolveVerifier = dependencies.findVerifierCapability ?? (async language => {
    const adapter = await import(new URL('../../packages/adapters-node/dist/index.js', import.meta.url).href);
    return adapter.findCodeVerifierCapability(language);
  });
  const tools = { node: { available: true, path: process.execPath, version: process.version, sha256: await fileHash(process.execPath) }, javascript: { available: true, path: process.execPath, version: process.version, budget: { timeMs: budgets.timeMs, outputBytes: budgets.outputBytes } } };
  const require = createRequire(import.meta.url);
  try {
    const compilerPath = require.resolve('typescript/bin/tsc');
    tools.typescript = { available: true, compilerPath, version: JSON.parse(await readFile(require.resolve('typescript/package.json'), 'utf8')).version, sha256: await fileHash(compilerPath), budget: { timeMs: budgets.timeMs, outputBytes: budgets.outputBytes } };
  } catch { tools.typescript = { available: false, reason: 'Install the frozen repository TypeScript dependency.' }; }
  for (const language of ['python', 'rust', 'go']) {
    const capability = await resolveVerifier(language);
    if (capability.status !== 'available') { tools[language] = { available: false, reason: capability.reason }; continue; }
    const resolved = await find(capability.verifier.command);
    tools[language] = resolved ? { available: true, path: resolved, version: capability.verifier.version, sha256: await fileHash(resolved), discovery: 'canonical_findCodeVerifierCapability', budget: { timeMs: budgets.timeMs, outputBytes: budgets.outputBytes } }
      : { available: false, reason: `Canonical ${language} checker was found but its executable could not be resolved for hashing: ${capability.verifier.command}` };
  }
  return tools;
}
export async function discoverCampaign(options, dependencies = {}) {
  const config = await (dependencies.config ?? discoverConfig)(options.configFile);
  const host = await (dependencies.host ?? captureHostConfiguration)([]);
  const model = host.ollama?.installedModels?.find(m => m.name === 'qwen2.5:3b');
  if (!model?.digest || !/^[a-f0-9]{64}$/u.test(model.digest)) throw new Error('The requested local reference is not installed with a stable digest.');
  const request = dependencies.request ?? (async () => {
    const response = await fetch(new URL('/api/ready?detail=readiness', config.server), { headers: config.token ? { authorization: `Bearer ${config.token}` } : {}, signal: AbortSignal.timeout(options.budgets.timeMs) });
    if (!response.ok) throw new Error(`SCCE readiness returned HTTP ${response.status}`);
    return response.json();
  });
  const ready = await request();
  const finalization = await (dependencies.finalization ?? (async () => {
    const response = await fetch(new URL('/api/language/finalization', config.server), { headers: config.token ? { authorization: `Bearer ${config.token}` } : {}, signal: AbortSignal.timeout(options.budgets.timeMs) });
    if (!response.ok) throw new Error(`Candidate finalization inspection returned HTTP ${response.status}`);
    return response.json();
  }))();
  verifyCandidateFinalization(finalization);
  const tools = await (dependencies.tools ?? discoverNativeTools)(options.budgets);
  return { config, model, tools, finalization, publicSnapshot: { schema: 'scce.blind-local-discovery.v1', model, referenceRuntime: { version: host.ollama?.version ?? null }, host: { node: host.node, os: host.os }, candidate: { server: config.server, schema: config.schema, publicConfigHash: config.publicConfigHash, readinessHash: hash(ready), finalizationDigest: hash(finalization) }, hardwarePolicy: { requestedDevice: options.device, threads: options.threads ?? os.availableParallelism() }, limitations: 'Trusted-host process collection; no automatic OS, network, CPU/RAM/GPU isolation or source-admission equivalence certification.' } };
}
export async function implementationFiles(root = REPOSITORY_ROOT) {
  const { stdout } = await exec('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  const tracked = stdout.split('\0').filter(Boolean).map(name => path.join(root, name));
  const built = [];
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Build pinning does not follow symbolic links');
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) built.push(target);
    }
  }
  for (const pkg of ['kernel', 'adapters-node', 'server', 'cli']) await walk(path.join(root, 'packages', pkg, 'dist'));
  return [...new Set([...tracked, ...built])].sort();
}
