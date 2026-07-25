import { describe, expect, it } from 'vitest';
import { validateToolArgs, ToolArgumentError, repoRelativePath, sqlIdentifier, traceId } from '../lib/validate.js';

describe('validateToolArgs', () => {
  it('rejects unknown properties', () => {
    expect(() => validateToolArgs('repo_shape', { extra: 'nope' })).toThrow(ToolArgumentError);
  });

  it('applies bounded defaults for omitted numeric limits', () => {
    const parsed = validateToolArgs('repo_search', { query: 'foo' });
    expect(parsed.maxResults).toBe(50);
  });

  it('clamps out-of-range integers to a validation error rather than silently coercing', () => {
    expect(() => validateToolArgs('repo_search', { query: 'foo', maxResults: 999999 })).toThrow(ToolArgumentError);
    expect(() => validateToolArgs('repo_search', { query: 'foo', maxResults: -1 })).toThrow(ToolArgumentError);
    expect(() => validateToolArgs('repo_search', { query: 'foo', maxResults: 1.5 })).toThrow(ToolArgumentError);
  });

  it('requires required fields', () => {
    expect(() => validateToolArgs('repo_search', {})).toThrow(ToolArgumentError);
    expect(() => validateToolArgs('pg_explain', {})).toThrow(ToolArgumentError);
  });

  it('rejects malformed types instead of coercing them', () => {
    expect(() => validateToolArgs('repo_search', { query: 123 })).toThrow(ToolArgumentError);
    expect(() => validateToolArgs('scce_trace_list', { limit: '20' })).toThrow(ToolArgumentError);
  });

  it('bounds query string length', () => {
    expect(() => validateToolArgs('repo_search', { query: 'x'.repeat(10_000) })).toThrow(ToolArgumentError);
  });

  it('rejects a trace file argument that is not a bare .jsonl filename', () => {
    expect(() => validateToolArgs('scce_trace_read', { file: '../../etc/passwd' })).toThrow(ToolArgumentError);
    expect(() => validateToolArgs('scce_trace_read', { file: 'notes.txt' })).toThrow(ToolArgumentError);
    expect(() => validateToolArgs('scce_trace_read', { file: 'valid-trace.jsonl' })).not.toThrow();
  });
});

describe('repoRelativePath', () => {
  it('accepts a plain repo-relative path', () => {
    expect(repoRelativePath.safeParse('packages/kernel/src/kernel.ts').success).toBe(true);
  });

  it('rejects absolute paths', () => {
    expect(repoRelativePath.safeParse('/etc/passwd').success).toBe(false);
    expect(repoRelativePath.safeParse('C:\\Windows\\System32').success).toBe(false);
  });

  it('rejects parent-traversal segments', () => {
    expect(repoRelativePath.safeParse('../../etc/passwd').success).toBe(false);
    expect(repoRelativePath.safeParse('packages/../../secrets').success).toBe(false);
  });
});

describe('sqlIdentifier', () => {
  it('accepts a bare identifier', () => {
    expect(sqlIdentifier.safeParse('scce3_runtime').success).toBe(true);
  });

  it('rejects identifiers with SQL-breaking characters', () => {
    expect(sqlIdentifier.safeParse("public'; DROP TABLE events; --").success).toBe(false);
    expect(sqlIdentifier.safeParse('public.other').success).toBe(false);
    expect(sqlIdentifier.safeParse('1public').success).toBe(false);
  });
});

describe('traceId', () => {
  it('accepts a bounded filesystem-safe token', () => {
    expect(traceId.safeParse('trace-2026-07-24_120000').success).toBe(true);
  });

  it('rejects a path-shaped value', () => {
    expect(traceId.safeParse('../../etc/passwd').success).toBe(false);
    expect(traceId.safeParse('a/b').success).toBe(false);
  });
});
