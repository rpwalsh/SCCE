import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { admitReference } from '../campaign-reference-admission.mjs';
import { canonical, writeJson, verified } from '../protocol.mjs';
import { admissionExecutor } from './reference-admission-fixture.mjs';

const roots = [];
after(async () => { for (const dir of roots) await rm(dir, { recursive: true, force: true }); });
async function options(extra = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'scce-ref-admission-')); roots.push(dir);
  const emptyCorpusFile = path.join(dir, 'empty.json'); await writeJson(emptyCorpusFile, { documents: [] });
  return { emptyCorpusFile, modelDigest: 'a'.repeat(64), runtimeVersion: '0.32.5', contextTokens: 32768, outputTokens: 4096, threads: 4, device: 'cpu', seed: 0, budgets: { timeMs: 10000, outputBytes: 131072 }, ...extra };
}
test('automatic admission uses only the declared runner, rejects overflow first and restores exact native-schema residency before freeze', async () => {
  const executor = admissionExecutor(), config = await options({ maxReferenceModelBytes: 4000000000 });
  const receipt = await admitReference(config, { executeCommand: executor, randomBytes: n => Buffer.alloc(n, 65) });
  verified(receipt);
  assert.equal(executor.calls.length, 2);
  assert.ok(executor.calls.every(c => c.argv[1].endsWith('reference-ollama.mjs')));
  assert.equal(Buffer.byteLength(executor.calls[0].question.prompt), 48000);
  assert.equal(executor.calls[1].question.prompt.includes(executor.calls[1].question.format.properties.nonce.const), false);
  assert.equal(receipt.overflow.reportedPromptTokens, 42341);
  assert.equal(receipt.overflow.reportedContextTokens, 1024);
  assert.equal(receipt.reportedResidency.contextTokens, 32768);
  assert.equal(receipt.reportedResidency.modelBytes, 3368466512);
  assert.equal(receipt.reportedResidency.allocationCeilingBytes, 4000000000);
  assert.equal(receipt.reportedResidency.processRssBytes, null);
  assert.equal(receipt.reportedResidency.totalProductRamBytes, null);
  assert.equal(canonical(receipt).includes('RAW_ERROR_PRIVATE_CANARY_NO_PUBLIC_RECEIPT'), false);
  assert.equal(canonical(receipt).includes('UNSTRUCTURED'), false);
  assert.equal(Object.hasOwn(receipt.overflow, 'prompt'), false);
});
for (const variant of ['ignored-overflow', 'ignored-schema', 'untyped-error', 'wrong-context', 'small-token-count', 'missing-error-hash', 'model-changed', 'runtime-changed', 'schema-digest-mismatch', 'residency-context-mismatch', 'missing-residency', 'missing-controls', 'length-exhausted', 'runner-exit']) {
  test(`setup fails closed for ${variant}`, async () => {
    const config = await options();
    await assert.rejects(() => admitReference(config, { executeCommand: admissionExecutor(variant), randomBytes: n => Buffer.alloc(n, 65) }), /Reference admission failed/);
  });
}
test('reported model-allocation bound and requested GPU admission fail setup without inventing process RAM measurements', async () => {
  const config = await options({ maxReferenceModelBytes: 3368466511 });
  await assert.rejects(() => admitReference(config, { executeCommand: admissionExecutor(), randomBytes: n => Buffer.alloc(n, 65) }), /allocation exceeds/);
  const gpu = await options({ device: 'gpu' });
  await assert.rejects(() => admitReference(gpu, { executeCommand: admissionExecutor(), randomBytes: n => Buffer.alloc(n, 65) }), /fell back to CPU/);
});
