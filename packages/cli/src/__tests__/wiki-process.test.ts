// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { wikiChildArgs, wikiContinueAfterConfiguredPageCap, wikiRunPaths } from "../wiki-process.js";

describe("Wikipedia supervisor isolation", () => {
  it("continues a default segment cap, honors explicit bounds, and rejects a resume loop", () => {
    const status = { stopReason: "maxPagesPerRun", lastCheckpointOffset: 500, resumedFromOffset: 100 };
    expect(wikiContinueAfterConfiguredPageCap(status, {})).toBe(true);
    expect(wikiContinueAfterConfiguredPageCap(status, { maxPages: 300 })).toBe(false);
    expect(wikiContinueAfterConfiguredPageCap(status, { maxBlocks: 12 })).toBe(false);
    expect(() => wikiContinueAfterConfiguredPageCap({ ...status, lastCheckpointOffset: 100 }, {})).toThrow(/no durable block progress/);
  });
  it("carries the resolved schema override across the actual child process boundary", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "scce-wiki-child-"));
    try {
      const cliPath = path.join(directory, "child.cjs");
      const configPath = path.join(directory, "config.json");
      await writeFile(configPath, JSON.stringify({ database: { schema: "scce3_runtime" } }));
      await writeFile(cliPath, `const args=process.argv.slice(2);
const config=JSON.parse(require('fs').readFileSync(args[args.indexOf('--config')+1]));
const pos=args.indexOf('--schema');
console.log(JSON.stringify({schema:pos>=0?args[pos+1]:config.database.schema,args}));`);
      const args = wikiChildArgs({ cliPath, configPath, schema: "scce6_runtime", childHeapMb: 128,
        target: path.join(directory, "full dump.xml.bz2"), flags: ["--max-pages=300"] });
      const child = spawnSync(process.execPath, args, { encoding: "utf8", windowsHide: true });
      expect(child.status, child.stderr).toBe(0);
      const result = JSON.parse(child.stdout);
      expect(result.schema).toBe("scce6_runtime");
      expect(result.args.slice(-2)).toEqual([path.join(directory, "full dump.xml.bz2"), "--max-pages=300"]);
    } finally {
      if (path.dirname(directory) !== path.resolve(tmpdir())) throw new Error("unexpected fixture path");
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("separates stop requests, status, and locks for two schemas", () => {
    const first = wikiRunPaths(".tmp", "scce5_runtime");
    const second = wikiRunPaths(".tmp", "scce6_runtime");
    expect(first.stopFile).not.toBe(second.stopFile);
    expect(first.statusPath).not.toBe(second.statusPath);
    expect(first.lockPath).not.toBe(second.lockPath);
    expect(wikiRunPaths(".tmp", "scce6_runtime", { stopFile: "explicit-stop.json" }).stopFile).toBe("explicit-stop.json");
  });
});
