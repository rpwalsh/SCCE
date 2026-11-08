// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. See LICENSE.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { file: { type: "string" }, language: { type: "string" }, callable: { type: "string" }, out: { type: "string" } } });
try {
  if (!values.file || !values.callable || !["javascript", "typescript"].includes(values.language)) {
    throw new Error("usage: node tools/solver-check/extract-source.mjs --file SOURCE --language javascript|typescript --callable NAME [--out JSON]; run pnpm build first");
  }
  const { compileSourceCodeFunctions } = await import("../../packages/adapters-node/dist/source-code-function-learning.js");
  const text = await readFile(values.file, "utf8");
  const rows = compileSourceCodeFunctions({ text, path: values.file, languageId: values.language, sourceHash: createHash("sha256").update(text).digest("hex") })
    .filter(row => row.callable.name === values.callable);
  if (rows.length !== 1) throw new Error(`expected one compiler-owned pure callable, found ${rows.length}`);
  const encoded = `${JSON.stringify(rows[0])}\n`;
  if (values.out) await writeFile(values.out, encoded, "utf8");
  else process.stdout.write(encoded);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 4;
}
