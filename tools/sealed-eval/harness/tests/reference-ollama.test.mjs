import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeJson } from "../lib/util.mjs";

async function runBaseline(device, sizeVram) {
  const requests = [];
  const model = { name: "qwen2.5:3b", digest: "test-digest", size_vram: sizeVram, size: 100, context_length: 4096 };
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    let response;
    if (req.url === "/api/version") response = { version: "test-version" };
    else if (req.url === "/api/tags" || req.url === "/api/ps") response = { models: [model] };
    else if (req.url === "/api/generate") {
      requests.push(JSON.parse(text));
      response = { response: "Aster", eval_count: 2, eval_duration: 1e9, load_duration: 3e9, total_duration: 4e9 };
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(response));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const dir = await mkdtemp(path.join(os.tmpdir(), "scce-ollama-test-"));
    const manifest = path.join(dir, "corpus.json");
    await writeJson(manifest, { documents: [] });
    const adapter = fileURLToPath(new URL("../adapters/reference-ollama.mjs", import.meta.url));
    const child = spawn(process.execPath, [adapter, `--corpus-manifest=${manifest}`, `--endpoint=http://127.0.0.1:${server.address().port}`, `--device=${device}`, "--threads=4"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => stdout += data);
    child.stderr.on("data", data => stderr += data);
    child.stdin.end('{"questionId":"q","prompt":"Choose."}\n');
    const [code] = await once(child, "close");
    assert.equal(code, 0, stderr);
    return { answer: JSON.parse(stdout), request: requests[0] };
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test("CPU requests explicitly disable GPU and preserve model, decoding and timing evidence", async () => {
  const { answer, request } = await runBaseline("cpu", 0);
  assert.equal(answer.status, "ok");
  assert.equal(request.options.num_gpu, 0);
  assert.equal(request.options.num_thread, 4);
  assert.equal(request.options.num_ctx, 4096);
  assert.equal(request.keep_alive, "30m");
  assert.equal(answer.metadata.digest, "test-digest");
  assert.equal(answer.metadata.residency.observedDevice, "cpu");
  assert.equal(answer.metadata.inference.eval_count, 2);
});

test("a requested GPU condition cannot silently count CPU fallback as GPU work", async () => {
  const { answer, request } = await runBaseline("gpu", 0);
  assert.equal(request.options.num_gpu, 999);
  assert.equal(answer.status, "error");
  assert.match(answer.metadata.error, /fell back to CPU/);
});
