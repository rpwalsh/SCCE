// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { ingestionCodeIdentity } from "../ingestion-code-identity.js";

it("binds uncommitted runtime code and relative paths while excluding test/output metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "scce-code-identity-"));
  try {
    await writeFile(path.join(root, "compiler.ts"), "export const version = 1;");
    const first = await ingestionCodeIdentity([root]);
    await mkdir(path.join(root, "__tests__"));
    await writeFile(path.join(root, "__tests__", "compiler.test.ts"), "ignored test");
    await writeFile(path.join(root, "compiler.d.ts"), "ignored declaration");
    await writeFile(path.join(root, "compiler.ts.map"), "ignored map");
    expect(await ingestionCodeIdentity([root])).toBe(first);
    await writeFile(path.join(root, "compiler.ts"), "export const version = 2;");
    expect(await ingestionCodeIdentity([root])).not.toBe(first);
  } finally {
    if (path.dirname(root) !== path.resolve(tmpdir())) throw new Error("unexpected fixture path");
    await rm(root, { recursive: true, force: true });
  }
});
