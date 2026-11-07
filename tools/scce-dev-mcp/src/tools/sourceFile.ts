// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { resolveRepositoryRoot } from '../lib/repoRoot.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_READ_LINES = 300;
const MAX_RESPONSE_BYTES = 16 * 1024;
const DENIED_DIRS = new Set(['.git', '.scce', 'node_modules']);
const SECRET_NAME = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|credentials?(?:\..*)?|secrets?(?:\..*)?|privatekeys?|id_rsa(?:\..*)?|id_ed25519(?:\..*)?|scce\.config\.local\.json)$|\.(?:pem|key|p12|pfx)$/iu;

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function resolveSafeFile(root: string, path: string, mustExist: boolean): string {
  if (path.split(/[\\/]/u).some((part) => DENIED_DIRS.has(part.toLowerCase()))) throw new Error('administrative_path_denied');
  if (path.split(/[\\/]/u).some((part) => SECRET_NAME.test(part))) throw new Error('sensitive_path_denied');
  const candidate = resolve(root, path);
  const rel = relative(root, candidate);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('path_outside_repository');
  let current = root;
  const segments = rel.split(/[\\/]/u);
  for (let i = 0; i < segments.length; i += 1) {
    current = resolve(current, segments[i]!);
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink()) throw new Error('symlink_path_denied');
      if (i < segments.length - 1 && !info.isDirectory()) throw new Error('parent_not_directory');
      if (i === segments.length - 1 && !info.isFile()) throw new Error('not_regular_file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !mustExist && i === segments.length - 1) break;
      throw error;
    }
  }
  const rootReal = realpathSync(root);
  const parentReal = realpathSync(dirname(candidate));
  const parentRel = relative(rootReal, parentReal);
  if (parentRel === '..' || parentRel.startsWith(`..${sep}`) || isAbsolute(parentRel)) throw new Error('path_outside_repository');
  return candidate;
}

function readBytes(root: string, path: string): { file: string; bytes: Buffer; text: string; sha256: string } {
  const file = resolveSafeFile(root, path, true);
  const bytes = readFileSync(file);
  if (bytes.length > MAX_FILE_BYTES) throw new Error('file_too_large');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('file_not_valid_utf8');
  return { file, bytes, text, sha256: digest(bytes) };
}

export async function handleRepoRead(args: { path: string; startLine?: number; endLine?: number; cursor?: string }): Promise<string> {
  const root = resolveRepositoryRoot();
  const start = args.startLine ?? 1;
  const end = args.endLine ?? start + MAX_READ_LINES - 1;
  if (args.cursor) {
    let cursor: { path: string; sha256: string; nextLine: number };
    try { cursor = JSON.parse(Buffer.from(args.cursor, 'base64url').toString('utf8')) as typeof cursor; }
    catch { throw new Error('invalid_cursor'); }
    if (cursor.path !== args.path || !Number.isInteger(cursor.nextLine) || cursor.nextLine < 1) throw new Error('invalid_cursor');
    const current = readBytes(root, args.path);
    if (current.sha256 !== cursor.sha256) return JSON.stringify({ ok: false, error: 'content_changed', action: 'repo_read_again', path: args.path, currentSha256: current.sha256 });
    return readLines(args.path, current, cursor.nextLine, cursor.nextLine + MAX_READ_LINES - 1);
  }
  if (end < start || end - start + 1 > MAX_READ_LINES) throw new Error(`line_range_limit_${MAX_READ_LINES}`);
  return readLines(args.path, readBytes(root, args.path), start, end);
}

function readLines(path: string, data: { text: string; sha256: string }, start: number, end: number): string {
  const rows = data.text.split(/\r\n|\n|\r/u);
  const selected: Array<{ line: number; text: string }> = [];
  for (let line = start; line <= end && line <= rows.length; line += 1) {
    const text = rows[line - 1]!;
    const candidate = [...selected, { line, text }];
    const candidateCursor = line < rows.length
      ? Buffer.from(JSON.stringify({ path, sha256: data.sha256, nextLine: line + 1 })).toString('base64url')
      : undefined;
    const candidateResult = { ok: true, path, sha256: data.sha256, startLine: start, endLine: line, lines: candidate, cursor: candidateCursor };
    if (Buffer.byteLength(JSON.stringify(candidateResult), 'utf8') > MAX_RESPONSE_BYTES) {
      if (selected.length === 0) return JSON.stringify({ ok: false, error: 'line_too_large', line, maxResponseBytes: MAX_RESPONSE_BYTES, action: 'use_repo_search_or_split_source' });
      break;
    }
    selected.push({ line, text });
  }
  const nextLine = start + selected.length;
  const cursor = nextLine <= rows.length
    ? Buffer.from(JSON.stringify({ path, sha256: data.sha256, nextLine })).toString('base64url')
    : undefined;
  return JSON.stringify({ ok: true, path, sha256: data.sha256, startLine: start, endLine: Math.max(start - 1, nextLine - 1), lines: selected, cursor });
}

export async function handleRepoEdit(args: { path: string; expectedSha256: string; replacements: Array<{ before: string; after: string }> }): Promise<string> {
  const root = resolveRepositoryRoot();
  const data = readBytes(root, args.path);
  if (data.sha256 !== args.expectedSha256.toLowerCase()) {
    return JSON.stringify({ ok: false, error: 'content_changed', action: 'repo_read_again', path: args.path, currentSha256: data.sha256 });
  }
  const matches: Array<{ start: number; end: number; after: string }> = [];
  for (const [index, replacement] of args.replacements.entries()) {
    const first = data.text.indexOf(replacement.before);
    if (first < 0) return JSON.stringify({ ok: false, error: 'replacement_not_found', replacement: index, action: 'repo_read_again', currentSha256: data.sha256 });
    if (data.text.indexOf(replacement.before, first + 1) >= 0) return JSON.stringify({ ok: false, error: 'replacement_not_unique', replacement: index, action: 'repo_read_again', currentSha256: data.sha256 });
    if (matches.some((match) => first < match.end && first + replacement.before.length > match.start)) return JSON.stringify({ ok: false, error: 'overlapping_replacements', replacement: index, action: 'repo_read_again', currentSha256: data.sha256 });
    matches.push({ start: first, end: first + replacement.before.length, after: replacement.after });
  }
  let next = data.text;
  for (const match of matches.sort((a, b) => b.start - a.start)) next = next.slice(0, match.start) + match.after + next.slice(match.end);
  const output = Buffer.from(next, 'utf8');
  if (output.length > MAX_FILE_BYTES) throw new Error('file_too_large');
  const file = resolveSafeFile(root, args.path, true);
  const current = readFileSync(file);
  if (digest(current) !== data.sha256) return JSON.stringify({ ok: false, error: 'content_changed', action: 'repo_read_again', path: args.path, currentSha256: digest(current) });
  const temp = `${file}.scce-edit-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`;
  try {
    writeFileSync(temp, output, { flag: 'wx', mode: lstatSync(file).mode });
    resolveSafeFile(root, args.path, true);
    if (digest(readFileSync(file)) !== data.sha256) return JSON.stringify({ ok: false, error: 'content_changed', action: 'repo_read_again', path: args.path, currentSha256: digest(readFileSync(file)) });
    renameSync(temp, file);
  } finally {
    try { unlinkSync(temp); } catch {}
  }
  return JSON.stringify({ ok: true, path: args.path, beforeSha256: data.sha256, afterSha256: digest(output), replacementsApplied: args.replacements.length });
}
