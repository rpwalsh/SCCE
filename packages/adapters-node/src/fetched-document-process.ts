// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import path from "node:path";
import { extractDocument } from "./document.js";
import type { ScceRuntimeConfig } from "./config.js";

if (!process.send) throw new Error("fetched document parser requires its parent IPC channel");
process.once("message", async (value: unknown) => {
  try {
    const input = value as { filePath?: string; maxBytes?: number };
    if (!input.filePath || path.extname(input.filePath) !== ".docx" || !Number.isSafeInteger(input.maxBytes) || input.maxBytes! <= 0)
      throw new Error("invalid fetched DOCX parser input");
    const config = { runtime: { workspaceRoot: path.dirname(input.filePath), maxFileBytes: input.maxBytes, tools: {} } } as ScceRuntimeConfig;
    const result = await extractDocument(input.filePath, config, { includeVisualAttributes: false });
    if (Buffer.byteLength(result.text, "utf8") > input.maxBytes!) throw new Error("fetched DOCX text exceeded output byte limit");
    process.send?.({ ok: true, result }, disconnect);
  } catch (error) { process.send?.({ ok: false, error: error instanceof Error ? error.message : String(error) }, disconnect); }
});
function disconnect(): void { if (process.connected) process.disconnect(); }
