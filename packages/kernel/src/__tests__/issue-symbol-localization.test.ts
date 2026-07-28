import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  extractFileSymbols,
  extractSqlTableSymbols,
  extractTypeScriptSymbols,
  localizeIssueToSymbols
} from "../issue-symbol-localization.js";

describe("issue-to-symbol localization: synthetic fixture (plan item 186)", () => {
  const tsFixture = [
    "// Computes the discounted Kneser-Ney probability for one symbol.",
    "// See docs/LANGUAGE_MODEL.md for the smoothing derivation.",
    "export function kneserNeyProbability(history: string[], symbol: string): number {",
    "  return 0;",
    "}",
    "",
    "// Renders a bounded preview of a workspace patch diff for the reviewer.",
    "export function renderPatchPreview(before: string, after: string): string {",
    "  return before + after;",
    "}",
    ""
  ].join("\n");

  const sqlFixture = [
    "export const CREATE_TABLES = [",
    "  `CREATE TABLE IF NOT EXISTS ${q}.evidence_spans (id TEXT PRIMARY KEY, text_content TEXT NOT NULL)`,",
    "  `CREATE TABLE IF NOT EXISTS ${q}.graph_nodes (id TEXT PRIMARY KEY, alpha DOUBLE PRECISION NOT NULL)`",
    "];"
  ].join("\n");

  it("ranks the TypeScript function whose name and comment actually mention the issue's terms above an unrelated one", () => {
    const symbols = extractFileSymbols("fixture/kneser-ney.ts", tsFixture);
    const candidates = localizeIssueToSymbols(
      "The Kneser-Ney discounted probability for a symbol looks wrong for unseen histories.",
      symbols
    );

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.symbol.name).toBe("kneserNeyProbability");
    expect(candidates[0]!.symbol.kind).toBe("function");
    // tokenize() splits camelCase boundaries ("kneserNeyProbability" ->
    // "kneser"/"ney"/"probability"), so these are the real matched tokens.
    expect(candidates[0]!.matchedTerms).toEqual(expect.arrayContaining(["kneser", "ney", "probability", "symbol"]));
    expect(candidates[0]!.score).toBeGreaterThan(candidates[1]?.score ?? 0);
  });

  it("localizes across the TS/SQL language boundary: an issue about a specific column lands on the matching CREATE TABLE symbol", () => {
    const symbols = extractSqlTableSymbols("fixture/postgres.ts", sqlFixture);
    expect(symbols.map(symbol => symbol.name)).toEqual(["evidence_spans", "graph_nodes"]);

    const candidates = localizeIssueToSymbols(
      "Evidence spans are missing their text_content after a promoted-status migration.",
      symbols
    );

    expect(candidates[0]!.symbol.id).toBe("fixture/postgres.ts#TABLE:evidence_spans");
    expect(candidates[0]!.symbol.kind).toBe("sql_table");
    // graph_nodes may still appear (its DDL also contains the SQL type
    // "TEXT", an incidental real overlap with "text_content"), but it must
    // rank clearly behind the table whose actual column name matched.
    const graphNodes = candidates.find(candidate => candidate.symbol.name === "graph_nodes");
    if (graphNodes) expect(graphNodes.score).toBeLessThan(candidates[0]!.score);
  });

  it("returns nothing rather than a low-confidence guess when the issue text shares no real terms with any symbol", () => {
    const symbols = extractFileSymbols("fixture/kneser-ney.ts", tsFixture);
    const candidates = localizeIssueToSymbols("zzz qqq xyzzy plugh", symbols);
    expect(candidates).toEqual([]);
  });

  it("caps results at the requested limit, keeping the highest-scoring candidates", () => {
    const manySymbols = Array.from({ length: 20 }, (_, index) => ({
      id: `fixture.ts#helper${index}`,
      kind: "function" as const,
      name: `helper${index}`,
      path: "fixture.ts",
      lineStart: index + 1,
      lineEnd: index + 1,
      context: `// helper number ${index} for the retry budget`
    }));
    const candidates = localizeIssueToSymbols("the retry budget helper is off by one", manySymbols, { limit: 3 });
    expect(candidates.length).toBe(3);
  });
});

describe("issue-to-symbol localization validated against this repo's real files (plan item 186)", () => {
  const kernelSrcDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const adaptersSrcDir = resolve(kernelSrcDir, "..", "..", "adapters-node", "src");

  it("localizes a real bug description to affected-test-prediction.ts's real buildImportGraph function in this repo's own source", () => {
    const text = readFileSync(join(kernelSrcDir, "affected-test-prediction.ts"), "utf8");
    const symbols = extractTypeScriptSymbols("packages/kernel/src/affected-test-prediction.ts", text);
    expect(symbols.some(symbol => symbol.name === "buildImportGraph")).toBe(true);

    const candidates = localizeIssueToSymbols(
      "buildImportGraph does not resolve relative import specifiers correctly for nested directories.",
      symbols
    );

    expect(candidates[0]!.symbol.name).toBe("buildImportGraph");
  });

  it("extracts real CREATE TABLE symbols from this repo's actual postgres.ts, including graph_nodes", () => {
    const text = readFileSync(join(adaptersSrcDir, "postgres.ts"), "utf8");
    const symbols = extractSqlTableSymbols("packages/adapters-node/src/postgres.ts", text);

    expect(symbols.length).toBeGreaterThan(10);
    expect(symbols.some(symbol => symbol.name === "graph_nodes")).toBe(true);
    expect(symbols.some(symbol => symbol.name === "evidence_spans")).toBe(true);
    for (const symbol of symbols) {
      expect(symbol.lineStart).toBeGreaterThan(0);
      expect(symbol.lineEnd).toBeGreaterThanOrEqual(symbol.lineStart);
    }
  });
});
