// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import path from "node:path";
import ts from "typescript";

/**
 * Path glob matching, stated once.
 *
 * `typescript-code-actions.ts` and `typescript-semantic-program-index.ts` each carried a byte-identical private
 * copy of this, and the project-manifest role reader needs the same semantics: whatever decides which files a
 * tsconfig `include` covers must decide which files a test runner's `include` covers, or two readers of the same
 * project disagree about the same project.
 */
export function pathGlobMatches(relativePath: string, rawPattern: string): boolean {
  const normalized = normalizePattern(rawPattern);
  if (!normalized) return false;
  const target = relativePath.replace(/\\/gu, "/");
  return expandBraces(normalized).some(pattern => patternRegExp(pattern).test(target));
}

/**
 * Whether this matcher implements everything the pattern says.
 *
 * Extended-glob syntax (jest's `?(*.)+(spec|test).[jt]s?(x)`) and a `testRegex` are not globs, and silently
 * treating their punctuation as literal would make a declaration match nothing while reporting that it was read.
 * A pattern this returns false for is carried as unreadable, never as a measurement.
 */
export function pathGlobSupported(rawPattern: string): boolean {
  const pattern = normalizePattern(rawPattern);
  if (!pattern) return false;
  return !/[+@!]\(|\?\(|[()\[\]|]/u.test(pattern);
}

/** Literal path segments in a pattern. More is more specific; used to order two declarations deterministically. */
export function pathGlobSpecificity(rawPattern: string): number {
  return normalizePattern(rawPattern)
    .split("/")
    .filter(segment => segment.length > 0 && !/[?*{}]/u.test(segment))
    .length;
}

function normalizePattern(rawPattern: string): string {
  return rawPattern.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/$/u, "");
}

/** `{a,b}` alternation, expanded before matching so the regexp stays a pure glob translation. Bounded by nesting. */
function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf("{");
  if (open < 0) return [pattern];
  let depth = 0;
  for (let index = open; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) {
        const alternatives = splitAlternatives(pattern.slice(open + 1, index));
        const head = pattern.slice(0, open);
        const tail = pattern.slice(index + 1);
        return alternatives.flatMap(alternative => expandBraces(`${head}${alternative}${tail}`));
      }
    }
  }
  return [pattern];
}

function splitAlternatives(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of body) {
    if (char === "{") depth++;
    if (char === "}") depth--;
    if (char === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  out.push(current);
  return out;
}

function patternRegExp(rawPattern: string): RegExp {
  let pattern = rawPattern;
  if (!/[?*]/u.test(pattern)) pattern = path.posix.extname(pattern) ? pattern : `${pattern}/**/*`;
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*" && pattern[index + 1] === "*") {
      const followedBySlash = pattern[index + 2] === "/";
      expression += followedBySlash ? "(?:.*/)?" : ".*";
      index += followedBySlash ? 2 : 1;
    } else if (char === "*") expression += "[^/]*";
    else if (char === "?") expression += "[^/]";
    else expression += char.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
  }
  expression += "$";
  return new RegExp(expression, ts.sys.useCaseSensitiveFileNames ? "u" : "iu");
}
