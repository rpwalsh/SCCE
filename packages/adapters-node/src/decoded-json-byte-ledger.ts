// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalJsonByteLength } from "@scce/kernel";

export const DECODED_JSON_BYTE_LEDGER_SCHEMA = "scce.decoded_json.byte_ledger.v1" as const;
export const DECODED_JSON_BYTE_LEDGER_KEY = "_scceDecodedJsonByteLedger" as const;

export interface DecodedJsonByteLengths {
  decodedJsonBytes: number;
  decodedJsonbBytes: number;
}

export interface DecodedJsonByteLedger extends DecodedJsonByteLengths {
  schema: typeof DECODED_JSON_BYTE_LEDGER_SCHEMA;
}

/** Exact compact-JSON and PostgreSQL JSONB-text byte charges for a decoded value. */
export function decodedJsonByteLengths(value: unknown): DecodedJsonByteLengths {
  return jsonByteLengths(value, new WeakMap());
}

export function decodedJsonByteLedger(value: unknown): DecodedJsonByteLedger {
  return { schema: DECODED_JSON_BYTE_LEDGER_SCHEMA, ...decodedJsonByteLengths(value) };
}

export function isDecodedJsonByteLedger(value: unknown): value is DecodedJsonByteLedger {
  const row = record(value);
  return row !== undefined && row.schema === DECODED_JSON_BYTE_LEDGER_SCHEMA
    && Object.keys(row).sort().join(",") === "decodedJsonBytes,decodedJsonbBytes,schema"
    && validSizes(row);
}

/** Check the original logical byte charge after every physical codec has been restored. */
export function verifyDecodedJsonByteLedger(wire: unknown, logical: unknown): void {
  const root = record(wire);
  if (!root || !Object.hasOwn(root, DECODED_JSON_BYTE_LEDGER_KEY)) return;
  const ledger = root[DECODED_JSON_BYTE_LEDGER_KEY];
  const sizes = decodedJsonByteLengths(logical);
  if (!isDecodedJsonByteLedger(ledger)
    || ledger.decodedJsonBytes !== sizes.decodedJsonBytes
    || ledger.decodedJsonbBytes !== sizes.decodedJsonbBytes) {
    throw Error("decoded JSON byte ledger mismatch");
  }
}

function jsonByteLengths(value: unknown, cache: WeakMap<object, DecodedJsonByteLengths>): DecodedJsonByteLengths {
  if (value instanceof Date) return jsonByteLengths(value.toISOString(), cache);
  if (value && typeof value === "object") {
    const found = cache.get(value);
    if (found) return found;
    const children = Array.isArray(value)
      ? Array.from(value, child => jsonByteLengths(child, cache))
      : Object.entries(value).map(([key, child]) => {
        const bytes = jsonByteLengths(child, cache);
        const keyBytes = Buffer.byteLength(JSON.stringify(key));
        return {
          decodedJsonBytes: keyBytes + 1 + bytes.decodedJsonBytes,
          decodedJsonbBytes: keyBytes + 2 + bytes.decodedJsonbBytes
        };
      });
    const result = children.reduce((total, child) => ({
      decodedJsonBytes: total.decodedJsonBytes + child.decodedJsonBytes,
      decodedJsonbBytes: total.decodedJsonbBytes + child.decodedJsonbBytes
    }), {
      decodedJsonBytes: 2 + Math.max(0, children.length - 1),
      decodedJsonbBytes: 2 + Math.max(0, children.length - 1) * 2
    });
    cache.set(value, result);
    return result;
  }
  const decodedJsonBytes = typeof value === "string"
    ? Buffer.byteLength(JSON.stringify(value))
    : canonicalJsonByteLength(value);
  if (typeof value !== "number" || !Number.isFinite(value) || !String(value).includes("e")) {
    return { decodedJsonBytes, decodedJsonbBytes: decodedJsonBytes };
  }
  const [mantissa, exponent] = String(value).split("e");
  const unsigned = mantissa!.replace(/^-/, "");
  const digits = unsigned.replace(".", "");
  const decimalPosition = (unsigned.includes(".") ? unsigned.indexOf(".") : unsigned.length) + Number(exponent);
  const expanded = decimalPosition <= 0
    ? 2 - decimalPosition + digits.length
    : decimalPosition >= digits.length ? decimalPosition : digits.length + 1;
  return { decodedJsonBytes, decodedJsonbBytes: Math.max(decodedJsonBytes, expanded + Number(value < 0)) };
}

function validSizes(value: Record<string, unknown>): boolean {
  return Number.isSafeInteger(value.decodedJsonBytes) && Number(value.decodedJsonBytes) >= 0
    && Number.isSafeInteger(value.decodedJsonbBytes)
    && Number(value.decodedJsonbBytes) >= Number(value.decodedJsonBytes);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
