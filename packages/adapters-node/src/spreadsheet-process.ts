// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { parseWorkbookBytes } from "./spreadsheet-parser.js";
import type { SpreadsheetExtractionLimits } from "./spreadsheet-contract.js";

interface SpreadsheetProcessData {
  bytes: Buffer;
  fileName: string;
  limits: SpreadsheetExtractionLimits;
}

if (!process.send) throw new Error("spreadsheet parser process requires an IPC channel");

process.once("message", (message: unknown) => {
  try {
    const data = message as SpreadsheetProcessData;
    if (!Buffer.isBuffer(data.bytes)) throw new Error("spreadsheet parser process received invalid bytes");
    const result = parseWorkbookBytes(data.bytes, data.fileName, data.limits);
    process.send?.({ ok: true, result }, disconnect);
  } catch (error) {
    process.send?.({ ok: false, error: error instanceof Error ? error.message : String(error) }, disconnect);
  }
});

function disconnect(): void {
  if (process.connected) process.disconnect();
}
