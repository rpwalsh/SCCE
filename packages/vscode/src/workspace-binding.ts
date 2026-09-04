// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { resolve } from "node:path";

export interface WorkspaceFolderIdentity<T> {
  folder: T;
  scheme: string;
  resolvedRoot: string;
  realRoot: string | null;
}

export interface ServerBoundWorkspaceFolder<T> {
  folder: T;
  resolvedRoot: string;
  realRoot: string;
}

export function selectServerBoundWorkspaceFolder<T>(
  serverResolvedRoot: string,
  serverRealRoot: string,
  candidates: readonly WorkspaceFolderIdentity<T>[]
): ServerBoundWorkspaceFolder<T> {
  const matches = candidates.filter(candidate => (
    candidate.scheme === "file"
    && candidate.realRoot !== null
    && sameFileSystemPath(candidate.resolvedRoot, serverResolvedRoot)
    && sameFileSystemPath(candidate.realRoot, serverRealRoot)
  ));
  if (matches.length === 0) {
    throw new Error(`the server workspace does not match any open local file-system workspace folder (${resolve(serverResolvedRoot)})`);
  }
  if (matches.length !== 1) {
    throw new Error("the server workspace matches more than one open local file-system workspace folder");
  }
  const match = matches[0]!;
  return { folder: match.folder, resolvedRoot: match.resolvedRoot, realRoot: match.realRoot! };
}

export function sameFileSystemPath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}
