// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { artifactRowsFromPages, compareSourceArtifactStreams } from './source-artifact-parity.mjs';

const canonicalStringify = value => JSON.stringify(value, (_key, child) => child && typeof child === 'object' && !Array.isArray(child)
  ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : child);
const jsonByteLengths = value => ({ decodedJsonBytes: Buffer.byteLength(canonicalStringify(value)), decodedJsonbBytes: Buffer.byteLength(canonicalStringify(value)) });
const methods = { canonicalStringify, jsonByteLengths };
async function* pages(rows, width = 1) { for (let i = 0; i < rows.length; i += width) yield rows.slice(i, i + width); }
const compare = (a, b, width = 1) => compareSourceArtifactStreams(artifactRowsFromPages(pages(a, width)), artifactRowsFromPages(pages(b, 2)), methods);

test('hashes complete decoded records independently of pages and object key order', async () => {
  const rows = [{ id: 'a', metadata: { links: ['語', 'e\u0301', '\0'], extension: { retained: null } } }, { id: 'b', metadata: { absent: false, payload: 'λ'.repeat(20000) } }];
  const first = await compare(rows, structuredClone(rows));
  const second = await compare(rows, [{ metadata: rows[0].metadata, id: 'a' }, rows[1]], 2);
  assert.deepEqual(first, second); assert.equal(first.records, 2);
  assert.ok(first.decodedJsonBytes > 40000, 'decoded bytes must include referenced shared content');
  assert.equal((await compare([], [])).records, 0);
});

test('refuses missing, duplicate, reordered, tampered, or partially reconstructed public records', async () => {
  const rows = [{ id: 'a', metadata: { links: ['owned'], unknown: { preserved: true } } }, { id: 'b', alpha: 0.8 }];
  for (const actual of [rows.slice(0, 1), [...rows, { id: 'c' }], [rows[1], rows[0]], [rows[0], rows[0]],
    [{ ...rows[0], metadata: { links: ['changed'], unknown: { preserved: true } } }, rows[1]],
    [{ ...rows[0], metadata: { links: ['owned'] } }, rows[1]]]) await assert.rejects(compare(rows, actual));
  await assert.rejects(compare([rows[1], rows[0]], [rows[1], rows[0]]), /strictly identity-ordered/);
});

test('closes bounded page readers when a mismatch interrupts verification', async () => {
  let closed = 0;
  async function* stream(changed) { try { yield { id: 'a', value: changed }; yield { id: 'b' }; } finally { closed++; } }
  await assert.rejects(compareSourceArtifactStreams(stream(false), stream(true), methods));
  assert.equal(closed, 2);
});
