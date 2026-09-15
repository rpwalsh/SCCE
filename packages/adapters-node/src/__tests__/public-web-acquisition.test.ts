// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { lookup } from "node:dns/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfiguredConnectorAdapter } from "../connectors.js";
import { ConnectorPolicyGate } from "../connector-policy.js";
import { connectorConfigForRuntime } from "../connector-governance-bridge.js";
import { automaticWebAcquisitionEnabled, publicWebNetworkEnabled, validateConfig, type ScceRuntimeConfig } from "../config.js";
import { createApprovalSession } from "../approval-session.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

function config(accessScope?: "allowlist" | "public-internet"): ScceRuntimeConfig {
  return {
    server: { url: "http://127.0.0.1:3873" }, database: { url: "postgresql://localhost/scce", schema: "scce" },
    runtime: { workspaceRoot: ".", tempRoot: ".tmp", allowedRoots: ["."], excludedPaths: [], maxFileBytes: 10000, maxChunkBytes: 1000, tools: {} },
    security: {
      informationAccess: { tenantId: "fixture", principalId: "owner", compartments: ["test"], maximumExportClass: "restricted" },
      defaultSourceInformationLabel: { tenantId: "fixture", principals: ["owner"], compartments: ["test"], exportClass: "restricted", mergePolicy: "isolated" }
    },
    connectors: { web: { enabled: true, accessScope, allowedHosts: ["html.duckduckgo.com", "en.wikipedia.org"], maxBytes: 10000, requestsPerMinute: 30, maxRequestsPerTurn: 12, search: { provider: "duckduckgo" } } },
    policy: { allowMutation: false, requireTwoPhaseCommit: true, dryRunByDefault: true, maxNetworkRequests: 12, maxToolCalls: 24, maxSpendCents: 0, alphaRiskCeiling: 0.55, encryptSecretsAtRest: false }
  };
}

