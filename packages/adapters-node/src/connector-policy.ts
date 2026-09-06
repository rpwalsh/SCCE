// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { JsonValue, PolicyProfile } from "@scce/kernel";
import type { ScceRuntimeConfig } from "./config.js";
import { admitConnectorCall } from "./connector-governance-bridge.js";

/**
 * This is the live enforcement gate: `ConfiguredConnectorAdapter`
 * (`connectors.ts`) calls `begin()`/`finish()`/`fail()` on every real
 * Outlook/YouTube/Telephone/web connector call, so the rules in `allowed()`
 * below are what protects production traffic.
 *
 * There is now one enforcement point and one audit trail. The kernel's
 * `connector-governance.ts` model (risk scoring, approval tickets, rate and
 * spend quotas) used to be implemented and consulted by nothing, so a reader
 * could harden it and believe production had changed. `allowed()` now
 * consults it through `connector-governance-bridge.ts` and admits a call only
 * when both models admit it: the allowlist and mutation rules here, and the
 * kernel's risk/approval/quota rules there, over the operator's own limits.
 * The conjunction is deliberate -- this bridge can only deny, never widen --
 * and the kernel's decision is recorded on the same request record.
 */

/** What the kernel's admission model decided about this call, recorded beside the local decision. */
export interface ConnectorGovernanceDecision {
  allowed: boolean;
  mode: string;
  risk: number;
  reasons: string[];
  approvalTicketId?: string;
}

export interface ConnectorRequestRecord {
  id: string;
  connector: "web" | "outlook" | "youtube" | "telephone";
  operation: string;
  uri: string;
  mutates: boolean;
  allowed: boolean;
  reason: string;
  startedAt: number;
  completedAt?: number;
  status?: number;
  bytes?: number;
  metadata?: JsonValue;
  governance?: ConnectorGovernanceDecision;
}

export interface ConnectorQuotaSnapshot {
  maxNetworkRequests: number;
  usedNetworkRequests: number;
  remainingNetworkRequests: number;
  records: ConnectorRequestRecord[];
}

export class ConnectorPolicyGate {
  private sequence = 0;
  private lastAllowedAt: number | undefined;
  private readonly sessionId = `connector_session_${Date.now().toString(36)}`;
  private readonly records: ConnectorRequestRecord[] = [];

  constructor(private readonly config: ScceRuntimeConfig, private readonly policyPatch: () => Partial<PolicyProfile> = () => ({})) {}

  begin(input: { connector: ConnectorRequestRecord["connector"]; operation: string; uri: string; mutates?: boolean; approved?: boolean }): ConnectorRequestRecord {
    const uri = normalizeUri(input.uri);
    const mutates = Boolean(input.mutates);
    const allowed = this.allowed(input.connector, uri, mutates, Boolean(input.approved));
    const record: ConnectorRequestRecord = {
      id: `connector_${Date.now().toString(36)}_${(this.sequence++).toString(36).padStart(4, "0")}`,
      connector: input.connector,
      operation: input.operation,
      uri: redactUri(uri),
      mutates,
      allowed: allowed.ok,
      reason: allowed.reason,
      startedAt: Date.now(),
      ...(allowed.governance ? { governance: allowed.governance } : {})
    };
    this.records.push(record);
    if (!allowed.ok) throw new Error(`connector policy denied ${input.connector}:${input.operation}: ${allowed.reason}`);
    return record;
  }

  finish(record: ConnectorRequestRecord, result: { status?: number; bytes?: number; metadata?: JsonValue }): void {
    record.completedAt = Date.now();
    record.status = result.status;
    record.bytes = result.bytes;
    record.metadata = result.metadata;
  }

  fail(record: ConnectorRequestRecord, error: unknown): void {
    record.completedAt = Date.now();
    record.metadata = { error: error instanceof Error ? error.message : String(error) };
  }

  snapshot(): ConnectorQuotaSnapshot {
    const max = { ...this.config.policy, ...this.policyPatch() }.maxNetworkRequests;
    const used = this.records.filter(record => record.allowed).length;
    return {
      maxNetworkRequests: max,
      usedNetworkRequests: used,
      remainingNetworkRequests: Math.max(0, max - used),
      records: this.records.slice(-200)
    };
  }

