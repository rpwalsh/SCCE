// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { interpretTurnResponse } from "./absence.mjs";

export async function createScceMeasurementClient({ serverUrl, requestTimeoutMs, configPath, environment = process.env, loadConfig }) {
  let token = environment.SCCE_API_BEARER_TOKEN?.trim();
  if (!token) {
    const adapter = loadConfig ? undefined : await import("../../packages/adapters-node/dist/index.js");
    const config = await (loadConfig ?? adapter.readScceRuntimeConfig)(configPath ?? "scce.config.json");
    const configured = config.security?.apiBearerToken;
    token = configured?.startsWith("enc:v1:")
      ? (adapter ?? await import("../../packages/adapters-node/dist/index.js")).resolveSecret(configured, config, "SCCE API bearer token")
      : configured;
  }
  const headers = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const base = new URL(serverUrl);
  if (base.username || base.password) throw new Error("SCCE measurement URL must not contain credentials");
  return {
    async ready() {
      const response = await fetch(new URL("/api/ready", base), { headers, signal: AbortSignal.timeout(requestTimeoutMs) });
      if (!response.ok) throw new Error(`SCCE readiness returned HTTP ${response.status}`);
      return response.json();
    },
    async ask(prompt) {
      try {
        const response = await fetch(new URL("/api/turn", base), {
          method: "POST", headers, signal: AbortSignal.timeout(requestTimeoutMs), body: JSON.stringify({ text: prompt })
        });
        const payload = await response.json().catch(() => null);
        const read = interpretTurnResponse({ status: response.status, payload, ms: 0 });
        return { answer: read.answer, evidence: read.evidence, runtimeDeclined: read.declinedByRuntime,
          httpStatus: read.httpStatus, transportError: read.error };
      } catch {
        return { answer: "", evidence: null, runtimeDeclined: false, httpStatus: null, transportError: "SCCE measurement request failed" };
      }
    }
  };
}