beforeEach(() => {
  vi.stubEnv("SCCE_ALLOW_AUTOMATIC_WEB", "1");
  vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("source bytes", { headers: { "content-type": "text/plain" } })));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("configured public internet acquisition", () => {
  it("refuses public web access before DNS or fetch when the deployment opt-in is absent", async () => {
    vi.unstubAllEnvs();
    const cfg = config("public-internet");
    expect(publicWebNetworkEnabled(cfg)).toBe(false);
    await expect(new ConfiguredConnectorAdapter(cfg).fetch("https://source.example/article")).rejects.toThrow(/public web access refused/iu);
    await expect(new ConfiguredConnectorAdapter(cfg).search("source observation", 4)).rejects.toThrow(/public web access refused/iu);
    expect(lookup).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the allowlist default and requires an explicit public-internet opt-in", async () => {
    await expect(new ConfiguredConnectorAdapter(config()).fetch("https://source.example/article")).rejects.toThrow(/not allowlisted/);
    expect(fetch).not.toHaveBeenCalled();
    const fetched = await new ConfiguredConnectorAdapter(config("public-internet")).fetch("https://source.example/article");
    expect(fetched.uri).toBe("https://source.example/article");
    expect(new TextDecoder().decode(fetched.bytes)).toBe("source bytes");
  });

  it("uses the unchanged owner query in public mode and retains site scoping in allowlist mode", async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response('<a class="result__a" href="https://source.example/a">A source</a>'));
    for (const scope of ["public-internet", "allowlist"] as const) {
      await new ConfiguredConnectorAdapter(config(scope)).search("광합성 관측", 12);
      const url = new URL(String(vi.mocked(fetch).mock.calls.at(-1)?.[0]));
      expect(url.searchParams.get("q")).toBe(scope === "public-internet" ? "광합성 관측" : "광합성 관측 site:en.wikipedia.org");
    }
  });

  it("preserves the final validated source URI and every observed redirect", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://publisher.example/paper" } }))
      .mockResolvedValueOnce(new Response("original source text", { headers: { "content-type": "text/plain" } }));
    const fetched = await new ConfiguredConnectorAdapter(config("public-internet")).fetch("https://index.example/record");
    expect(fetched.uri).toBe("https://publisher.example/paper");
    expect(fetched.metadata).toMatchObject({
      requestedUri: "https://index.example/record", finalUri: "https://publisher.example/paper",
      redirectChain: ["https://index.example/record", "https://publisher.example/paper"]
    });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("charges redirect hops against the same turn request budget before following them", async () => {
    const cfg = config("public-internet");
    cfg.connectors.web!.maxRequestsPerTurn = 1;
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://publisher.example/paper" } }));
    const adapter = new ConfiguredConnectorAdapter(cfg);
    await expect(adapter.withRequestBudget(() => adapter.fetch("https://index.example/record"))).rejects.toThrow(/quota exhausted/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects private DNS addresses and private redirect targets before a request reaches them", async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "192.168.1.8", family: 4 }] as never);
    await expect(new ConfiguredConnectorAdapter(config("public-internet")).fetch("https://source.example/a")).rejects.toThrow(/private\/reserved/);
    expect(fetch).not.toHaveBeenCalled();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "http://[::ffff:7f00:1]/private" } }));
    await expect(new ConfiguredConnectorAdapter(config("public-internet")).fetch("https://source.example/a")).rejects.toThrow(/private\/reserved/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("validates access scope and resource bounds without requiring a paid search key", () => {
    expect(() => validateConfig(config("public-internet"))).not.toThrow();
    for (const [field, value] of [["accessScope", "everything"], ["runtimeAcquisition", true], ["requestsPerMinute", 0], ["requestsPerMinute", 61], ["requestsPerMinute", 121], ["maxRequestsPerTurn", 0], ["maxRequestsPerTurn", 65]] as const) {
      const invalid = config("public-internet");
      Object.assign(invalid.connectors.web!, { [field]: value });
      expect(() => validateConfig(invalid)).toThrow(field);
    }
    const mapped = connectorConfigForRuntime(config("public-internet"), "web", config().policy);
    expect(mapped.limits.requestsPerSession).toBe(12);
    expect(mapped.limits.requestsPerMinute).toBe(30);
  });

  it("does not forward search-provider credentials to a different redirect origin", async () => {
    const cfg = config("public-internet");
    cfg.connectors.web!.search = { provider: "brave", apiKey: "fixture-search-key" };
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://other.example/search" } }));
    await expect(new ConfiguredConnectorAdapter(cfg).search("observations", 4)).rejects.toThrow(/cannot forward connector credentials/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("cancels an in-flight source request through the existing turn signal", async () => {
    let started!: () => void;
    const observed = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(fetch).mockImplementation(async (_url, options) => new Promise<Response>((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
      started();
    }));
    const controller = new AbortController();
    const adapter = new ConfiguredConnectorAdapter(config("public-internet"));
    const work = adapter.withRequestBudget(() => adapter.fetch("https://source.example/a"), controller.signal);
    const failure = expect(work).rejects.toThrow("cancelled");
    await observed;
    controller.abort(new Error("cancelled"));
    await failure;
  });

  it("uses public export endpoints without cookies and preserves the fetched bytes and export lineage", async () => {
    const raw = Buffer.from("Measured values\r\n\u03b1 = 42\r\n", "utf8");
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://doc-export.googleusercontent.com/exported.txt" } }))
      .mockResolvedValueOnce(new Response(raw, { headers: { "content-type": "text/plain; charset=utf-8" } }));
    const uri = "https://docs.google.com/document/d/fixture_public_document/edit?usp=sharing";
    const fetched = await new ConfiguredConnectorAdapter(config("public-internet")).fetch(uri);
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toBe("https://docs.google.com/document/d/fixture_public_document/export?format=txt");
    expect(Buffer.from(fetched.bytes)).toEqual(raw);
    expect(fetched.evidenceDerivative?.text).toBe("Measured values\n\u03b1 = 42\n");
    expect(fetched.metadata).toMatchObject({ requestedUri: uri, finalUri: "https://doc-export.googleusercontent.com/exported.txt", publicExport: { provider: "google-workspace-public-export", format: "text" } });
    for (const [, init] of vi.mocked(fetch).mock.calls) {
      expect(new Headers(init?.headers).has("cookie")).toBe(false);
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
    }
  });

  it("rejects Google export login/error HTML and unsupported binary without returning evidence", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("<!doctype html><html>Sign in</html>", { headers: { "content-type": "text/html" } }));
    await expect(new ConfiguredConnectorAdapter(config("public-internet")).fetch("https://docs.google.com/document/d/fixture_private_document/edit")).rejects.toThrow(/authentication or unsupported export/);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(new Uint8Array([0, 255, 0, 99]), { headers: { "content-type": "application/octet-stream" } }));
    await expect(new ConfiguredConnectorAdapter(config("public-internet")).fetch("https://source.example/binary")).rejects.toThrow(/unsupported fetched source/);
  });

  it("shares one request gate across adapters in the same process and config", async () => {
    const cfg = config("public-internet");
    cfg.policy.maxNetworkRequests = 1;
    cfg.connectors.web!.maxRequestsPerTurn = 1;
    const first = new ConfiguredConnectorAdapter(cfg);
    const second = new ConfiguredConnectorAdapter(cfg);
    await first.fetch("https://source.example/first");
    expect(second.quota.usedNetworkRequests).toBe(1);
    await expect(second.fetch("https://source.example/second")).rejects.toThrow(/quota exhausted/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("scoped standing runtime search consent", () => {
  it("defaults to consent required and grants only network.search when explicitly enabled", () => {
    const cfg = config("public-internet");
    const search = { capabilityId: "network.search", input: { query: "source observation" } };
    expect(createApprovalSession(cfg).isApproved(search)).toBe(false);
    cfg.connectors.web!.runtimeAcquisition = "automatic";
    vi.stubEnv("SCCE_ALLOW_AUTOMATIC_WEB", "1");
    expect(() => validateConfig(cfg)).not.toThrow();
    const approvals = createApprovalSession(cfg);
    expect(approvals.isApproved(search)).toBe(true);
    for (const capabilityId of ["network.fetch", "network.search.extra", "workspace.write", "process.exec", "outlook.send", "telephone.call"]) {
      expect(approvals.isApproved({ capabilityId, input: {} })).toBe(false);
    }
    expect(approvals.policyPatch()).toEqual({});
    expect(approvals.snapshot()).toMatchObject({ operatorGrant: false, runtimeSearchConsent: true, approved: [], pending: [] });
    cfg.connectors.web!.enabled = false;
    expect(createApprovalSession(cfg).isApproved(search)).toBe(false);
    cfg.connectors.web!.enabled = true;
    cfg.connectors.web!.runtimeAcquisition = "consent-required";
    expect(createApprovalSession(cfg).isApproved(search)).toBe(false);
  });

  it("fails closed unless automatic public acquisition has the exact environment opt-in", () => {
    const cfg = config("public-internet");
    cfg.connectors.web!.runtimeAcquisition = "automatic";
    const search = { capabilityId: "network.search", input: { query: "source observation" } };
    for (const value of [undefined, "", "0", "true", "yes", " 1 "]) {
      if (value === undefined) vi.unstubAllEnvs();
      else vi.stubEnv("SCCE_ALLOW_AUTOMATIC_WEB", value);
      expect(automaticWebAcquisitionEnabled(cfg)).toBe(false);
      const approvals = createApprovalSession(cfg);
      expect(approvals.isApproved(search)).toBe(false);
      expect(approvals.isRejected(search)).toBe(true);
      expect(approvals.snapshot()).toMatchObject({ runtimeSearchConsent: false, runtimeSearchRefused: true });
      // The gate, not the owner, refused: the reason names the variable so a trace can never read as an owner decision.
      expect(approvals.disabledReason(search)).toEqual({ reason: "public-network-acquisition-disabled", gate: "SCCE_ALLOW_AUTOMATIC_WEB" });
      expect(approvals.snapshot()).toMatchObject({ runtimeSearchDisabled: { reason: "public-network-acquisition-disabled", gate: "SCCE_ALLOW_AUTOMATIC_WEB" } });
      expect(approvals.disabledReason({ capabilityId: "workspace.write", input: {} })).toBeUndefined();
    }
    vi.stubEnv("SCCE_ALLOW_AUTOMATIC_WEB", "1");
    expect(automaticWebAcquisitionEnabled(cfg)).toBe(true);
    expect(createApprovalSession(cfg).isApproved(search)).toBe(true);
    expect(createApprovalSession(cfg).disabledReason(search)).toBeUndefined();
    expect(createApprovalSession(cfg).snapshot()).toMatchObject({ runtimeSearchConsent: true, runtimeSearchRefused: false });
    expect(createApprovalSession(cfg).snapshot()).not.toHaveProperty("runtimeSearchDisabled");
  });

  it("preserves per-plan approval without widening the policy", () => {
    const approvals = createApprovalSession(config());
    const action = { capabilityId: "workspace.write", input: { path: "fixture.txt" } };
    const request = approvals.requestApproval(action);
    approvals.approve(request.planId);
    expect(approvals.isApproved(action)).toBe(true);
    expect(approvals.isApproved({ ...action, input: { path: "other.txt" } })).toBe(false);
    expect(approvals.policyPatch()).toEqual({});
  });

  it("records a declined search and keeps that exact request offline", () => {
    const approvals = createApprovalSession(config());
    const search = { capabilityId: "network.search", input: { query: "source observation" } };
    const pending = approvals.requestApproval(search);
    approvals.reject(pending.planId);
    expect(approvals.isApproved(search)).toBe(false);
    expect(approvals.isRejected(search)).toBe(true);
    expect(approvals.disabledReason(search)).toBeUndefined();
    expect(approvals.snapshot()).toMatchObject({ pending: [], rejected: [expect.objectContaining({ planId: pending.planId })] });
  });

  it("allows an explicit later approval to override a prior decline for the same plan", () => {
    const approvals = createApprovalSession(config());
    const search = { capabilityId: "network.search", input: { query: "source observation" } };
    const pending = approvals.requestApproval(search);
    approvals.reject(pending.planId);
    approvals.approve(pending.planId);
    expect(approvals.isApproved(search)).toBe(true);
    expect(approvals.isRejected(search)).toBe(false);
    expect(approvals.snapshot()).toMatchObject({ pending: [], rejected: [] });
  });
});

describe("bounded turn-scoped connector requests", () => {
  it("permits two full sequential turns without restoring the old lifetime-12 failure", async () => {
    const adapter = new ConfiguredConnectorAdapter(config("public-internet"));
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    for (let turn = 0; turn < 2; turn++) {
      const work = adapter.withRequestBudget(async () => {
        for (let page = 0; page < 12; page++) await adapter.fetch(`https://source.example/${turn}/${page}`);
        expect(adapter.quota.usedNetworkRequests).toBe(12);
        await expect(adapter.fetch("https://source.example/over-budget")).rejects.toThrow(/quota exhausted/);
      });
      await vi.runAllTimersAsync();
      await work;
    }
    expect(fetch).toHaveBeenCalledTimes(24);
  });

  it("waits for the declared rate and still rejects work over the turn budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const cfg = config("public-internet");
    cfg.connectors.web!.maxRequestsPerTurn = 2;
    const gate = new ConnectorPolicyGate(cfg);
    const completed: number[] = [];
    const work = gate.withRequestBudget(async () => {
      for (let i = 0; i < 2; i++) {
        await gate.beginWhenAvailable({ connector: "web", operation: i === 0 ? "search:duckduckgo" : "fetch", uri: `https://source.example/${i}` });
        completed.push(Date.now());
      }
      await expect(gate.beginWhenAvailable({ connector: "web", operation: "fetch", uri: "https://source.example/extra" })).rejects.toThrow(/quota exhausted/);
    });
    await vi.runAllTimersAsync();
    await work;
    expect(completed).toEqual([1000, 3000]);
  });

  it("uses one conservative shared web bucket when the optional rate is omitted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const cfg = config("public-internet");
    delete cfg.connectors.web!.requestsPerMinute;
    const gate = new ConnectorPolicyGate(cfg);
    const completed: number[] = [];
    const work = gate.withRequestBudget(async () => {
      await gate.beginWhenAvailable({ connector: "web", operation: "search:duckduckgo", uri: "https://source.example/search" });
      completed.push(Date.now());
      await gate.beginWhenAvailable({ connector: "web", operation: "fetch", uri: "https://source.example/article" });
      completed.push(Date.now());
    });
    await vi.runAllTimersAsync();
    await work;
    expect(completed).toEqual([1000, 3000]);
  });

  it("serializes concurrent turn budgets through the shared web bucket", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const gate = new ConnectorPolicyGate(config("public-internet"));
    const completed: Array<[string, number]> = [];
    const first = gate.withRequestBudget(async () => {
      await gate.beginWhenAvailable({ connector: "web", operation: "search:duckduckgo", uri: "https://source.example/first" });
      completed.push(["first", Date.now()]);
    });
    const second = gate.withRequestBudget(async () => {
      await gate.beginWhenAvailable({ connector: "web", operation: "fetch", uri: "https://source.example/second" });
      completed.push(["second", Date.now()]);
    });
    await vi.runAllTimersAsync();
    await Promise.all([first, second]);
    expect(completed).toEqual([["first", 1000], ["second", 3000]]);
  });

  it("can cancel a queued fetch before any additional network request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const gate = new ConnectorPolicyGate(config("public-internet"));
    const controller = new AbortController();
    await gate.beginWhenAvailable({ connector: "web", operation: "fetch", uri: "https://source.example/a" });
    const queued = gate.withRequestBudget(() => gate.beginWhenAvailable({ connector: "web", operation: "fetch", uri: "https://source.example/b" }), controller.signal);
    const expectation = expect(queued).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(new Error("cancelled"));
    await expectation;
  });
});
