import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProcessTable, processSnapshot, cpuTimeSeconds, createProcessTracker, resolveProcessPolicy, validateProcessPolicy } from '../process-resources.mjs';
import { execute } from '../runner.mjs';

const policy = (ceiling = 1000) => ({ schema: 'scce.blind-process-policy.v1', provider: 'trusted-host-native-process-table.v1', sampleIntervalMs: 20,
  probeTimeoutMs: 100, maxProbeOutputBytes: 10000, rssBudgetBytes: ceiling, systems: { a: { sharedDaemons: [{ id: 'declared-service', pid: 40, birth: 'service.start' }] }, b: { sharedDaemons: [] } } });
const row = (pid, parentPid, rssBytes, cpuSeconds, birth = `birth.${pid}`) => ({ pid, parentPid, rssBytes, cpuSeconds, birth });
const service = (rss = 200, cpu = 10) => row(40, 1, rss, cpu, 'service.start');
const sample = (...rows) => ({ rows, reason: null, elapsedMs: 2 });

test('parses native Windows and Linux/macOS counters with explicit units and stable process birth identities', () => {
  assert.deepEqual(parseProcessTable('win32', JSON.stringify([{ pid: 12, parentPid: 1, birth: '2026-11-08T00:00:00Z', rssBytes: '4096', cpuTicks: '25000000' }])),
    [{ pid: 12, parentPid: 1, birth: '2026-11-08T00:00:00Z', rssBytes: 4096, cpuSeconds: 2.5 }]);
  const parsed = parseProcessTable('darwin', '  12 1 4096 2:03.50 Sun Nov  8 08:00:00 2026\n');
  assert.equal(parsed[0].rssBytes, 4194304); assert.equal(parsed[0].cpuSeconds, 123.5); assert.equal(parsed[0].birth, 'Sun Nov  8 08:00:00 2026');
  assert.equal(cpuTimeSeconds('2-03:04:05'), 183845); assert.equal(cpuTimeSeconds('unavailable'), null);
});
test('unsupported, exhausted, missing and output-budget native probes remain unknown, never zero', async () => {
  assert.equal((await processSnapshot({}, { platform: 'other' })).rows, null);
  for (const error of [Object.assign(new Error(), { killed: true }), Object.assign(new Error(), { code: 'ENOENT' }), Object.assign(new Error(), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })]) {
    const result = await processSnapshot(policy(), { platform: 'linux', exec: async () => { throw error; } });
    assert.equal(result.rows, null); assert.notEqual(result.reason, null);
  }
});
test('freezes exact declared daemon birth identity before selection and rejects missing/reused daemon PIDs', async () => {
  const input = policy(); delete input.systems.a.sharedDaemons[0].birth;
  const resolved = await resolveProcessPolicy(input, async () => sample(service()));
  assert.equal(resolved.systems.a.sharedDaemons[0].birth, 'service.start'); assert.equal(input.systems.a.sharedDaemons[0].birth, undefined);
  await assert.rejects(() => resolveProcessPolicy(policy(), async () => sample(row(40, 1, 2, 1, 'reused.start'))), /absent|changed/u);
  await assert.rejects(() => resolveProcessPolicy(policy(), async () => ({ rows: null })), /absent/u);
  assert.throws(() => validateProcessPolicy({ ...policy(), sampleIntervalMs: 0 }));
});
test('accounts child descendants and shared daemon work separately with a simultaneous deduplicated RSS sample', () => {
  const meter = createProcessTracker(policy(), 'a'); meter.baseline(sample(service())); meter.setChildPid(100);
  meter.sample(sample(service(220, 11), row(100, 1, 100, .2), row(101, 100, 50, .3)));
  meter.sample(sample(service(230, 12), row(100, 1, 110, .4), row(101, 100, 60, .8)));
  const result = meter.result();
  assert.equal(result.scopes[0].sampledPeakRssBytes, 170); assert.ok(Math.abs(result.scopes[0].observedCpuSeconds - 1.2) <= Number.EPSILON * 2);
  assert.equal(result.scopes[1].sampledPeakRssBytes, 230); assert.equal(result.scopes[1].observedCpuSeconds, 2);
  assert.equal(result.sampledScopedPeakRssBytes, 400); assert.equal(result.totalProductRamBytes, null); assert.equal(result.hardOsQuotaEnforced, false);
});
test('exits, PID reuse and missing counters preserve coverage loss; reused PID counters cannot become answer CPU', () => {
  const meter = createProcessTracker(policy(), 'a'); meter.baseline(sample(service())); meter.setChildPid(100);
  meter.sample(sample(service(), row(100, 1, 100, .2), row(101, 100, 50, .3)));
  meter.sample(sample(service(), row(100, 1, 110, .4)));
  meter.sample(sample(row(40, 1, 999, 9000, 'different.birth'), row(100, 1, null, .5)));
  const result = meter.result();
  assert.equal(result.scopes[0].exitedObservedProcesses, 1); assert.equal(result.scopes[1].pidReuseSamples, 1);
  assert.equal(result.scopes[1].observedCpuSeconds, 0); assert.equal(result.budgetStatus, 'unmeasured');
  assert.equal(result.scopes[0].unknownCounterSamples, 1);
});
test('a missing shared baseline never charges lifetime daemon CPU to the answer, and a short unobserved child stays null', () => {
  const meter = createProcessTracker(policy(), 'a'); meter.baseline({ rows: null, reason: 'probe-timeout' }); meter.setChildPid(100);
  meter.sample(sample(service(200, 1000)));
  const result = meter.result();
  assert.equal(result.scopes[1].observedCpuSeconds, null); assert.equal(result.scopes[0].observedCpuSeconds, null);
  assert.equal(result.scopes[0].sampledPeakRssBytes, null); assert.equal(result.budgetStatus, 'unmeasured');
});
test('observed RSS budget exhaustion is retained even with incomplete process coverage', () => {
  const meter = createProcessTracker(policy(100), 'a'); meter.baseline(sample(service())); meter.setChildPid(100);
  assert.equal(meter.sample(sample(service(200))), true);
  assert.equal(meter.result().budgetStatus, 'exceeded'); assert.equal(meter.result().totalProductRamBytes, null);
});
test('runner stops only its answer child on an observed frozen process ceiling and retains failed-execution measurements', async () => {
  const result = await execute([process.execPath, '-e', 'setTimeout(()=>{},10000)'], { cwd: process.cwd(), input: '', timeMs: 5000, outputBytes: 1000,
    processPolicy: policy(100), systemId: 'a', processDependencies: { snapshot: async () => sample(service(200)) } });
  assert.equal(result.failure, 'process-rss-budget'); assert.equal(result.resources.budgetStatus, 'exceeded');
  assert.equal(result.resources.scopes[1].pid, 40);
});
test('a process that fails to start produces an audited error with unmeasured counters, not fabricated zeros', async () => {
  await assert.rejects(() => execute(['__missing_blind_process_executable__'], { cwd: process.cwd(), input: '', timeMs: 1000, outputBytes: 100,
    processPolicy: policy(), systemId: 'a', processDependencies: { snapshot: async () => sample(service()) } }), error => {
    assert.equal(error.code, 'ENOENT'); assert.equal(error.execution.failure, 'adapter-spawn');
    assert.equal(error.execution.resources.scopes[0].sampledPeakRssBytes, null); assert.equal(error.execution.resources.scopes[0].observedCpuSeconds, null); return true;
  });
});
