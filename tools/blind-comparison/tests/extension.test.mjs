import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCase } from '../protocol.mjs';
import { semanticCheck } from '../grading.mjs';

test('external providers register arbitrary natural/formal language cells without changing the semantic or native grader', () => {
  for (const language of ['ga', 'ar', 'additional-formal-language']) {
    const base = { id: `opaque.${language}`, category: 'external-task', language, grading: 'semantic', public: { outputContract: 'Return exact declared JSON or abstain.',
      steps: [{ prompt: 'A public source-owned task.', sources: [{ id: 'public.fixture', text: 'Public source packet.' }], files: {} }] }, private: { kind: 'semantic', expected: [{ value: null, supported: false }] } };
    const plan = { cells: [{ category: base.category, language, grading: 'semantic', count: 2 }, { category: base.category, language, grading: 'native', count: 2 }], budgets: { maxSteps: 2 } };
    assert.doesNotThrow(() => validateCase(base, plan));
    assert.equal(semanticCheck(base.private.expected, [{ response: { answer: '{"value":null,"supported":false}' } }]).pass, true);
    assert.equal(semanticCheck(base.private.expected, [{ response: { answer: '{"value":"guess","supported":true}' } }]).pass, false);
    assert.doesNotThrow(() => validateCase({ ...base, grading: 'native', private: { kind: 'native', argv: [process.execPath, 'heldout.mjs'], files: [{ path: '/custodian/heldout.mjs', target: 'heldout.mjs' }] } }, plan));
  }
});
