import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  normalizeSpreadsheetExtractionLimits,
  type SpreadsheetExtractionLimitOverrides,
  type WorkbookExtraction
} from "./spreadsheet-contract.js";

export * from "./spreadsheet-contract.js";

interface SpreadsheetProcessMessage {
  ok: boolean;
  result?: WorkbookExtraction;
  error?: string;
}

export async function extractWorkbookBytes(
  bytes: Uint8Array,
  fileName: string,
  limitOverrides: SpreadsheetExtractionLimitOverrides = {}
): Promise<WorkbookExtraction> {
  const limits = normalizeSpreadsheetExtractionLimits(limitOverrides);
  if (bytes.byteLength > limits.maxSourceBytes) {
    throw new Error(`spreadsheet source has ${bytes.byteLength} bytes; limit is ${limits.maxSourceBytes}`);
  }
  const processPath = fileURLToPath(spreadsheetProcessUrl());
  const snapshot = Buffer.from(bytes);
  return new Promise<WorkbookExtraction>((resolve, reject) => {
    let settled = false;
    const parser = fork(processPath, [], {
      execArgv: [
        `--max-old-space-size=${limits.maxHeapMb}`,
        `--max-semi-space-size=${Math.max(16, Math.min(64, Math.floor(limits.maxHeapMb / 4)))}`,
        "--stack-size=8192"
      ],
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"]
    });
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(() => {
      finish(() => {
        parser.kill();
        reject(new Error(`spreadsheet parse exceeded ${limits.maxParseMs}ms`));
      });
    }, limits.maxParseMs);
    parser.once("message", (message: SpreadsheetProcessMessage) => {
      finish(() => {
        parser.kill();
        if (message.ok && message.result) resolve(message.result);
        else reject(new Error(message.error || "spreadsheet parser process returned no result"));
      });
    });
    parser.once("error", error => finish(() => reject(new Error(`spreadsheet parser process failed: ${error.message}`))));
    parser.once("exit", code => {
      if (code !== 0) finish(() => reject(new Error(`spreadsheet parser process exited with code ${code}`)));
      else finish(() => reject(new Error("spreadsheet parser process exited before returning a result")));
    });
    parser.send({ bytes: snapshot, fileName, limits }, error => {
      if (error) finish(() => reject(new Error(`spreadsheet parser process IPC failed: ${error.message}`)));
    });
  });
}

function spreadsheetProcessUrl(): URL {
  const colocated = new URL("./spreadsheet-process.js", import.meta.url);
  if (existsSync(fileURLToPath(colocated))) return colocated;
  const builtFromSource = new URL("../dist/spreadsheet-process.js", import.meta.url);
  if (existsSync(fileURLToPath(builtFromSource))) return builtFromSource;
  throw new Error("spreadsheet parser process is unavailable; build @scce/adapters-node before workbook ingestion");
}
