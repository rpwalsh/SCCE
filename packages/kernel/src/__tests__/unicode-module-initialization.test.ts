// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("built Unicode modules", () => {
  it("loads the acquired parser directly without depending on index import order", () => {
    const moduleUrl = new URL("../../dist/learned-surface-interpretation.js", import.meta.url).href;
    const result = execFileSync(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", `
      const { createLearnedSurfaceInterpreter } = await import(${JSON.stringify(moduleUrl)});
      const result = createLearnedSurfaceInterpreter('résume 👩🏽‍💻。', true).interpret({ sequence: [
        { kind: 'literal', surface: 'RÉSUME ' },
        { kind: 'slot', roleId: 'role', occurrenceId: 'role' },
        { kind: 'literal', surface: '。' }
      ] });
      process.stdout.write(JSON.stringify(result));
    `], { encoding: "utf8", timeout: 10000, windowsHide: true });
    expect(JSON.parse(result)).toEqual([{ roleId: "role", occurrenceId: "role", surface: "👩🏽‍💻", startCodePoint: 7, endCodePoint: 11 }]);
  });
});
