// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvidenceDerivative } from "@scce/kernel";
import { handleRequest, type ApiContext } from "../routes.js";

const raw = Buffer.from("%PDF-1.7\noriginal binary source");
const text = "source-derived text ".repeat(100000);

function fetchedFixture() {
  const derivative: EvidenceDerivative = {
    bytes: Buffer.from(text), text, kind: "extracted-text", transformId: "scce.fetched-source-text.v1",
    originalCoordinateSpace: "extracted-text-utf8", redactionMap: []
  };
  return { uri: "https://publisher.example/source.pdf", mediaType: "application/pdf", bytes: raw, evidenceDerivative: derivative, metadata: { normalization: { originalMediaType: "application/pdf" }, largeStructuredData: "x".repeat(100000) } };
}

async function postFetch(fetched: ReturnType<typeof fetchedFixture>): Promise<Response> {
  const context = {
    runtime: { connectors: { fetch: async () => fetched } },
    config: { server: { url: "http://127.0.0.1:0" }, security: {} }
  } as unknown as ApiContext;
  const server = createServer((request, response) => { void handleRequest(request, response, context); });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server has no TCP address");
    return await fetch(`http://127.0.0.1:${address.port}/api/connectors/fetch`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uri: fetched.uri })
    });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

describe("connector fetch inspection response", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("refuses the route entirely while the public network acquisition gate is unset", async () => {
    vi.stubEnv("SCCE_ALLOW_AUTOMATIC_WEB", undefined);
    const response = await postFetch(fetchedFixture());
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("SCCE_ALLOW_AUTOMATIC_WEB");
  });

  it("bounds source/derivative previews and metadata without serializing full text or changing ingest bytes", async () => {
    vi.stubEnv("SCCE_ALLOW_AUTOMATIC_WEB", "1");
    const fetched = fetchedFixture();
    const derivative = fetched.evidenceDerivative;
    const response = await postFetch(fetched);
    expect(response.status).toBe(200);
    const encoded = await response.text();
    expect(Buffer.byteLength(encoded)).toBeLessThan(16000);
    const body = JSON.parse(encoded);
    expect(body.uri).toBe(fetched.uri);
    expect(body.bytes).toMatchObject({ byteLength: raw.length, sha256: createHash("sha256").update(raw).digest("hex") });
    expect(body.evidenceDerivative).toMatchObject({
      byteLength: derivative.bytes.length, sha256: createHash("sha256").update(derivative.bytes).digest("hex"),
      kind: "extracted-text", transformId: derivative.transformId, originalCoordinateSpace: "extracted-text-utf8", redactionIntervalCount: 0
    });
    expect(body.evidenceDerivative.previewUtf8).toHaveLength(4096);
    expect(body.evidenceDerivative).not.toHaveProperty("text");
    expect(body.evidenceDerivative).not.toHaveProperty("bytes");
    expect(body.metadata).toMatchObject({ truncated: true });
    expect(fetched.bytes).toBe(raw);
    expect(fetched.evidenceDerivative.text).toBe(text);
    expect(fetched.evidenceDerivative.bytes.length).toBe(Buffer.byteLength(text));
  });
});
