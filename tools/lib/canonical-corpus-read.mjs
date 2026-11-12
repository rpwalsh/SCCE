// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Resolve source/chunk blob bytes using the caller's connection, schema and transaction.
import { createCanonicalBlobReader } from "../../packages/adapters-node/dist/canonical-evidence-text.js";

function natural(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("Invalid canonical evidence coordinate");
  return number;
}

export function canonicalEvidenceDigestHex(reference) {
  const contentHash = typeof reference === "string" ? reference : reference?.content_hash;
  if (!/^sha256_[a-f0-9]{64}$/u.test(String(contentHash))) throw new Error("Invalid canonical evidence content identity");
  return String(contentHash).slice(7);
}

export function createCanonicalCorpusReader(client, schema) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(schema)) throw new Error("Invalid canonical corpus schema");
  const host = {
    table: name => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new Error("Invalid canonical corpus table");
      return `"${schema}"."${name}"`;
    },
    query: async (sql, params) => {
      const result = await client.query(sql, params);
      return Array.isArray(result) ? result : result.rows;
    }
  };
  const bytes = createCanonicalBlobReader(host);
  const evidenceText = async row => {
    if (!row || typeof row !== "object") {
      throw new Error("Invalid canonical evidence reference");
    }
    canonicalEvidenceDigestHex(row);
    const start = natural(row.byte_start), end = natural(row.byte_end), charStart = natural(row.char_start), charEnd = natural(row.char_end);
    if (end < start || charEnd < charStart) {
      throw new Error("Canonical evidence metadata does not match its content identity");
    }
    const body = await bytes(String(row.content_hash));
    if (body.byteLength !== end - start) throw new Error("Canonical evidence byte coordinates differ");
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
    if ([...text].length !== charEnd - charStart) throw new Error("Canonical evidence character coordinates differ");
    return text;
  };
  const evidenceTexts = async (rows, concurrency = 8) => {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64) throw new Error("Invalid canonical evidence read concurrency");
    const values = new Array(rows.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= rows.length) return;
        values[index] = await evidenceText(rows[index]);
      }
    }));
    return values;
  };
  return { bytes, evidenceText, evidenceTexts };
}
