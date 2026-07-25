export interface CommandSpec {
  command: string;
  args: string[];
  timeoutMs: number;
  /** true if this command accepts one bounded test-path/pattern filter argument. */
  filterable: boolean;
  description: string;
}

/**
 * Closed set of commands the MCP server may execute. No handler may run a
 * caller-supplied command string or derive authorization from the live
 * contents of package.json — only entries listed here can ever run, and only
 * with these fixed argv arrays. Long-running/mutating commands (server,
 * mcp:start, install, db migrate, git push, etc.) are deliberately absent.
 */
export const COMMAND_REGISTRY: Record<string, CommandSpec> = {
  build: {
    command: 'pnpm',
    args: ['build'],
    timeoutMs: 300_000,
    filterable: false,
    description: 'pnpm build (tsc -b across kernel/adapters-node/ui/server/cli/vscode)'
  },
  unit: {
    command: 'pnpm',
    args: ['test:unit'],
    timeoutMs: 300_000,
    filterable: true,
    description: 'pnpm test:unit (vitest run)'
  },
  structural: {
    command: 'pnpm',
    args: ['test:structural'],
    timeoutMs: 180_000,
    filterable: false,
    description: 'pnpm test:structural (targeted structural coherence tests)'
  },
  validate: {
    command: 'pnpm',
    args: ['validate'],
    timeoutMs: 600_000,
    filterable: false,
    description: 'pnpm validate (proprietary:check && test && eval:kit:verify) — do not call from within an MCP self-test, it transitively runs mcp:verify'
  },
  mcpBuild: {
    command: 'pnpm',
    args: ['mcp:build'],
    timeoutMs: 120_000,
    filterable: false,
    description: 'pnpm mcp:build (build this MCP server)'
  },
  mcpTest: {
    command: 'pnpm',
    args: ['mcp:test'],
    timeoutMs: 180_000,
    filterable: false,
    description: "pnpm mcp:test (this MCP server's own unit tests)"
  },
  shape: {
    command: 'pnpm',
    args: ['repo:shape'],
    timeoutMs: 30_000,
    filterable: false,
    description: 'pnpm repo:shape (tokei line-count summary) — fast, side-effect-free, safe for self-tests'
  }
};

export type CommandId = keyof typeof COMMAND_REGISTRY;

const FILTER_RE = /^[A-Za-z0-9_./*-]+$/;

export class UnknownCommandError extends Error {
  constructor(public readonly commandId: string) {
    super(`unknown commandId: ${commandId}`);
    this.name = 'UnknownCommandError';
  }
}

export class UnsupportedFilterError extends Error {
  constructor(public readonly commandId: string) {
    super(`commandId does not accept a filter: ${commandId}`);
    this.name = 'UnsupportedFilterError';
  }
}

export class InvalidFilterError extends Error {
  constructor(public readonly filter: string) {
    super(`filter contains disallowed characters: ${filter}`);
    this.name = 'InvalidFilterError';
  }
}

/**
 * Resolve a commandId (+ optional filter) to a fixed argv array. The filter,
 * when supported, is validated against an allowlist and appended as a plain
 * positional argument — never interpolated into a shell string (spawn always
 * runs with shell:false) and never allowed to introduce a leading "-" that
 * could be read as an extra flag.
 */
export function resolveCommand(commandId: string, filter?: string): { command: string; args: string[]; timeoutMs: number } {
  const spec = COMMAND_REGISTRY[commandId];
  if (!spec) throw new UnknownCommandError(commandId);
  if (filter === undefined || filter === '') return { command: spec.command, args: spec.args, timeoutMs: spec.timeoutMs };
  if (!spec.filterable) throw new UnsupportedFilterError(commandId);
  if (!FILTER_RE.test(filter) || filter.startsWith('-')) throw new InvalidFilterError(filter);
  return { command: spec.command, args: [...spec.args, filter], timeoutMs: spec.timeoutMs };
}

export function listCommands(): Array<{ commandId: string; description: string; filterable: boolean }> {
  return Object.entries(COMMAND_REGISTRY).map(([commandId, spec]) => ({
    commandId,
    description: spec.description,
    filterable: spec.filterable
  }));
}
