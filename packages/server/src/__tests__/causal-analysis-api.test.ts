import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { CAUSAL_ANALYSIS_REQUEST_SCHEMA, type CausalAnalysisRequest, type CausalAnalysisResult, type EpisodeId } from "@scce/kernel";
import { handleRequest, type ApiContext } from "../routes.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

function validObservations() {
  return [
    { id: "z0-c1", values: { "variable.t": 0, "variable.y": 0, "variable.z": 0 }, evidenceIds: ["evidence.z0-c1"] },
    { id: "z0-c2", values: { "variable.t": 0, "variable.y": 0, "variable.z": 0 }, evidenceIds: ["evidence.z0-c2"] },
    { id: "z0-t1", values: { "variable.t": 1, "variable.y": 2, "variable.z": 0 }, evidenceIds: ["evidence.z0-t1"] },
    { id: "z0-t2", values: { "variable.t": 1, "variable.y": 2, "variable.z": 0 }, evidenceIds: ["evidence.z0-t2"] },
    { id: "z1-c1", values: { "variable.t": 0, "variable.y": 10, "variable.z": 1 }, evidenceIds: ["evidence.z1-c1"] },
    { id: "z1-c2", values: { "variable.t": 0, "variable.y": 10, "variable.z": 1 }, evidenceIds: ["evidence.z1-c2"] },
    { id: "z1-t1", values: { "variable.t": 1, "variable.y": 12, "variable.z": 1 }, evidenceIds: ["evidence.z1-t1"] },
    { id: "z1-t2", values: { "variable.t": 1, "variable.y": 12, "variable.z": 1 }, evidenceIds: ["evidence.z1-t2"] }
  ];
}

function validBackdoorDesign() {
  return {
    kind: "backdoor_adjustment",
    treatment: "variable.t",
    outcome: "variable.y",
    adjustmentSet: ["variable.z"],
    dag: {
      assumptionSetId: "assumptions.1",
      nodes: ["variable.t", "variable.y", "variable.z"],
      edges: [
        { id: "z-t", cause: "variable.z", effect: "variable.t", evidenceIds: ["evidence.z-t"] },
        { id: "z-y", cause: "variable.z", effect: "variable.y", evidenceIds: ["evidence.z-y"] },
        { id: "t-y", cause: "variable.t", effect: "variable.y", evidenceIds: ["evidence.t-y"] }
      ],
      evidenceIds: ["evidence.dag"]
    },
    assumptions: {
      consistency: true,
      noInterference: true,
      noUnmeasuredConfoundingGivenAdjustment: true,
      temporalOrderEstablished: true,
      positivityExpected: true
    }
  };
}

describe("POST /api/causal/analyze", () => {
  it("rejects a request missing the schema tag before reaching the kernel", async () => {
    const url = await startFixture();
    const response = await post(url, { observations: validObservations(), targetRiskCoverage: 0.8 });
    expect(response.status).toBe(400);
    expect(String(response.body.error)).toMatch(/schema/);
  });

  it("rejects a design that does not explicitly assert every assumption as true", async () => {
    const url = await startFixture();
    const design = validBackdoorDesign();
    (design.assumptions as Record<string, unknown>).positivityExpected = false;
    const response = await post(url, {
      schema: CAUSAL_ANALYSIS_REQUEST_SCHEMA,
      observations: validObservations(),
      design,
      targetRiskCoverage: 0.8
    });
    expect(response.status).toBe(400);
    expect(String(response.body.error)).toMatch(/positivityExpected must be explicitly asserted as true/);
  });

  it("passes a well-typed request through to the kernel and returns its real result", async () => {
    let received: CausalAnalysisRequest | undefined;
    const url = await startFixture(async request => {
      received = request;
      return { episodeId: "episode.causal.fixture" as EpisodeId, eventId: "event.causal.fixture", status: "identified", estimate: { status: "identified" } as never };
    });
    const response = await post(url, {
      schema: CAUSAL_ANALYSIS_REQUEST_SCHEMA,
      observations: validObservations(),
      design: validBackdoorDesign(),
      targetRiskCoverage: 0.8
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ episodeId: "episode.causal.fixture", status: "identified" });
    expect(received?.observations).toHaveLength(8);
    expect(received?.design).toMatchObject({ kind: "backdoor_adjustment", adjustmentSet: ["variable.z"] });
  });
});

async function startFixture(
  analyzeCausalEffect: (request: CausalAnalysisRequest) => Promise<CausalAnalysisResult> = async () => {
    throw new Error("fixture did not expect analyzeCausalEffect to be called");
  }
): Promise<string> {
  const context = {
    runtime: { kernel: { analyzeCausalEffect } },
    config: { server: { url: "http://127.0.0.1:0" } },
    startupReadiness: { snapshot: () => ({ phase: "ready" as const, complete: true }) }
  } as unknown as ApiContext;
  const server = createServer((request, response) => {
    void handleRequest(request, response, context);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server has no TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function post(url: string, payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${url}/api/causal/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
