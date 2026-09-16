// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Every source file that builds something a person reads. No authored sentence may live in any of them. */
const SURFACE_SOURCES = [
  "ui/src/index.ts",
  "ui/src/workbench-model.ts",
  "ui/src/developer-surface.ts",
  "vscode/src/chat-view.ts",
  "vscode/src/extension.ts",
  "vscode/src/withheld-surface.ts",
  "server/src/index.ts",
  "kernel/src/localization.ts",
  "kernel/src/learning-acquisition-runtime.ts",
  "kernel/src/withheld-surface.ts"
];

/**
 * A string literal is prose when three or more letter-runs sit inside it separated by spaces. Identifiers,
 * ids, selectors, URLs, CSS declarations and single words all fail that shape, so only authored wording trips it.
 */
function proseLiteralsIn(source: string): string[] {
  const hits: string[] = [];
  source.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    for (const match of line.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
      const value = match[2] ?? "";
      if ((value.match(/[A-Za-z]{2,}/g) ?? []).length < 3) continue;
      if (!/[A-Za-z]{2,}\s+[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(value)) continue;
      hits.push(`${index + 1}: ${value.slice(0, 120)}`);
    }
  });
  return hits;
}

describe("authored surface text", () => {
  it("has no locale table to speak from", () => {
    expect(() => readFileSync(path.join(PACKAGES, "ui/src/locales.ts"), "utf8")).toThrow();
  });

  for (const relative of SURFACE_SOURCES) {
    it(`authors no sentence in ${relative}`, () => {
      expect(proseLiteralsIn(readFileSync(path.join(PACKAGES, relative), "utf8"))).toEqual([]);
    });
  }
});
