// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildToolChoiceSchema, parseToolChoice } from './tool-choice-protocol.mjs';

const REPO_ROOT = path.resolve(process.cwd());
const MODEL = 'qwen2.5:3b';
const TOOL_NAMES = ['repo_read', 'repo_edit', 'test_run'];
const MAX_STEPS = 12;
const MODEL_OPTIONS = Object.freeze({ temperature: 0, seed: 20261107, num_ctx: 8192, num_predict: 512 });
const require = createRequire(path.join(REPO_ROOT, 'tools/scce-dev-mcp/package.json'));
const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
const { StdioClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const textOf = (result) => result.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
const tests = "import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {mean} from '../src/stats.mjs';\ntest('mean uses the number of inputs',()=>assert.equal(mean([2,4]),3));\ntest('mean handles negative inputs',()=>assert.equal(mean([-6,2]),-2));\ntest('empty input is an error',()=>assert.throws(()=>mean([]),RangeError));\n";
const original = 'export function mean(values) {\n  if (values.length === 0) return 0;\n  return values.reduce((sum, value) => sum + value, 0) / (values.length + 1);\n}\n';

async function writeReceipt(file, receipt) {
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
}

function childEnvironment(scratchRoot) {
  const allowed = new Set(['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'PATHEXT', 'ComSpec']);
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key)));
  return {
    ...inherited,
    SCCE_REPO_ROOT: scratchRoot,
    SCCE_TEST_HEAP_MB: '256',
    NODE_OPTIONS: '--max-old-space-size=256'
  };
}

