import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export class InvalidRepositoryRootError extends Error {
  constructor(public readonly root: string, public readonly missing: string[]) {
    super(`resolved repository root does not look like an SCCE checkout: ${root} (missing: ${missing.join(', ')})`);
    this.name = 'InvalidRepositoryRootError';
  }
}

const MARKER_PATHS = ['README.md', 'pnpm-workspace.yaml', join('packages', 'kernel', 'src', 'kernel.ts')];

function candidateRoot(): { root: string; source: string } {
  const explicit = process.env.SCCE_REPO_ROOT?.trim();
  if (explicit) return { root: resolve(explicit), source: 'SCCE_REPO_ROOT' };
  const claudeProject = process.env.CLAUDE_PROJECT_DIR?.trim();
  if (claudeProject) return { root: resolve(claudeProject), source: 'CLAUDE_PROJECT_DIR' };
  return { root: resolve(process.cwd()), source: 'cwd' };
}

function missingMarkers(root: string): string[] {
  return MARKER_PATHS.filter((marker) => !existsSync(join(root, marker)));
}

/**
 * Resolve the SCCE repository root every handler must use instead of a bare
 * process.cwd(), and fail loudly on a bad root instead of silently returning
 * empty results from the wrong directory.
 */
export function resolveRepositoryRoot(): string {
  const { root, missing } = resolveRepositoryRootDiagnostic();
  if (missing.length) throw new InvalidRepositoryRootError(root, missing);
  return root;
}

export function resolveRepositoryRootDiagnostic(): { root: string; source: string; missing: string[] } {
  const { root, source } = candidateRoot();
  return { root, source, missing: missingMarkers(root) };
}
