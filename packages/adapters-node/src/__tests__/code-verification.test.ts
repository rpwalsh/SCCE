// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createSnippetVerifier, DEFAULT_LANGUAGE_CHECKS } from "../code-verification.js";

describe("language toolchain verification", () => {
  it("proves a TypeScript artifact with the compiler and fails a broken one", async () => {
    const verifier = createSnippetVerifier();
    const good = await verifier.verify({ language: "typescript", source: "export function add(a: number, b: number): number { return a + b; }" });
    expect(good.status).toBe("verified");
    const bad = await verifier.verify({ language: "typescript", source: "export function add(a: number, b: number): number { return a + c; }" });
    expect(bad.status).toBe("failed");
    expect(bad.diagnostics.join(" ")).toMatch(/TS\d+/u);
  }, 60_000);

  it("reports a language with no configured checker as unproven rather than verified", async () => {
    const verifier = createSnippetVerifier();
    expect((await verifier.verify({ language: "sql", source: "select 1;" })).status).toBe("unsupported");
    expect((await verifier.verify({ language: "brainfuck", source: "+++." })).status).toBe("unsupported");
  });

  it("learns a language from a configured checker, and proves an artifact with it", async () => {
    const verifier = createSnippetVerifier({
      checks: { toy: { command: process.execPath, args: ["-e", "process.exit(require('fs').readFileSync(process.argv[1],'utf8').includes('ok') ? 0 : 3)", "{artifact}"], extension: "toy" } }
    });
    expect((await verifier.verify({ language: "toy", source: "ok" })).status).toBe("verified");
    expect((await verifier.verify({ language: "toy", source: "nope" })).status).toBe("unsupported");
  }, 30_000);

  it("treats a missing checker as unproven, never as proof", async () => {
    const verifier = createSnippetVerifier({
      checks: { ghost: { command: "scce-no-such-compiler", args: ["{artifact}"], extension: "gh" } }
    });
    expect((await verifier.verify({ language: "ghost", source: "anything" })).status).toBe("unsupported");
  }, 30_000);

  it("refuses an empty artifact", async () => {
    expect((await createSnippetVerifier().verify({ language: "typescript", source: "   " })).status).toBe("failed");
  });

  it("ships a checker entry for every language the request detector can name", () => {
    for (const language of ["typescript", "javascript", "python", "rust", "go", "java", "kotlin", "swift", "csharp", "ruby", "php", "shell", "c", "cpp", "sql"]) {
      expect(DEFAULT_LANGUAGE_CHECKS[language], language).toBeDefined();
    }
  });
});
