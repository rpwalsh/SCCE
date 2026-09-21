// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** Fingerprint the actual adapter and kernel code being executed, including uncommitted repairs. */
export async function ingestionCodeIdentity(roots: readonly string[] = [
  path.dirname(fileURLToPath(import.meta.url)),
  path.dirname(createRequire(import.meta.url).resolve("@scce/kernel"))
]): Promise<string> {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ contract: "scce.ingestion-code.v1", node: process.versions.node, icu: process.versions.icu }));
  for (const [ordinal, root] of roots.entries()) {
    const files: string[] = [];
    async function visit(directory: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(file);
        else if (entry.isFile() && /\.(?:[cm]?js|[cm]?ts)$/u.test(entry.name)
          && !/\.(?:test|spec|d)\.[cm]?[jt]s$/u.test(entry.name)) files.push(file);
      }
    }
    await visit(root);
    if (!files.length) throw new Error(`Ingestion code identity has no runtime files in ${root}`);
    for (const file of files.sort()) {
      const content = createHash("sha256");
      for await (const chunk of createReadStream(file)) content.update(chunk);
      hash.update(JSON.stringify([ordinal, path.relative(root, file).replaceAll("\\", "/"), content.digest("hex")]));
    }
  }
  return `sha256:${hash.digest("hex")}`;
}
