// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createScceMeasurementClient } from "./scce-client.mjs";

test("measures the authenticated runtime without serializing its credential", async t => {
  const requests = [];
  const server = createServer(async (request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    if (request.headers.authorization !== "Bearer private-fixture") {
      response.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/ready") response.end(JSON.stringify({ warmup: { complete: true } }));
    else {
      let body = "";
      for await (const chunk of request) body += chunk;
      assert.equal(JSON.parse(body).text, "誰ですか？");
      response.end(JSON.stringify({ answer: "測定済み" }));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = await createScceMeasurementClient({ serverUrl: `http://127.0.0.1:${server.address().port}`,
    requestTimeoutMs: 2000, environment: {}, loadConfig: async () => ({ security: { apiBearerToken: "private-fixture" } }) });
  assert.equal((await client.ready()).warmup.complete, true);
  const result = await client.ask("誰ですか？");
  assert.equal(result.httpStatus, 200);
  assert.equal(result.answer, "測定済み");
  assert.equal(requests.length, 2);
  assert.ok(requests.every(row => row.authorization === "Bearer private-fixture"));
  assert.ok(!JSON.stringify({ client, result }).includes("private-fixture"));
});

test("environment authentication avoids reading a config and rejects unauthorized readiness", async t => {
  const server = createServer((_request, response) => response.writeHead(401).end("{}"));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = await createScceMeasurementClient({ serverUrl: `http://127.0.0.1:${server.address().port}`,
    requestTimeoutMs: 2000, environment: { SCCE_API_BEARER_TOKEN: "env-fixture" },
    loadConfig: async () => { throw new Error("must not load config"); } });
  await assert.rejects(client.ready(), /HTTP 401/u);
  assert.equal((await client.ask("test")).httpStatus, 401);
});
