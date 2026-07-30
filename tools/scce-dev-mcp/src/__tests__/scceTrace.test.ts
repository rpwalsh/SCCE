import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleTraceList, handleTraceRead, handleAnswerTrace } from '../tools/scceTrace.js';

function makeRepoWithTraces(lines: string[]): { root: string; traceDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'scce-mcp-trace-handler-'));
  writeFileSync(join(root, 'README.md'), '# marker');
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  mkdirSync(join(root, 'packages', 'kernel', 'src'), { recursive: true });
  writeFileSync(join(root, 'packages', 'kernel', 'src', 'kernel.ts'), '// marker');
  const traceDir = join(root, '.scce', 'traces');
  mkdirSync(traceDir, { recursive: true });
  writeFileSync(join(traceDir, 'trace-abc.jsonl'), lines.join('\n') + '\n');
  return { root, traceDir };
}

const originalRepoRoot = process.env.SCCE_REPO_ROOT;
const created: string[] = [];

afterEach(() => {
  if (originalRepoRoot === undefined) delete process.env.SCCE_REPO_ROOT;
  else process.env.SCCE_REPO_ROOT = originalRepoRoot;
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('trace handlers', () => {
  it('lists trace files in the resolved trace directory', async () => {
    const { root } = makeRepoWithTraces(['{"stage":"turn.input"}']);
    created.push(root);
    process.env.SCCE_REPO_ROOT = root;
    const out = JSON.parse(await handleTraceList({}));
    expect(out.files.map((f: { file: string }) => f.file)).toContain('trace-abc.jsonl');
  });

  it('reads events and reports malformed lines without failing the whole read', async () => {
    const { root } = makeRepoWithTraces(['{"stage":"turn.input"}', 'not json', '{"stage":"turn.output"}']);
    created.push(root);
    process.env.SCCE_REPO_ROOT = root;
    const out = JSON.parse(await handleTraceRead({ file: 'trace-abc.jsonl' }));
    expect(out.events).toHaveLength(2);
    expect(out.malformedCount).toBe(1);
  });

  it('bounds events read by maxEvents', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => JSON.stringify({ stage: `stage.${i}` }));
    const { root } = makeRepoWithTraces(lines);
    created.push(root);
    process.env.SCCE_REPO_ROOT = root;
    const out = JSON.parse(await handleTraceRead({ file: 'trace-abc.jsonl', maxEvents: 3 }));
    expect(out.events).toHaveLength(3);
    expect(out.truncated).toBe(true);
  });

  it('reports trace not found for a nonexistent file rather than throwing', async () => {
    const { root } = makeRepoWithTraces(['{"stage":"turn.input"}']);
    created.push(root);
    process.env.SCCE_REPO_ROOT = root;
    const out = JSON.parse(await handleTraceRead({ file: 'missing.jsonl' }));
    expect(out.error).toBe('trace not found');
  });

  it('summarizes stage coverage for answer-trace', async () => {
    const { root } = makeRepoWithTraces(['{"stage":"turn.input"}', '{"stage":"turn.output"}']);
    created.push(root);
    process.env.SCCE_REPO_ROOT = root;
    const out = JSON.parse(await handleAnswerTrace({ file: 'trace-abc.jsonl' }));
    expect(out.stages).toEqual(['turn.input', 'turn.output']);
    expect(out.missingExpectedStages.length).toBeGreaterThan(0);
  });
});
