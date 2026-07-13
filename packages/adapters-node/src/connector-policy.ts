import type { JsonValue, PolicyProfile } from "@scce/kernel";
import type { ScceRuntimeConfig } from "./config.js";

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
}

export interface ConnectorQuotaSnapshot {
  maxNetworkRequests: number;
  usedNetworkRequests: number;
  remainingNetworkRequests: number;
  records: ConnectorRequestRecord[];
}

export class ConnectorPolicyGate {
  private sequence = 0;
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
      startedAt: Date.now()
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

  private allowed(connector: ConnectorRequestRecord["connector"], uri: string, mutates: boolean, approved: boolean): { ok: boolean; reason: string } {
    const policy = { ...this.config.policy, ...this.policyPatch() };
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