  private allowed(
    connector: ConnectorRequestRecord["connector"],
    uri: string,
    mutates: boolean,
    approved: boolean
  ): { ok: boolean; reason: string; governance?: ConnectorGovernanceDecision } {
    const policy = { ...this.config.policy, ...this.policyPatch() };
    const local = this.locallyAllowed(connector, uri, mutates, approved, policy);
    // The kernel's admission model runs on every call, including one the local rules already denied, so the audit
    // record always says what both models decided rather than only the first one to object.
    const admission = admitConnectorCall({
      config: this.config,
      policy,
      connector,
      mutates,
      approved,
      sessionId: this.sessionId,
      requestsUsed: this.records.filter(record => record.allowed).length,
      ...(this.lastAllowedAt === undefined ? {} : { lastRequestAt: this.lastAllowedAt })
    });
    const governance: ConnectorGovernanceDecision = {
      allowed: admission.allowed,
      mode: admission.mode,
      risk: admission.risk,
      reasons: admission.reasons.slice(0, 4),
      ...(admission.approvalTicket ? { approvalTicketId: admission.approvalTicket.id } : {})
    };
    if (!local.ok) return { ...local, governance };
    if (!admission.allowed) {
      return { ok: false, reason: `connector governance ${admission.mode}: ${admission.reasons[0] ?? "not admitted"}`, governance };
    }
    this.lastAllowedAt = Date.now();
    return { ...local, governance };
  }

  private locallyAllowed(
    connector: ConnectorRequestRecord["connector"],
    uri: string,
    mutates: boolean,
    approved: boolean,
    policy: PolicyProfile
  ): { ok: boolean; reason: string } {
    if (this.records.filter(record => record.allowed).length >= policy.maxNetworkRequests) return { ok: false, reason: "network request quota exhausted" };
    const connectorAllowed = this.connectorAllowed(connector, uri);
    if (!connectorAllowed.ok) return connectorAllowed;
    if (mutates && approved) return { ok: true, reason: "operator-approved" };
    if (mutates && (!policy.allowMutation || policy.dryRunByDefault)) return { ok: false, reason: "mutating connector call is blocked by policy" };
    return connectorAllowed;
  }

  private connectorAllowed(connector: ConnectorRequestRecord["connector"], uri: string): { ok: boolean; reason: string } {
    if (connector === "web") return this.allowedWeb(uri);
    if (connector === "outlook") return this.config.connectors.outlook?.enabled ? { ok: true, reason: "outlook enabled" } : { ok: false, reason: "outlook disabled" };
    if (connector === "youtube") return this.config.connectors.youtube?.enabled ? { ok: true, reason: "youtube enabled" } : { ok: false, reason: "youtube disabled" };
    if (connector === "telephone") return this.config.connectors.telephone?.enabled ? { ok: true, reason: "telephone enabled" } : { ok: false, reason: "telephone disabled" };
    return { ok: false, reason: "unknown connector" };
  }

  private allowedWeb(uri: string): { ok: boolean; reason: string } {
    const web = this.config.connectors.web;
    if (!web?.enabled) return { ok: false, reason: "web connector disabled" };
    const url = new URL(uri);
    if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: `unsupported protocol ${url.protocol}` };
    if (unsafeLocalHostname(url.hostname)) return { ok: false, reason: `blocked local/private host: ${url.hostname}` };
    if (!hostAllowlisted(url.hostname, web.allowedHosts)) return { ok: false, reason: `host not allowlisted: ${url.hostname}` };
    return { ok: true, reason: "web allowlist matched" };
  }
}

export function hostAllowlisted(hostname: string, allowedHosts: readonly string[]): boolean {
  const host = hostname.toLocaleLowerCase();
  for (const allowed of allowedHosts.map(item => item.toLocaleLowerCase())) {
    if (!allowed || allowed === "*") continue;
    if (allowed.startsWith("*.")) {
      const suffix = allowed.slice(1);
      if (host.endsWith(suffix) && host.length > suffix.length) return true;
      continue;
    }
    if (host === allowed) return true;
  }
  return false;
}

export function unsafeLocalHostname(hostname: string): boolean {
  const host = hostname.trim().toLocaleLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost"
    || host.endsWith(".localhost")
    || host === "0.0.0.0"
    || host === "::"
    || host === "::1"
    || host.startsWith("127.")
    || host.startsWith("169.254.");
}

export function normalizeUri(uri: string): string {
  const parsed = new URL(uri);
  parsed.hash = "";
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

export function redactUri(uri: string): string {
  try {
    const parsed = new URL(uri);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/token|key|secret|password|sig|signature|auth/i.test(key)) parsed.searchParams.set(key, "[REDACTED]");
    }
    return parsed.toString();
  } catch {
    return uri.replace(/(token|key|secret|password)=([^&\s]+)/gi, "$1=[REDACTED]");
  }
}

export function redactHeaders(headers: Headers): JsonValue {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = /authorization|cookie|token|key/i.test(key) ? "[REDACTED]" : value;
  });
  return out;
}