export async function runEvaluation() {
  const scratchRoot = path.join(REPO_ROOT, '.tmp', `qwen-mcp-coding-jsonschema-${Date.now()}`);
  const receiptPath = path.join(REPO_ROOT, '.tmp', 'qwen-mcp-coding-jsonschema.json');
  const sourcePath = path.join(scratchRoot, 'src', 'stats.mjs');
  const testsPath = path.join(scratchRoot, 'tests', 'stats.test.mjs');
  const testHash = sha256(tests);
  const receipt = {
    schema: 'scce.local_mcp_jsonschema_coding_evaluation.v1',
    protocol: 'json_schema_mcp_tool_choice',
    modelOptions: MODEL_OPTIONS,
    harnessSha256: sha256(await readFile(new URL(import.meta.url))),
    model: MODEL,
    root: scratchRoot,
    startedAt: new Date().toISOString(),
    steps: [],
    passed: false,
    testsHash: testHash,
    independentHeldOutChecks: null,
    testsPreserved: false
  };
  const client = new Client({ name: 'local-qwen-mcp-jsonschema-evaluation', version: '1.0.0' }, { capabilities: {} });
  let connected = false;
  const started = performance.now();
  try {
    for (const directory of ['src', 'tests', 'packages/kernel/src']) await mkdir(path.join(scratchRoot, directory), { recursive: true });
    await writeFile(path.join(scratchRoot, 'README.md'), 'Isolated local MCP coding evaluation.\n', 'utf8');
    await writeFile(path.join(scratchRoot, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n', 'utf8');
    await writeFile(path.join(scratchRoot, 'packages/kernel/src/kernel.ts'), 'export {};\n', 'utf8');
    await writeFile(path.join(scratchRoot, 'package.json'), JSON.stringify({
      name: 'isolated-mcp-coding-eval', private: true, type: 'module',
      scripts: { 'test:unit': 'node --test tests/stats.test.mjs' }
    }, null, 2), 'utf8');
    await writeFile(sourcePath, original, 'utf8');
    await writeFile(testsPath, tests, 'utf8');
    receipt.initialSourceHash = sha256(original);
    receipt.testFileHash = testHash;
    await writeReceipt(receiptPath, receipt);

    const entry = path.join(REPO_ROOT, 'tools/scce-dev-mcp/dist/index.js');
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      cwd: REPO_ROOT,
      env: childEnvironment(scratchRoot),
      stderr: 'pipe'
    }));
    connected = true;
    const advertised = (await client.listTools()).tools.filter((tool) => TOOL_NAMES.includes(tool.name));
    assert.deepEqual(advertised.map((tool) => tool.name).sort(), [...TOOL_NAMES].sort(), 'MCP must advertise the required native tools');
    receipt.toolSchemas = advertised.map(({ name, inputSchema }) => ({ name, inputSchema }));
    const format = buildToolChoiceSchema(advertised);
    receipt.choiceSchemaHash = sha256(JSON.stringify(format));

    const tagsResponse = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(10_000) });
    const tags = await tagsResponse.json();
    const modelRecord = tags.models?.find((item) => item.name === MODEL);
    assert.ok(modelRecord, `declared reference model ${MODEL} is not available`);
    receipt.modelDigest = modelRecord.digest;

    const promptTools = advertised.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    const messages = [
      { role: 'system', content: 'Work in the isolated repository. Each response must be exactly one JSON object selecting one advertised MCP tool and its arguments. The response schema supplied by the host constrains the available choices. Do not emit prose or claim actions that were not returned by tools. Read the source and tests, fix the implementation without changing tests, then run the unit tests through test_run. The host stops after it receives a passing test_run result.' },
      { role: 'user', content: `Available MCP tools:\n${JSON.stringify(promptTools)}\n\nTask: Fix mean(values) in src/stats.mjs. Nonempty arrays of finite numbers must return their arithmetic mean; an empty array must throw RangeError. Read src/stats.mjs and tests/stats.test.mjs with repo_read first. Edit only src/stats.mjs with repo_edit using the current SHA-256. Then run test_run with commandId "unit". The supplied tests are authoritative and must remain byte-for-byte unchanged.` }
    ];

    for (let index = 0; index < MAX_STEPS; index += 1) {
      const tick = performance.now();
      const response = await fetch('http://127.0.0.1:11434/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          messages,
          format,
          stream: false,
          keep_alive: '2m',
          options: MODEL_OPTIONS
        }),
        signal: AbortSignal.timeout(90_000)
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `Ollama HTTP ${response.status}`);
      const message = body.message;
      assert.ok(message && typeof message.content === 'string', 'Ollama must return a message content string');
      const choice = parseToolChoice(message.content, advertised);
      messages.push({ role: 'assistant', content: message.content });
      const result = await client.callTool({ name: choice.tool, arguments: choice.arguments });
      const content = textOf(result);
      const step = {
        index,
        elapsedMs: Math.round(performance.now() - tick),
        promptTokens: body.prompt_eval_count,
        outputTokens: body.eval_count,
        rawJson: message.content,
        call: choice,
        toolResult: content,
        isError: result.isError === true
      };
      receipt.steps.push(step);
      console.log(JSON.stringify({ step: index, elapsedMs: step.elapsedMs, tool: choice.tool, isError: step.isError }));
      messages.push({ role: 'user', content: `Result from ${choice.tool}:\n${content}` });
      await writeReceipt(receiptPath, receipt);
      if (choice.tool === 'test_run') {
        let parsed;
        try { parsed = JSON.parse(content); }
        catch { parsed = undefined; }
        if (parsed?.ok === true) break;
      }
    }

    const testBytesAfter = await readFile(testsPath);
    assert.equal(sha256(testBytesAfter), testHash, 'the supplied tests must remain byte-for-byte unchanged');
    const source = await readFile(sourcePath, 'utf8');
    assert.notEqual(source, original, 'the implementation must change');
    const loaded = await import(`${pathToFileURL(sourcePath).href}?sha256=${sha256(source)}`);
    for (const [values, expected] of [[[1], 1], [[1.25, 2.75], 2], [[-10, -2, 3], -3], [[0, 0, 0], 0]]) {
      assert.equal(loaded.mean(values), expected);
    }
    assert.throws(() => loaded.mean([]), RangeError);
    const passedRun = receipt.steps.some((step) => {
      if (step.call.tool !== 'test_run') return false;
      try { return JSON.parse(step.toolResult).ok === true; }
      catch { return false; }
    });
    assert.ok(passedRun, 'model must execute passing tests through the MCP test_run tool');
    receipt.testsPreserved = true;
    receipt.independentHeldOutChecks = 5;
    receipt.passed = true;
  } catch (error) {
    receipt.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    if (connected) await client.close();
    await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, keep_alive: 0 }), signal: AbortSignal.timeout(10_000)
    }).catch(error => { receipt.modelUnloadError = String(error.message ?? error); });
    receipt.elapsedMs = Math.round(performance.now() - started);
    await writeReceipt(receiptPath, receipt);
    console.log(JSON.stringify({ passed: receipt.passed, error: receipt.error, elapsedMs: receipt.elapsedMs, steps: receipt.steps.length, receipt: path.relative(REPO_ROOT, receiptPath), root: scratchRoot }));
  }
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runEvaluation();
}
