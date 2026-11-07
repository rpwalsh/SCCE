// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildToolChoiceSchema, parseToolChoice } from '../tool-choice-protocol.mjs';

const tools = [
  { name: 'repo_read', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'repo_edit', inputSchema: { type: 'object', properties: { path: { type: 'string' }, expectedSha256: { type: 'string' } }, required: ['path', 'expectedSha256'] } }
];

test('oneOf branches preserve each exact MCP advertised input schema', () => {
  const schema = buildToolChoiceSchema(tools);
  assert.equal(schema.type, 'object');
  assert.equal(schema.oneOf.length, tools.length);
  assert.deepEqual(schema.oneOf[0].properties, { tool: { type: 'string', enum: ['repo_read'] }, arguments: tools[0].inputSchema });
  assert.deepEqual(schema.oneOf[1].properties.arguments, tools[1].inputSchema);
  assert.deepEqual(schema.oneOf.map((branch) => branch.required), [['tool', 'arguments'], ['tool', 'arguments']]);
  assert.ok(schema.oneOf.every((branch) => branch.additionalProperties === false));
});

test('accepts a JSON envelope for an advertised tool without shadow-validating its MCP arguments', () => {
  assert.deepEqual(parseToolChoice('{"tool":"repo_read","arguments":{}}', tools), { tool: 'repo_read', arguments: {} });
});

test('rejects prose, malformed JSON, missing arguments, extra envelope fields, and unadvertised tools', () => {
  for (const value of ['I will read the file now.', '{not-json}', '{"tool":"repo_read"}', '{"tool":"repo_read","arguments":{},"note":"done"}', '{"tool":"test_run","arguments":{}}']) {
    assert.throws(() => parseToolChoice(value, tools));
  }
});

test('rejects duplicate advertised names and empty tool inventories', () => {
  assert.throws(() => buildToolChoiceSchema([]), /advertised no tools/u);
  assert.throws(() => buildToolChoiceSchema([tools[0], tools[0]]), /duplicate tool/u);
});
