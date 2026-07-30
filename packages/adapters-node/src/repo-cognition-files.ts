/**
 * Phase 15: real, bounded repo-file collection feeding
 * repo-cognition.ts's live-turn wiring. Reads only caller-supplied
 * requestedPaths (never a directory walk -- an explicit, already-bounded
 * selection the client made, matching the existing workspace-coding
 * request's own requestedPaths field), parsing TS/TSX/JS files through
 * the real tree-sitter substrate so the kernel's issue localizer can use
 * real declarations instead of falling back to its regex extractor.
 *
 * Every failure mode (path escapes the workspace root, file missing, file
 * too large, parse error) is a silent skip, never a thrown error -- repo
 * cognition is always optional context for a turn, never something that
 * should block an answer.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { RepoCognitionFile } from "@scce/kernel";
import { languageIdForFilePath, parseRepositorySyntax } from "./tree-sitter-syntax.js";

const MAX_FILES = 25;
const MAX_FILE_BYTES = 300_000;

function isWithinRoot(root: string, candidate: string): boolean {
  const r = path.resolve(root);
  const c = path.resolve(candidate);
  return c === r || c.startsWith(`${r}${path.sep}`);
}

export async function collectRepoFilesForCognition(
  root: string,
  requestedPaths: readonly string[]
): Promise<RepoCognitionFile[]> {
  const files: RepoCognitionFile[] = [];
  for (const requestedPath of requestedPaths.slice(0, MAX_FILES)) {
    const absolute = path.resolve(root, requestedPath);
    if (!isWithinRoot(root, absolute)) continue;

    let text: string;
    try {
      const stats = await stat(absolute);
      if (!stats.isFile() || stats.size > MAX_FILE_BYTES) continue;
      text = await readFile(absolute, "utf8");
    } catch {
      continue;
    }

    const languageId = languageIdForFilePath(requestedPath);
    if (languageId) {
      try {
        const parsed = await parseRepositorySyntax({ fileId: requestedPath, languageId, text });
        files.push({ path: requestedPath, text, syntaxNodes: parsed.nodes });
        continue;
      } catch {
        // Fall through to raw text below -- an optional parse enhancement, never a hard requirement.
      }
    }
    files.push({ path: requestedPath, text });
  }
  return files;
}
