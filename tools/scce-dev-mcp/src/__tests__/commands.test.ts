import { describe, expect, it } from 'vitest';
import {
  COMMAND_REGISTRY,
  resolveCommand,
  UnknownCommandError,
  UnsupportedFilterError,
  InvalidFilterError
} from '../lib/commands.js';

describe('resolveCommand', () => {
  it('resolves a known commandId to its fixed argv', () => {
    const resolved = resolveCommand('build');
    expect(resolved.command).toBe('pnpm');
    expect(resolved.args).toEqual(['build']);
  });

  it('rejects an unknown commandId', () => {
    expect(() => resolveCommand('rm -rf /')).toThrow(UnknownCommandError);
    expect(() => resolveCommand('anything-not-registered')).toThrow(UnknownCommandError);
  });

  it('never exposes server/mcp:start/install/git-write commands', () => {
    expect(COMMAND_REGISTRY.server).toBeUndefined();
    expect(COMMAND_REGISTRY['mcp:start']).toBeUndefined();
    expect(COMMAND_REGISTRY.install).toBeUndefined();
    const allArgStrings = Object.values(COMMAND_REGISTRY).flatMap((spec) => [spec.command, ...spec.args]).join(' ');
    expect(allArgStrings).not.toMatch(/install|push|reset|checkout|server|mcp:start/);
  });

  it('rejects a filter on a non-filterable command', () => {
    expect(() => resolveCommand('build', 'some/file.test.ts')).toThrow(UnsupportedFilterError);
  });

  it('appends a valid filter as a bounded positional argument on a filterable command', () => {
    const resolved = resolveCommand('unit', 'packages/kernel/src/__tests__/judge.test.ts');
    expect(resolved.args).toEqual(['test:unit', 'packages/kernel/src/__tests__/judge.test.ts']);
  });

  it('rejects a filter containing shell metacharacters or a leading flag', () => {
    expect(() => resolveCommand('unit', '$(rm -rf /)')).toThrow(InvalidFilterError);
    expect(() => resolveCommand('unit', '--reporter=json')).toThrow(InvalidFilterError);
    expect(() => resolveCommand('unit', 'a; rm -rf /')).toThrow(InvalidFilterError);
  });

  it('never string-interpolates the filter into a shell command', () => {
    const resolved = resolveCommand('unit', 'foo.test.ts');
    expect(Array.isArray(resolved.args)).toBe(true);
    expect(resolved.args.every((arg) => typeof arg === 'string')).toBe(true);
  });
});
