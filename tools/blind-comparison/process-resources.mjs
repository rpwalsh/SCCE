import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const exec = promisify(execFile);
const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const positive = n => Number.isSafeInteger(n) && n > 0;
export function cpuTimeSeconds(text) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/u.exec(String(text));
  return match ? Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 + Number(match[3]) * 60 + Number(match[4]) : null;
}
export function parseProcessTable(platform, text) {
  if (platform === 'win32') {
    const parsed = JSON.parse(text.trim() || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed]).map(row => ({ pid: Number(row.pid), parentPid: Number(row.parentPid), birth: row.birth ?? null,
      rssBytes: row.rssBytes == null ? null : Number(row.rssBytes), cpuSeconds: row.cpuTicks == null ? null : Number(row.cpuTicks) / 10_000_000 }));
  }
  return text.split(/\r?\n/u).filter(line => line.trim()).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u.exec(line);
    if (!match) throw new Error('unrecognized-process-row');
    return { pid: Number(match[1]), parentPid: Number(match[2]), rssBytes: Number(match[3]) * 1024,
      cpuSeconds: cpuTimeSeconds(match[4]), birth: Number.isFinite(Date.parse(match[5])) ? match[5] : null };
  });
}
export async function processSnapshot(policy = {}, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform, started = performance.now();
  if (!['win32', 'linux', 'darwin'].includes(platform)) return { rows: null, reason: 'unsupported-platform', elapsedMs: 0 };
  const powershell = '$ErrorActionPreference="Stop"; @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;birth=if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString("o")}else{$null};rssBytes=$_.WorkingSetSize;cpuTicks=if($null -ne $_.UserModeTime -and $null -ne $_.KernelModeTime){[double]$_.UserModeTime+[double]$_.KernelModeTime}else{$null}} }) | ConvertTo-Json -Compress';
  try {
    const { stdout } = await (dependencies.exec ?? exec)(platform === 'win32' ? 'powershell.exe' : 'ps', platform === 'win32'
      ? ['-NoProfile', '-NonInteractive', '-Command', powershell] : ['-axo', 'pid=,ppid=,rss=,time=,lstart='],
    { windowsHide: true, timeout: policy.probeTimeoutMs ?? 3000, maxBuffer: policy.maxProbeOutputBytes ?? 8 * 1024 * 1024,
      encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
    const rows = parseProcessTable(platform, stdout).filter(row => row.pid !== 0);
    if (rows.some(row => !positive(row.pid) || !Number.isSafeInteger(row.parentPid) || row.parentPid < 0
      || row.birth !== null && (typeof row.birth !== 'string' || !row.birth) || row.rssBytes !== null && !finite(row.rssBytes) || row.cpuSeconds !== null && !finite(row.cpuSeconds))) throw new Error('invalid-process-counters');
    return { rows, reason: null, elapsedMs: performance.now() - started };
  } catch (error) { return { rows: null, reason: error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'probe-output-budget' : error.killed ? 'probe-timeout' : String(error.code ?? 'probe-unavailable'), elapsedMs: performance.now() - started }; }
}
export function validateProcessPolicy(raw) {
  const only = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
  if (!raw || raw.schema !== 'scce.blind-process-policy.v1' || raw.provider !== 'trusted-host-native-process-table.v1'
    || !only(raw, ['schema', 'provider', 'sampleIntervalMs', 'probeTimeoutMs', 'maxProbeOutputBytes', 'rssBudgetBytes', 'systems'])
    || !positive(raw.sampleIntervalMs) || !positive(raw.probeTimeoutMs) || !positive(raw.maxProbeOutputBytes)
    || raw.rssBudgetBytes !== null && !positive(raw.rssBudgetBytes) || !raw.systems || typeof raw.systems !== 'object' || Array.isArray(raw.systems)) throw new Error('Invalid frozen process measurement policy');
  for (const system of Object.values(raw.systems)) {
    if (!only(system, ['sharedDaemons']) || !Array.isArray(system.sharedDaemons) || new Set(system.sharedDaemons.map(row => row.pid)).size !== system.sharedDaemons.length
      || system.sharedDaemons.some(row => !only(row, ['id', 'pid', 'birth']) || typeof row.id !== 'string' || !row.id || !positive(row.pid) || typeof row.birth !== 'string' || !row.birth)) throw new Error('Declare unique shared daemon PID and birth identity');
  }
  return raw;
}
export async function resolveProcessPolicy(raw, snapshot = processSnapshot) {
  const policy = { schema: 'scce.blind-process-policy.v1', provider: 'trusted-host-native-process-table.v1', sampleIntervalMs: 1000,
    probeTimeoutMs: 3000, maxProbeOutputBytes: 8 * 1024 * 1024, rssBudgetBytes: null, ...structuredClone(raw) };
  if (!policy.systems || typeof policy.systems !== 'object' || Array.isArray(policy.systems)) throw new Error('Declare process-policy systems before freezing');
  const observed = await snapshot(policy);
  for (const system of Object.values(policy.systems)) for (const daemon of system.sharedDaemons ?? []) {
    const row = observed.rows?.find(row => row.pid === daemon.pid);
    if (!row?.birth || daemon.birth !== undefined && daemon.birth !== row.birth) throw new Error('Declared shared daemon is absent or its birth identity changed');
    daemon.birth = row.birth;
  }
  validateProcessPolicy(policy);
  return policy;
}

function tree(rows, root) {
  const found = rows.find(row => row.pid === root.pid);
  if (!found || !found.birth || root.birth && found.birth !== root.birth) return null;
  root.birth ??= found.birth;
  const ids = new Set([root.pid]);
  for (;;) { const before = ids.size; for (const row of rows) if (ids.has(row.parentPid)) ids.add(row.pid); if (ids.size === before) break; }
  return rows.filter(row => ids.has(row.pid));
}
export function createProcessTracker(policy, systemId) {
  validateProcessPolicy(policy);
  const declared = policy.systems[systemId];
  if (!declared) throw new Error('System missing from frozen process policy');
  const roots = [{ id: 'adapter-child-tree', pid: null, birth: null, scope: 'answer-child' }, ...declared.sharedDaemons.map(row => ({ ...row, scope: 'shared-daemon-tree' }))];
  const groups = roots.map(root => ({ root, samples: 0, missing: 0, peakRssBytes: null, cpu: new Map(), lastKeys: new Set(), exits: 0, unknownCounters: 0,
    baselineKnown: root.scope === 'answer-child', pidReuseSamples: 0 }));
  let baselineKeys;
  let samples = 0, failures = 0, overheadMs = 0, aggregatePeak = null, exceeded = false;
  const failureReasons = Object.create(null);
  function observe(snapshot, baseline = false) {
    overheadMs += finite(snapshot.elapsedMs) ? snapshot.elapsedMs : 0;
    if (!Array.isArray(snapshot.rows)) { failures++; const reason = snapshot.reason ?? 'unknown'; failureReasons[reason] = (failureReasons[reason] ?? 0) + 1; return; }
    if (baseline) baselineKeys = new Set(snapshot.rows.map(row => `${row.pid}:${row.birth}`));
    if (!baseline) samples++;
    const union = new Map(); let complete = true;
    for (const group of groups) {
      if (group.root.pid === null) { if (!baseline) complete = false; continue; }
      const rows = tree(snapshot.rows, group.root);
      if (!rows) { if (!baseline) { group.missing++; complete = false;
        if (snapshot.rows.some(row => row.pid === group.root.pid && row.birth && row.birth !== group.root.birth)) group.pidReuseSamples++;
      } continue; }
      if (baseline) group.baselineKnown = true;
      const keys = new Set(); let rss = 0, rssKnown = true;
      for (const row of rows) {
        const key = `${row.pid}:${row.birth}`; keys.add(key); union.set(key, row);
        if (!row.birth || !finite(row.rssBytes) || !finite(row.cpuSeconds)) { if (!baseline) group.unknownCounters++; }
        if (finite(row.rssBytes)) rss += row.rssBytes; else rssKnown = false;
        if (row.birth && finite(row.cpuSeconds)) {
          const previous = group.cpu.get(key);
          if (!previous) group.cpu.set(key, { baseline: baseline || group.root.scope === 'shared-daemon-tree' && baselineKeys?.has(key) ? row.cpuSeconds : 0, last: row.cpuSeconds });
          else if (row.cpuSeconds >= previous.last) previous.last = row.cpuSeconds;
          else if (!baseline) group.unknownCounters++;
        }
      }
      if (!baseline) {
        group.samples++; group.exits += [...group.lastKeys].filter(key => !keys.has(key)).length;
        if (rssKnown) group.peakRssBytes = Math.max(group.peakRssBytes ?? 0, rss);
      }
      group.lastKeys = keys;
    }
    if (!baseline && union.size) {
      const known = [...union.values()].every(row => finite(row.rssBytes));
      const total = known ? [...union.values()].reduce((sum, row) => sum + row.rssBytes, 0) : null;
      if (total !== null) { aggregatePeak = Math.max(aggregatePeak ?? 0, total); if (policy.rssBudgetBytes !== null && total > policy.rssBudgetBytes) exceeded = true; }
      if (!complete) failures++;
    }
  }
  return { baseline: snapshot => observe(snapshot, true), setChildPid: pid => { if (!positive(pid)) throw new Error('Invalid child PID'); roots[0].pid = pid; },
    sample: snapshot => { observe(snapshot); return exceeded; },
    result: () => ({ schema: 'scce.blind-process-measurement.v1', provider: policy.provider, sampleIntervalMs: policy.sampleIntervalMs,
      samples, failedSamples: failures, failureReasons, probeElapsedMs: overheadMs, sampledScopedPeakRssBytes: aggregatePeak,
      sharedDaemonCoverage: declared.sharedDaemons.length ? 'declared-trees-only' : 'not-declared',
      scopes: groups.map(group => ({ id: group.root.id, scope: group.root.scope, pid: group.root.pid, birth: group.root.birth,
        sampledPeakRssBytes: group.peakRssBytes, observedCpuSeconds: group.baselineKnown && group.samples && group.cpu.size ? [...group.cpu.values()].reduce((sum, row) => sum + row.last - row.baseline, 0) : null,
        observedProcesses: group.cpu.size, samples: group.samples, missingRootSamples: group.missing, exitedObservedProcesses: group.exits, unknownCounterSamples: group.unknownCounters,
        baselineKnown: group.baselineKnown, pidReuseSamples: group.pidReuseSamples })),
      rssBudgetBytes: policy.rssBudgetBytes, budgetStatus: exceeded ? 'exceeded' : policy.rssBudgetBytes === null ? 'not_requested' : failures || !samples || groups.some(group => !group.samples || group.missing || group.unknownCounters) ? 'unmeasured' : 'not_observed_exceeded',
      hardOsQuotaEnforced: false, totalProductRamBytes: null, cpuCoverage: 'Observed cumulative process counters; exited-process tails and processes between samples may be missed.',
      memoryCoverage: 'Sampled RSS sum over distinct observed process identities; shared pages may be counted twice. Shared daemon work is not exclusively attributable to this answer. No GPU/system-cache/unique-total-RAM measurement.' }) };
}

export async function startProcessMeasurement({ policy, systemId, onExceeded }, dependencies = {}) {
  const snapshot = dependencies.snapshot ?? processSnapshot, tracker = createProcessTracker(policy, systemId);
  tracker.baseline(await snapshot(policy));
  let timer, pending, finished = false;
  const sample = () => {
    pending = Promise.resolve().then(() => snapshot(policy)).then(result => { if (finished) tracker.sample({ rows: null, reason: 'sample-after-child-exit', elapsedMs: result.elapsedMs });
      else if (tracker.sample(result)) onExceeded?.(); }).catch(() => tracker.sample({ rows: null, reason: 'probe-unavailable' }))
      .finally(() => { if (!finished) timer = setTimeout(sample, policy.sampleIntervalMs); });
  };
  return { watch(pid) { tracker.setChildPid(pid); sample(); }, async finish() { finished = true; clearTimeout(timer); await pending; return tracker.result(); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const wanted = process.argv.find(arg => arg.startsWith('--pids='))?.slice(7).split(',').map(Number) ?? [];
  if (process.argv[2] !== 'inspect' || !wanted.length || wanted.some(pid => !positive(pid))) throw new Error('Usage: node process-resources.mjs inspect --pids=PID,PID');
  const snapshot = await processSnapshot();
  process.stdout.write(`${JSON.stringify({ provider: 'trusted-host-native-process-table.v1', rows: snapshot.rows?.filter(row => wanted.includes(row.pid)) ?? null, reason: snapshot.reason })}\n`);
}
