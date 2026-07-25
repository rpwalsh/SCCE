import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { resolveRepositoryRootDiagnostic } from './repoRoot.js';

export class TraceContainmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TraceContainmentError';
  }
}

const FILENAME_RE = /^[A-Za-z0-9._-]+\.jsonl$/;

export function resolveTraceDir(): string {
  const configured = process.env.SCCE_TRACE_DIR?.trim() || '.scce/traces';
  const { root } = resolveRepositoryRootDiagnostic();
  return resolve(root, configured);
}

/**
 * Resolve a caller-supplied trace filename to an absolute path guaranteed to
 * live inside the configured trace directory. Rejects anything shaped like a
 * path (the filename grammar has no separators, so a "../"-bearing value
 * cannot even parse), and rejects the file itself being a symlink so a
 * planted symlink cannot redirect a read outside the trace directory.
 */
export function resolveTraceFile(fileName: string): string {
  if (!FILENAME_RE.test(fileName)) {
    throw new TraceContainmentError(`trace file must be a bare .jsonl filename, got: ${fileName}`);
  }
  const dir = resolveTraceDir();
  const candidate = resolve(dir, fileName);

  const dirReal = existsSync(dir) ? realpathSync(dir) : resolve(dir);
  if (!existsSync(candidate)) {
    throw new TraceContainmentError(`trace file not found: ${fileName}`);
  }
  if (lstatSync(candidate).isSymbolicLink()) {
    throw new TraceContainmentError(`trace file must not be a symlink: ${fileName}`);
  }
  const candidateReal = realpathSync(candidate);
  if (candidateReal !== resolve(dirReal, fileName) && !candidateReal.startsWith(dirReal + sep)) {
    throw new TraceContainmentError(`trace file escapes the trace directory: ${fileName}`);
  }
  return candidate;
}
