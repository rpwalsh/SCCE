// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export async function compareSourceArtifactStreams(expected, actual, { canonicalStringify, jsonByteLengths }) {
  const left = expected[Symbol.asyncIterator](), right = actual[Symbol.asyncIterator]();
  const digest = createHash('sha256');
  let records = 0, decodedJsonBytes = 0, decodedJsonbBytes = 0, previous;
  try {
    while (true) {
      const [a, b] = await Promise.all([left.next(), right.next()]);
      assert.equal(Boolean(b.done), Boolean(a.done), 'decoded artifact count differs');
      if (a.done) break;
      const row = a.value;
      assert.equal(typeof row.id, 'string', 'artifact identity is missing');
      assert.ok(previous === undefined || previous < row.id, 'artifact stream must be strictly identity-ordered');
      assert.equal(b.value.id, row.id, 'decoded artifact identity differs');
      const serialized = canonicalStringify(row);
      assert.equal(canonicalStringify(b.value), serialized, `decoded artifact changed: ${row.id}`);
      const bytes = jsonByteLengths(row);
      for (const key of ['decodedJsonBytes', 'decodedJsonbBytes']) assert.ok(Number.isSafeInteger(bytes[key]) && bytes[key] >= 0, 'invalid decoded byte accounting');
      decodedJsonBytes += bytes.decodedJsonBytes;
      decodedJsonbBytes += bytes.decodedJsonbBytes;
      assert.ok(Number.isSafeInteger(decodedJsonBytes) && Number.isSafeInteger(decodedJsonbBytes), 'decoded byte total exceeds exact numeric range');
      digest.update(`${Buffer.byteLength(serialized)}:`).update(serialized);
      previous = row.id; records++;
    }
    return { records, canonicalRecordsSha256: digest.digest('hex'), decodedJsonBytes, decodedJsonbBytes };
  } finally {
    await Promise.allSettled([left.return?.(), right.return?.()]);
  }
}

export async function* artifactRowsFromPages(pages) {
  for await (const page of pages) for (const row of page) yield row;
}
