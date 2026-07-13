export const DEFAULT_YOPP_SERVER_URL = "http://127.0.0.1:3873";
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
export const MIN_REQUEST_TIMEOUT_MS = 1_000;
export const MAX_REQUEST_TIMEOUT_MS = 600_000;

export interface YoppConnectionConfig {
  serverUrl: string;
  token?: string;
  timeoutMs: number;
}

export function normalizeLocalServerUrl(raw: string | undefined): string {
  const candidate = raw?.trim() || DEFAULT_YOPP_SERVER_URL;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("Yopp server URL must be an absolute http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Yopp server URL must use http or https");
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    throw new Error("Yopp VS Code only connects to a loopback Yopp server");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Yopp server credentials must not be embedded in the URL");
  }
  if (parsed.search || parsed.hash || (parsed.pathname !== "/" && parsed.pathname !== "")) {
    throw new Error("Yopp server URL must be an origin without a path, query, or fragment");
  }
  parsed.pathname = "/";
  return parsed.origin;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLocaleLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  return octets.every(value => value >= 0 && value <= 255) && octets[0] === 127;
}

export function normalizeToken(raw: string | undefined): string | undefined {
  const token = raw?.trim();
  if (!token) return undefined;
  if (token.length > 4096 || /[\r\n]/.test(token)) throw new Error("Yopp server token is invalid");
  return token;
}

export function normalizeRequestTimeout(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(raw)) throw new Error("Yopp request timeout must be finite");
  return Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(MIN_REQUEST_TIMEOUT_MS, Math.trunc(raw)));
}
