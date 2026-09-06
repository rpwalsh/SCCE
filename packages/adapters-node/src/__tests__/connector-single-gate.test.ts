// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { ConnectorPolicyGate } from "../connector-policy.js";
import { admitConnectorCall, connectorConfigForRuntime } from "../connector-governance-bridge.js";
import type { ScceRuntimeConfig } from "../config.js";

function runtimeConfig(over: Partial<ScceRuntimeConfig["policy"]> = {}, connectors: Partial<ScceRuntimeConfig["connectors"]> = {}): ScceRuntimeConfig {
  return {
    policy: {
      allowMutation: true,
      requireTwoPhaseCommit: false,
      dryRunByDefault: false,
      maxNetworkRequests: 8,
      maxToolCalls: 8,
      maxSpendCents: 100,
      alphaRiskCeiling: 0.9,
      encryptSecretsAtRest: false,
      ...over
    },
    connectors: {
      web: { enabled: true, allowedHosts: ["example.com"], maxBytes: 1_000_000 },
      ...connectors
    }
  } as unknown as ScceRuntimeConfig;
}

describe("one connector gate, both models consulted", () => {
  it("records the kernel's admission decision on the same audit record as the local one", () => {
    const gate = new ConnectorPolicyGate(runtimeConfig());
    const record = gate.begin({ connector: "web", operation: "fetch", uri: "https://example.com/a" });

    expect(record.allowed).toBe(true);
    expect(record.governance?.allowed).toBe(true);
    expect(record.governance?.mode).toBe("allow");
    expect(record.governance?.risk).toBeGreaterThanOrEqual(0);
  });

  it("still denies what the allowlist denied, and says both models' verdicts", () => {
    const gate = new ConnectorPolicyGate(runtimeConfig());

    expect(() => gate.begin({ connector: "web", operation: "fetch", uri: "https://elsewhere.example.net/a" }))
      .toThrow(/host not allowlisted/);
    const [record] = gate.snapshot().records;
    expect(record?.allowed).toBe(false);
    // The kernel model ran anyway, so the audit record is not silent about what it thought.
    expect(record?.governance).toBeDefined();
  });

  it("denies a call the kernel model refuses even when the allowlist would permit it", () => {
    // A risk ceiling of zero admits nothing; the local allowlist alone would have allowed this fetch.
    const gate = new ConnectorPolicyGate(runtimeConfig({ alphaRiskCeiling: 0 }));

    expect(() => gate.begin({ connector: "web", operation: "fetch", uri: "https://example.com/a" }))
      .toThrow(/connector governance/);
    const [record] = gate.snapshot().records;
    expect(record?.allowed).toBe(false);
    expect(record?.governance?.allowed).toBe(false);
  });

  it("maps the operator's own limits into the kernel's config rather than inventing its own", () => {
    const config = runtimeConfig({ maxNetworkRequests: 3, maxSpendCents: 25 });
    const mapped = connectorConfigForRuntime(config, "web", { ...config.policy });

    expect(mapped.enabled).toBe(true);
    expect(mapped.limits.requestsPerSession).toBe(3);
    expect(mapped.limits.maxSpendCents).toBe(25);
    expect(mapped.limits.maxBytesPerResponse).toBe(1_000_000);
    // A mutation needs approval; a read does not. That mirrors the live gate rather than tightening it.
    expect(mapped.approval.requiredForCommit).toBe(true);
    expect(mapped.approval.requiredForRead).toBe(false);
  });

  it("refuses a disabled connector through the kernel model too", () => {
    const config = runtimeConfig({}, { web: { enabled: false, allowedHosts: ["example.com"], maxBytes: 1_000 } });
    const admission = admitConnectorCall({
      config,
      policy: { ...config.policy },
      connector: "web",
      mutates: false,
      approved: false,
      sessionId: "session.fixture",
      requestsUsed: 0
    });

    expect(admission.allowed).toBe(false);
    expect(admission.mode).toBe("disabled");
  });
});
