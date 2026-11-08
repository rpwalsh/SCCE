import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { smoke } from '../smoke.mjs';
import { readJson, writeJson, signed, verified } from '../protocol.mjs';
import { execute } from '../runner.mjs';

test('campaign finish requires a freshly verified passing gate only when explicitly requested', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scce-require-pass-'));
  try {
    const fixture = await smoke(root);
    const frozen = await readJson(path.join(root, 'freeze.json'));
    async function handoff(name) {
      const out = path.join(root, name); await mkdir(out);
      await cp(path.join(root, 'sealed/public'), path.join(out, 'public'), { recursive: true });
      await cp(fixture.out, path.join(out, 'run'), { recursive: true });
      const preparedFile = path.join(out, 'prepared.json'), custodyFile = path.join(out, 'custody.json');
      await writeJson(preparedFile, signed({ schema: 'scce.blind-default-prepared.v1', out, freezeFile: path.join(root, 'freeze.json'), freezeDigest: frozen.digest, gaps: [] }));
      await writeJson(custodyFile, signed({ schema: 'scce.blind-default-custody.v1', freezeDigest: frozen.digest, bundleDigest: fixture.bundleDigest,
        privateRoot: root, privateKeyFile: fixture.keyFile, custodyMode: 'offline deterministic protocol fixture' }));
      return { preparedFile, custodyFile };
    }
    let { preparedFile, custodyFile } = await handoff('normal');
    const argvFor = () => [process.execPath, fileURLToPath(new URL('../campaign.mjs', import.meta.url)), 'finish', '--prepared', preparedFile, '--custody', custodyFile,
      '--checkpoint', fixture.checkpointFile, '--checkpoint-digest', fixture.checkpointDigest];
    const run = extra => execute([...argvFor(), ...extra], { cwd: root, input: '', timeMs: 30000, outputBytes: 131072 });
    const normal = await run([]);
    assert.equal(normal.code, 0, normal.stderr);
    const normalResult = JSON.parse(normal.stdout), report = await readJson(normalResult.reportFile);
    assert.equal(report.report.comparativeGatePassed, false);
    assert.ok(report.report.cells.some(cell => cell.ungraded > 0));
    const { digest, ...edited } = report;
    const { digest: rawDigest, ...rawBody } = edited.report;
    edited.report = signed({ ...rawBody, comparativeGatePassed: true });
    const editedReport = signed(edited);
    verified(editedReport); verified(editedReport.report);
    await writeFile(normalResult.reportFile, JSON.stringify(editedReport));
    ({ preparedFile, custodyFile } = await handoff('required'));
    const required = await run(['--require-pass']);
    assert.equal(required.code, 1, required.stderr);
    const result = JSON.parse(required.stdout), recomputed = await readJson(result.reportFile);
    assert.equal(result.comparativeGatePassed, false);
    assert.equal(recomputed.report.comparativeGatePassed, false);
    assert.ok(recomputed.report.cells.some(cell => cell.ungraded > 0));
    const tampered = await readJson(preparedFile);
    tampered.gaps = ['edited without renewing its commitment'];
    await writeFile(preparedFile, JSON.stringify(tampered));
    const rejected = await run(['--require-pass']);
    assert.equal(rejected.code, 1);
    assert.equal(rejected.stdout, '');
  } finally { await rm(root, { recursive: true, force: true }); }
});
