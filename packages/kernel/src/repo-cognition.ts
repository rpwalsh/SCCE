/**
 * Phase 15 wiring: combines the already-real, already-tested
 * issue-to-symbol localizer (issue-symbol-localization.ts, plan items
 * 185-186) and import-graph affected-test predictor
 * (affected-test-prediction.ts, plan items 189-190) into one function
 * reachable from a live turn, given real repo file contents supplied by
 * the caller (the kernel package has no filesystem access of its own --
 * an adapter layer must read the real files and pass their text in).
 * Returns undefined when no repo files are supplied so this never
 * fabricates repository context for a turn that isn't actually
 * code-shaped.
 */

import { extractFileSymbols, localizeIssueToSymbols, type SymbolLocalizationCandidate } from "./issue-symbol-localization.js";
import { predictAffectedTests } from "./affected-test-prediction.js";

export interface RepoCognitionFile {
  path: string;
  text: string;
}

export interface RepoCognitionResult {
  filesConsidered: number;
  symbolLocalization: SymbolLocalizationCandidate[];
  changedFilePaths: string[];
  affectedTests: string[];
}

const DIFF_CHANGED_PATH_PATTERNS: RegExp[] = [
  /^diff --git a\/(\S+) b\/(\S+)/m,
  /^\+\+\+ b\/(\S+)/m,
  /^--- a\/(\S+)/m
];

/**
 * Extracts changed file paths from a unified diff embedded in the request
 * text, if one is present. Only paths that actually match a supplied repo
 * file are kept -- an unrecognized path is dropped rather than guessed at.
 */
export function changedFilePathsFromRequestText(requestText: string, knownPaths: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  for (const pattern of DIFF_CHANGED_PATH_PATTERNS) {
    const globalPattern = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    for (const match of requestText.matchAll(globalPattern)) {
      for (const group of match.slice(1)) {
        if (group && knownPaths.has(group)) found.add(group);
      }
    }
  }
  return [...found].sort();
}

export function repoCognitionForTurn(input: {
  requestText: string;
  files: readonly RepoCognitionFile[];
}): RepoCognitionResult | undefined {
  if (!input.files.length) return undefined;

  const symbols = input.files.flatMap(file => extractFileSymbols(file.path, file.text));
  const symbolLocalization = localizeIssueToSymbols(input.requestText, symbols, { limit: 10 });

  const allFilePaths = input.files.map(file => file.path);
  const knownPaths = new Set(allFilePaths);
  const changedFilePaths = changedFilePathsFromRequestText(input.requestText, knownPaths);
  const textByPath = new Map(input.files.map(file => [file.path, file.text]));
  const affectedTests = changedFilePaths.length
    ? predictAffectedTests({
      allFilePaths,
      readFile: path => textByPath.get(path),
      changedFilePaths
    })
    : [];

  return {
    filesConsidered: input.files.length,
    symbolLocalization,
    changedFilePaths,
    affectedTests
  };
}
