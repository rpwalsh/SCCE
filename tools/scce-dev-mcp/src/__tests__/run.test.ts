import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecked, runProcess, ProcessCheckError } from '../lib/run.js';

const fixturesDir = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('runProcess', () => {
  it('never throws and reports a nonzero exit in the returned status', async () => {
    const status = await runProcess({
      commandId: 'test.fail',
      command: process.execPath,
      args: ['-e', 'process.exit(3)'],
      cwd: process.cwd()
    });
    expect(status.spawnError).toBeUndefined();
    expect(status.timedOut).toBe(false);
    expect(status.exitCode).toBe(3);
  });

  it('reports a spawn failure for a missing executable instead of throwing', async () => {
    const status = await runProcess({
      commandId: 'test.missing',
      command: 'scce-dev-mcp-definitely-not-a-real-executable',
      args: [],
      cwd: process.cwd()
    });
    expect(status.spawnError).toBeDefined();
    expect(status.exitCode).not.toBe(0);
  });

  it('reports success distinctly from a merely-resolved promise', async () => {
    const status = await runProcess({
      commandId: 'test.ok',
      command: process.execPath,
      args: ['-e', 'console.log("ok")'],
      cwd: process.cwd()
    });
    expect(status.exitCode).toBe(0);
    expect(status.stdout.trim()).toBe('ok');
  });

  it('terminates the full process tree on timeout, not just the direct child', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scce-mcp-tree-'));
    const pidFile = join(dir, 'pids.json');
    try {
      const status = await runProcess({
        commandId: 'test.tree',
        command: process.execPath,
        args: [join(fixturesDir, 'spawnGrandchild.mjs'), pidFile],
        cwd: process.cwd(),
        timeoutMs: 600
      });
      expect(status.timedOut).toBe(true);
      const { parentPid, childPid } = JSON.parse(readFileSync(pidFile, 'utf8')) as { parentPid: number; childPid: number };
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(isAlive(parentPid)).toBe(false);
      expect(isAlive(childPid)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
});

describe('runChecked', () => {
  it('rejects on a nonzero exit code', async () => {
    await expect(runChecked({
      commandId: 'test.fail',
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
      cwd: process.cwd()
    })).rejects.toBeInstanceOf(ProcessCheckError);
  });

  it('rejects on a missing executable', async () => {
    await expect(runChecked({
      commandId: 'test.missing',
      command: 'scce-dev-mcp-definitely-not-a-real-executable',
      args: [],
      cwd: process.cwd()
    })).rejects.toBeInstanceOf(ProcessCheckError);
  });

  it('rejects on timeout', async () => {
    await expect(runChecked({
      commandId: 'test.timeout',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      timeoutMs: 300
    })).rejects.toBeInstanceOf(ProcessCheckError);
  }, 10000);

  it('resolves with the status on success', async () => {
    const status = await runChecked({
      commandId: 'test.ok',
      command: process.execPath,
      args: ['-e', 'console.log("ok")'],
      cwd: process.cwd()
    });
    expect(status.exitCode).toBe(0);
  });
});
