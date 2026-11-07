// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { handleRepoCreate, handleRepoEdit, handleRepoRead } from '../tools/sourceFile.js';

let root = '';
let outside = '';
const oldRoot = process.env.SCCE_REPO_ROOT;
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scce-mcp-read-edit-'));
  outside = mkdtempSync(join(tmpdir(), 'scce-mcp-outside-'));
  mkdirSync(join(root, 'packages', 'kernel', 'src'), { recursive: true });
  writeFileSync(join(root, 'README.md'), 'scratch\n');
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
  writeFileSync(join(root, 'packages', 'kernel', 'src', 'kernel.ts'), 'export {};\n');
  process.env.SCCE_REPO_ROOT = root;
});

afterEach(() => {
  if (oldRoot === undefined) delete process.env.SCCE_REPO_ROOT;
  else process.env.SCCE_REPO_ROOT = oldRoot;
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('repo_read and repo_edit', () => {
  it('creates a new UTF-8 file without clobbering and returns the hash for a follow-up edit', async () => {
    const content = 'export const café = "雪";\r\n';
    const created = JSON.parse(await handleRepoCreate({ path: 'new.ts', content }));
    expect(created).toMatchObject({ ok: true, path: 'new.ts', sha256: sha(content), bytes: Buffer.byteLength(content), action: 'repo_read' });
    expect(readFileSync(join(root, 'new.ts'))).toEqual(Buffer.from(content, 'utf8'));
    const conflict = JSON.parse(await handleRepoCreate({ path: 'new.ts', content: 'replacement' }));
    expect(conflict).toMatchObject({ ok: false, error: 'file_exists' });
    expect(readFileSync(join(root, 'new.ts'))).toEqual(Buffer.from(content, 'utf8'));
    const edited = JSON.parse(await handleRepoEdit({ path: 'new.ts', expectedSha256: created.sha256, replacements: [{ before: '"雪"', after: '"é"' }] }));
    expect(edited.ok).toBe(true);
    expect(readFileSync(join(root, 'new.ts'))).toEqual(Buffer.from('export const café = "é";\r\n', 'utf8'));
  });

  it('reads bounded numbered lines and continues only while the file hash remains current', async () => {
    writeFileSync(join(root, 'sample.ts'), 'one\r\ntwo\r\nthree\r\n');
    const first = JSON.parse(await handleRepoRead({ path: 'sample.ts', startLine: 1, endLine: 2 }));
    expect(first.lines).toEqual([{ line: 1, text: 'one' }, { line: 2, text: 'two' }]);
    const next = JSON.parse(await handleRepoRead({ path: 'sample.ts', cursor: first.cursor }));
    expect(next.lines[0]).toEqual({ line: 3, text: 'three' });
    writeFileSync(join(root, 'sample.ts'), 'changed\r\n');
    const stale = JSON.parse(await handleRepoRead({ path: 'sample.ts', cursor: first.cursor }));
    expect(stale).toMatchObject({ ok: false, error: 'content_changed', action: 'repo_read_again' });
  });

  it('refuses stale hashes and repeated replacement text without changing bytes', async () => {
    const path = join(root, 'sample.ts');
    writeFileSync(path, 'alpha\r\nbeta\r\n');
    const stale = JSON.parse(await handleRepoEdit({ path: 'sample.ts', expectedSha256: '0'.repeat(64), replacements: [{ before: 'alpha', after: 'ALPHA' }] }));
    expect(stale).toMatchObject({ ok: false, error: 'content_changed', action: 'repo_read_again' });
    expect(readFileSync(path)).toEqual(Buffer.from('alpha\r\nbeta\r\n'));
    const ambiguous = JSON.parse(await handleRepoEdit({ path: 'sample.ts', expectedSha256: sha('alpha\r\nbeta\r\n'), replacements: [{ before: 'a', after: 'x' }] }));
    expect(ambiguous).toMatchObject({ ok: false, error: 'replacement_not_unique' });
    expect(readFileSync(path)).toEqual(Buffer.from('alpha\r\nbeta\r\n'));
  });

  it('rejects overlapping matches and keeps large-line responses bounded', async () => {
    const path = join(root, 'sample.ts');
    writeFileSync(path, 'aaa');
    const overlap = JSON.parse(await handleRepoEdit({ path: 'sample.ts', expectedSha256: sha('aaa'), replacements: [{ before: 'aa', after: 'b' }] }));
    expect(overlap).toMatchObject({ ok: false, error: 'replacement_not_unique' });
    expect(readFileSync(path, 'utf8')).toBe('aaa');
    writeFileSync(path, 'x'.repeat(25_000));
    const tooLong = await handleRepoRead({ path: 'sample.ts' });
    expect(Buffer.byteLength(tooLong, 'utf8')).toBeLessThan(500);
    expect(JSON.parse(tooLong)).toMatchObject({ ok: false, error: 'line_too_large', line: 1 });
    writeFileSync(path, `${Array.from({ length: 100 }, (_, index) => `${index}: ${'y'.repeat(400)}`).join('\n')}\n`);
    const bounded = JSON.parse(await handleRepoRead({ path: 'sample.ts' }));
    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(16 * 1024);
    expect(bounded.lines.length).toBeGreaterThan(0);
    expect(bounded.lines.length).toBeLessThan(100);
    const continued = await handleRepoRead({ path: 'sample.ts', cursor: bounded.cursor });
    expect(Buffer.byteLength(continued, 'utf8')).toBeLessThanOrEqual(16 * 1024);
  });

  it('checks oversized files before allocating or reading their full contents', async () => {
    const path = join(root, 'sparse-large.ts');
    writeFileSync(path, '');
    truncateSync(path, 2 * 1024 * 1024 + 1);
    await expect(handleRepoRead({ path: 'sparse-large.ts' })).rejects.toThrow('file_too_large');
  });

  it('requires a unique exact match and preserves UTF-8 and CRLF bytes', async () => {
    const path = join(root, 'sample.ts');
    const original = 'const café = "雪";\r\n';
    const expected = 'const café = "雪";\r\n';
    writeFileSync(path, original, 'utf8');
    const result = JSON.parse(await handleRepoEdit({ path: 'sample.ts', expectedSha256: sha(expected), replacements: [{ before: 'café = "雪"', after: 'café = "é"' }] }));
    expect(result).toMatchObject({ ok: true, replacementsApplied: 1, beforeSha256: sha(original), afterSha256: sha('const café = "é";\r\n') });
    expect(readFileSync(path)).toEqual(Buffer.from('const café = "é";\r\n', 'utf8'));
  });

  it('denies secret paths and symlink escapes', async () => {
    writeFileSync(join(root, '.env.local'), 'secret');
    writeFileSync(join(outside, 'private.ts'), 'outside');
    symlinkSync(outside, join(root, 'escape'), 'junction');
    await expect(handleRepoRead({ path: '.env.local' })).rejects.toThrow('sensitive_path_denied');
    await expect(handleRepoRead({ path: 'escape/private.ts' })).rejects.toThrow('symlink_path_denied');
    await expect(handleRepoRead({ path: '.git/config' })).rejects.toThrow('administrative_path_denied');
    await expect(handleRepoRead({ path: '.scce/runtime.json' })).rejects.toThrow('administrative_path_denied');
    await expect(handleRepoRead({ path: 'node_modules/package/index.js' })).rejects.toThrow('administrative_path_denied');
  });
});
