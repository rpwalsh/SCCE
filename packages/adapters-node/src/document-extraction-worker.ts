// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { parentPort } from "node:worker_threads";
import { extractDocumentWasm, type DocumentWasmExtractionRequest } from "./document-wasm-extraction.js";
import { assertOcrProfileId } from "./ocr-profile.js";

if (!parentPort) throw new Error("document extraction worker requires a parent port");
const port = parentPort;

port.on("message", async (value: unknown) => {
  const id = typeof value === "object" && value !== null && "id" in value ? (value as { id?: unknown }).id : undefined;
  try {
    if (!Number.isSafeInteger(id)) throw new Error("invalid document extraction worker request");
    const request = value as { id: number; request?: DocumentWasmExtractionRequest };
    if (!validRequest(request.request))
      throw new Error("invalid document extraction worker request");
    const result = await extractDocumentWasm(request.request);
    port.postMessage({ id: request.id, ok: true, result });
  } catch (error) {
    port.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

function validRequest(value: unknown): value is DocumentWasmExtractionRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<DocumentWasmExtractionRequest>;
  if (!(request.bytes instanceof Uint8Array) || !Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes! <= 0) return false;
  if (request.kind === "pdf-text") {
    if (request.ocrProfile === undefined) return true;
    try { assertOcrProfileId(request.ocrProfile); return true; } catch { return false; }
  }
  if (request.kind !== "image-ocr" || typeof request.ocrProfile !== "string") return false;
  try { assertOcrProfileId(request.ocrProfile); return true; } catch { return false; }
}
