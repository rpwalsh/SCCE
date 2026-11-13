import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { implementationFiles } from '../campaign-discovery.mjs';

const exec = promisify(execFile);
test('implementation freeze includes new adapter dependencies and built bytes while excluding ignored local material', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scce-implementation-freeze-'));
  try {
    await exec('git', ['init', '--quiet'], { cwd: root, windowsHide: true });
    await writeFile(path.join(root, '.gitignore'), '.scce/\nlocal.config.json\npackages/*/dist/\n');
    await writeFile(path.join(root, 'tracked.mjs'), 'export const tracked=true;\n');
    await exec('git', ['add', '.gitignore', 'tracked.mjs'], { cwd: root, windowsHide: true });
    await mkdir(path.join(root, 'tools/adapters'), { recursive: true });
    await writeFile(path.join(root, 'tools/adapters/new-runtime.mjs'), 'export const runtime=true;\n');
    await mkdir(path.join(root, '.scce'), { recursive: true });
    await writeFile(path.join(root, '.scce/private-corpus.json'), '{}');
    await writeFile(path.join(root, 'local.config.json'), '{}');
    await mkdir(path.join(root, 'packages/kernel/dist'), { recursive: true });
    await writeFile(path.join(root, 'packages/kernel/dist/new-runtime.js'), 'export const compiled=true;\n');
    const files = (await implementationFiles(root)).map(file => path.relative(root, file).replaceAll('\\', '/'));
    assert.ok(files.includes('tracked.mjs'));
    assert.ok(files.includes('tools/adapters/new-runtime.mjs'));
    assert.ok(files.includes('packages/kernel/dist/new-runtime.js'));
    assert.equal(files.some(file => file.startsWith('.scce/')), false);
    assert.equal(files.includes('local.config.json'), false);
    assert.equal(new Set(files).size, files.length);
  } finally { await rm(root, { recursive: true, force: true }); }
});
