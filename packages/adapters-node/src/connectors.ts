import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { toJsonValue, type ConnectorPort, type JsonValue } from "@scce/kernel";
import type { PolicyProfile } from "@scce/kernel";
import type { ScceRuntimeConfig } from "./config.js";
import { ConnectorPolicyGate, hostAllowlisted, redactHeaders, unsafeLocalHostname } from "./connector-policy.js";
import { resolveSecret } from "./secrets.js";

type WebSearchProvider = NonNullable<NonNullable<ScceRuntimeConfig["connectors"]["web"]>["search"]>["provider"];

interface WebSearchResult {
  uri: string;
  title: string;
  snippet: string;
  metadata: JsonValue;
}

export class ConfiguredConnectorAdapter implements ConnectorPort {
  private readonly gate: ConnectorPolicyGate;

  constructor(private readonly config: ScceRuntimeConfig, policyPatch: () => Partial<PolicyProfile> = () => ({})) {
    this.gate = new ConnectorPolicyGate(config, policyPatch);
  }

  get quota() {
    return this.gate.snapshot();
  }

  audit(): JsonValue {
    return toJsonValue(this.gate.snapshot());
  }

  static create(config: ScceRuntimeConfig, policyPatch?: () => Partial<PolicyProfile>): ConfiguredConnectorAdapter {
    return new ConfiguredConnectorAdapter(config, policyPatch);
  }

  private policy(): ConnectorPolicyGate {
    return this.gate;
  }

  async fetch(uri: string): Promise<{ uri: string; mediaType: string; bytes: Uint8Array; metadata: JsonValue }> {
    const url = new URL(uri);
    if (url.protocol === "https:" || url.protocol === "http:") return this.fetchWeb(url);
    throw new Error(`unsupported connector URI: ${uri}`);
  }

  async search(query: string, limit: number): Promise<Array<{ uri: string; title: string; snippet: string; metadata: JsonValue }>> {
    const web = this.config.connectors.web;
    if (!web?.enabled) throw new Error("web connector is disabled in scce.config.json");
    const provider = web.search?.provider ?? "duckduckgo";
    const results = await this.searchProvider(provider, query, Math.max(1, Math.min(50, limit)));
    if (results.length === 0) throw new Error(`web search provider ${provider} returned no results`);
    return results.slice(0, limit);
  }

  async outlookSearch(query: string, limit = 25): Promise<JsonValue> {
    const outlook = this.config.connectors.outlook;
    if (!outlook?.enabled || !outlook.accessToken) throw new Error("Outlook connector is not configured in scce.config.json");
    const uri = `https://graph.microsoft.com/v1.0/me/messages?$top=${Math.max(1, Math.min(50, limit))}&$search="${query.replace(/"/g, "")}"`;
    const accessToken = resolveSecret(outlook.accessToken, this.config, "Outlook accessToken");
    const record = this.policy().begin({ connector: "outlook", operation: "message-search", uri });
    try {
      const res = await fetch(uri, { headers: { Authorization: `Bearer ${accessToken}` } });
      const json = await responseJson(res);
      this.policy().finish(record, { status: res.status, metadata: { query, limit } });
      return json;
    } catch (error) {
      this.policy().fail(record, error);
      throw error;
    }
  }

  async outlookReadMessage(messageId: string): Promise<JsonValue> {
    return this.outlookJson(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}`, "message-read");
  }

  async outlookCreateDraft(input: { to: string[]; subject: string; body: string; cc?: string[]; approved?: boolean }): Promise<JsonValue> {
    const message = {
      subject: input.subject,
      body: { contentType: "Text", content: input.body },
      toRecipients: input.to.map(address => ({ emailAddress: { address } })),
      ccRecipients: (input.cc ?? []).map(address => ({ emailAddress: { address } }))
    };
    return this.outlookJson("https://graph.microsoft.com/v1.0/me/messages", "message-create-draft", {
      method: "POST",
      body: JSON.stringify(message),
      mutates: true,
      approved: input.approved,
      headers: { "content-type": "application/json" }
    });
  }

  async outlookSendDraft(messageId: string, approved = false): Promise<JsonValue> {
    return this.outlookJson(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}/send`, "message-send-draft", { method: "POST", body: "", mutates: true, approved });
  }

  async outlookReadCalendar(input: { start: string; end: string }): Promise<JsonValue> {
    const url = new URL("https://graph.microsoft.com/v1.0/me/calendarView");
    url.searchParams.set("startDateTime", input.start);
    url.searchParams.set("endDateTime", input.end);
    url.searchParams.set("$top", "50");
    return this.outlookJson(url.toString(), "calendar-read");
  }

  async outlookCreateCalendarEvent(input: { subject: string; start: string; end: string; attendees?: string[]; body?: string; approved?: boolean }): Promise<JsonValue> {
    const event = {
      subject: input.subject,
      body: { contentType: "Text", content: input.body ?? "" },
      start: { dateTime: input.start, timeZone: "UTC" },
      end: { dateTime: input.end, timeZone: "UTC" },
      attendees: (input.attendees ?? []).map(address => ({ emailAddress: { address }, type: "required" }))
    };
    return this.outlookJson("https://graph.microsoft.com/v1.0/me/events", "calendar-create-event", {
      method: "POST",
      body: JSON.stringify(event),
      mutates: true,
      approved: input.approved,
      headers: { "content-type": "application/json" }
    });
  }

  async outlookReadContacts(query?: string): Promise<JsonValue> {
    const url = new URL("https://graph.microsoft.com/v1.0/me/contacts");
    url.searchParams.set("$top", "50");
    if (query?.trim()) url.searchParams.set("$filter", `contains(displayName,'${query.replace(/'/g, "''")}') or contains(emailAddresses/any(a:a/address),'${query.replace(/'/g, "''")}')`);
    return this.outlookJson(url.toString(), "contacts-read");
  }

  async youtubeSearch(query: string, limit = 10): Promise<JsonValue> {
    const youtube = this.config.connectors.youtube;
    if (!youtube?.enabled || !youtube.apiKey) throw new Error("YouTube connector is not configured in scce.config.json");
    const apiKey = resolveSecret(youtube.apiKey, this.config, "YouTube apiKey");
    const url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("q", query);
    url.searchParams.set("type", "video,channel");
    url.searchParams.set("maxResults", String(Math.max(1, Math.min(50, limit))));
    url.searchParams.set("key", apiKey);
    return this.youtubeJson(url.toString(), "search", { query, limit });
  }

  async youtubeVideo(videoId: string): Promise<JsonValue> {
    const youtube = this.config.connectors.youtube;
    if (!youtube?.enabled || !youtube.apiKey) throw new Error("YouTube connector is not configured in scce.config.json");
    const apiKey = resolveSecret(youtube.apiKey, this.config, "YouTube apiKey");
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(apiKey)}`;
    return this.youtubeJson(url, "video", { videoId });
  }

  async youtubeChannel(channelId: string): Promise<JsonValue> {
    const youtube = this.config.connectors.youtube;
    if (!youtube?.enabled || !youtube.apiKey) throw new Error("YouTube connector is not configured in scce.config.json");
    const apiKey = resolveSecret(youtube.apiKey, this.config, "YouTube apiKey");
    const url = `https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails,statistics&id=${encodeURIComponent(channelId)}&key=${encodeURIComponent(apiKey)}`;
    return this.youtubeJson(url, "channel", { channelId });
  }

  async youtubeComments(videoId: string, limit = 50): Promise<JsonValue> {
    const youtube = this.config.connectors.youtube;
    if (!youtube?.enabled || !youtube.apiKey) throw new Error("YouTube connector is not configured in scce.config.json");
    const apiKey = resolveSecret(youtube.apiKey, this.config, "YouTube apiKey");
    const url = new URL("https://www.googleapis.com/youtube/v3/commentThreads");
    url.searchParams.set("part", "snippet,replies");
    url.searchParams.set("videoId", videoId);
    url.searchParams.set("maxResults", String(Math.max(1, Math.min(100, limit))));
    url.searchParams.set("textFormat", "plainText");
    url.searchParams.set("key", apiKey);
    return this.youtubeJson(url.toString(), "comments", { videoId, limit });
  }

  async telephoneCall(to: string, twiml: string, approved = false): Promise<JsonValue> {
    const tel = this.config.connectors.telephone;
    if (!tel?.enabled || !tel.accountSid || !tel.authToken || !tel.fromNumber) throw new Error("Telephone connector is not configured in scce.config.json");
    const accountSid = resolveSecret(tel.accountSid, this.config, "Twilio accountSid");
    const authToken = resolveSecret(tel.authToken, this.config, "Twilio authToken");
    const body = new URLSearchParams({ To: to, From: tel.fromNumber, Twiml: twiml });
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
    const uri = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`;
    const record = this.policy().begin({ connector: "telephone", operation: "call", uri, mutates: true, approved });
    try {
      const res = await fetch(uri, { method: "POST", headers: { Authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" }, body });
      const json = await responseJson(res);
      this.policy().finish(record, { status: res.status, metadata: { to, provider: "twilio" } });
      return json;
    } catch (error) {
      this.policy().fail(record, error);
      throw error;
    }
  }

  private async fetchWeb(url: URL) {
    const web = this.config.connectors.web;
    if (!web?.enabled) throw new Error("web connector is disabled in scce.config.json");
    const record = this.policy().begin({ connector: "web", operation: "fetch", uri: url.toString() });
    try {
      const response = await guardedWebFetch(url, web);
      if (!response.ok) throw new Error(`fetch failed ${response.status} ${response.statusText}: ${url}`);
      const bytes = await responseBytesCapped(response, web.maxBytes, url.toString());
      this.policy().finish(record, { status: response.status, bytes: bytes.byteLength, metadata: { mediaType: response.headers.get("content-type") ?? "application/octet-stream" } });
      return { uri: url.toString(), mediaType: response.headers.get("content-type") ?? "application/octet-stream", bytes, metadata: toJsonValue({ status: response.status, headers: redactHeaders(response.headers), connectorQuota: this.policy().snapshot() }) };
    } catch (error) {
      this.policy().fail(record, error);
      throw error;
    }
  }

  private async searchProvider(provider: WebSearchProvider, query: string, limit: number): Promise<WebSearchResult[]> {
    switch (provider) {
      case "duckduckgo":
        return this.duckDuckGoSearch(query, limit);
      case "bing":
        return this.bingSearch(query, limit);
      case "brave":
        return this.braveSearch(query, limit);
      case "serpapi":
        return this.serpApiSearch(query, limit);
      case "tavily":
        return this.tavilySearch(query, limit);
      default:
        throw new Error(`unsupported web search provider: ${provider}`);
    }
  }

  private async duckDuckGoSearch(query: string, limit: number): Promise<WebSearchResult[]> {
    const config = this.config.connectors.web?.search;
    const url = new URL(config?.endpoint || "https://html.duckduckgo.com/html/");
    url.searchParams.set("q", query);
    const html = await this.searchText(url, "duckduckgo", {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "SCCE-v3-local-research/1.0"
      }
    });
    return parseDuckDuckGoHtml(html, query).slice(0, limit);
  }

  private async bingSearch(query: string, limit: number): Promise<WebSearchResult[]> {
    const config = this.config.connectors.web?.search;
    const apiKey = resolveSearchKey(config?.apiKey, this.config, "Bing search apiKey");
    const url = new URL(config?.endpoint || "https://api.bing.microsoft.com/v7.0/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(limit));
    const json = await this.searchJson(url, "bing", { headers: { "Ocp-Apim-Subscription-Key": apiKey } });
    const values = (json as { webPages?: { value?: Array<{ url?: string; name?: string; snippet?: string }> } }).webPages?.value ?? [];
    return values.map(item => ({ uri: item.url ?? "", title: item.name ?? "", snippet: item.snippet ?? "", metadata: { provider: "bing", query } })).filter(validSearchResult);
  }

  private async braveSearch(query: string, limit: number): Promise<WebSearchResult[]> {
    const config = this.config.connectors.web?.search;
    const apiKey = resolveSearchKey(config?.apiKey, this.config, "Brave search apiKey");
    const url = new URL(config?.endpoint || "https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(limit));
    const json = await this.searchJson(url, "brave", { headers: { "X-Subscription-Token": apiKey, Accept: "application/json" } });
    const values = (json as { web?: { results?: Array<{ url?: string; title?: string; description?: string }> } }).web?.results ?? [];
    return values.map(item => ({ uri: item.url ?? "", title: item.title ?? "", snippet: item.description ?? "", metadata: { provider: "brave", query } })).filter(validSearchResult);
  }

  private async serpApiSearch(query: string, limit: number): Promise<WebSearchResult[]> {
    const config = this.config.connectors.web?.search;
    const apiKey = resolveSearchKey(config?.apiKey, this.config, "SerpAPI apiKey");
    const url = new URL(config?.endpoint || "https://serpapi.com/search.json");
    url.searchParams.set("engine", "google");
    url.searchParams.set("q", query);
    url.searchParams.set("num", String(limit));
    url.searchParams.set("api_key", apiKey);
    const json = await this.searchJson(url, "serpapi");
    const values = (json as { organic_results?: Array<{ link?: string; title?: string; snippet?: string }> }).organic_results ?? [];
    return values.map(item => ({ uri: item.link ?? "", title: item.title ?? "", snippet: item.snippet ?? "", metadata: { provider: "serpapi", query } })).filter(validSearchResult);
  }

  private async tavilySearch(query: string, limit: number): Promise<WebSearchResult[]> {
    const config = this.config.connectors.web?.search;
    const apiKey = resolveSearchKey(config?.apiKey, this.config, "Tavily apiKey");
    const url = new URL(config?.endpoint || "https://api.tavily.com/search");
    const json = await this.searchJson(url, "tavily", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, query, max_results: limit, search_depth: "advanced", include_answer: false })
    });
    const values = (json as { results?: Array<{ url?: string; title?: string; content?: string }> }).results ?? [];
    return values.map(item => ({ uri: item.url ?? "", title: item.title ?? "", snippet: item.content ?? "", metadata: { provider: "tavily", query } })).filter(validSearchResult);
  }

  private async searchJson(url: URL, provider: WebSearchProvider, init: RequestInit = {}): Promise<JsonValue> {
    const web = this.config.connectors.web;
    if (!web?.enabled) throw new Error("web connector is disabled in scce.config.json");
    const record = this.policy().begin({ connector: "web", operation: `search:${provider}`, uri: url.toString() });
    try {
      const response = await guardedWebFetch(url, web, init);
      const text = await responseTextCapped(response, web.maxBytes, url.toString());
      if (!response.ok) throw new Error(`search provider ${provider} HTTP ${response.status}: ${text.slice(0, 500)}`);
      this.policy().finish(record, { status: response.status, bytes: text.length, metadata: { provider, mediaType: response.headers.get("content-type") ?? "application/json" } });
      return (text ? JSON.parse(text) : null) as JsonValue;
    } catch (error) {
      this.policy().fail(record, error);
      throw error;
    }
  }

  private async searchText(url: URL, provider: WebSearchProvider, init: RequestInit = {}): Promise<string> {
    const web = this.config.connectors.web;
    if (!web?.enabled) throw new Error("web connector is disabled in scce.config.json");
    const record = this.policy().begin({ connector: "web", operation: `search:${provider}`, uri: url.toString() });
    try {
      const response = await guardedWebFetch(url, web, init);
      const text = await responseTextCapped(response, web.maxBytes, url.toString());
      if (!response.ok) throw new Error(`search provider ${provider} HTTP ${response.status}: ${text.slice(0, 500)}`);
      this.policy().finish(record, { status: response.status, bytes: text.length, metadata: { provider, mediaType: response.headers.get("content-type") ?? "text/html" } });
      return text;
    } catch (error) {
      this.policy().fail(record, error);
      throw error;
    }
  }

  private async outlookJson(uri: string, operation: string, options: { method?: string; body?: string; headers?: Record<string, string>; mutates?: boolean; approved?: boolean } = {}): Promise<JsonValue> {
    const outlook = this.config.connectors.outlook;
    if (!outlook?.enabled || !outlook.accessToken) throw new Error("Outlook connector is not configured in scce.config.json");
    const accessToken = resolveSecret(outlook.accessToken, this.config, "Outlook accessToken");
    const record = this.policy().begin({ connector: "outlook", operation, uri, mutates: options.mutates, approved: options.approved });
    try {
      const res = await fetch(uri, { method: options.method ?? "GET", headers: { Authorization: `Bearer ${accessToken}`, ...(options.headers ?? {}) }, body: options.body });
      const json = await responseJson(res);
      this.policy().finish(record, { status: res.status, metadata: { operation } });
      return json;
    } catch (error) {
      this.policy().fail(record, error);
      throw error;
    }
  }

  private async youtubeJson(uri: string, operation: string, metadata: JsonValue): Promise<JsonValue> {
    const record = this.policy().begin({ connector: "youtube", operation, uri });
    try {
      const res = await fetch(uri);
      const json = await responseJson(res);
      this.policy().finish(record, { status: res.status, metadata });
      return json;
    } catch (error) {
      this.policy().fail(record, error);
      throw error;
    }
  }
}

function resolveSearchKey(value: string | undefined, config: ScceRuntimeConfig, label: string): string {
  const key = resolveSecret(value ?? "", config, label);
  if (!key) throw new Error(`${label} is required by configured web.search.provider`);
  return key;
}

function validSearchResult(value: WebSearchResult): boolean {
  return Boolean(value.uri && value.title && /^https?:\/\//i.test(value.uri));
}

function parseDuckDuckGoHtml(html: string, query: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const anchorPattern = /<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const matches = [...html.matchAll(anchorPattern)];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!;
    const blockStart = match.index ?? 0;
    const blockEnd = matches[i + 1]?.index ?? Math.min(html.length, blockStart + 3000);
    const block = html.slice(blockStart, blockEnd);
    const uri = normalizeDuckDuckGoUri(decodeHtml(match[1] ?? ""));
    const title = normalizeWhitespace(stripTags(decodeHtml(match[2] ?? "")));
    const snippetMatch = /<a\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>|<div\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block);
    const snippet = normalizeWhitespace(stripTags(decodeHtml(snippetMatch?.[1] ?? snippetMatch?.[2] ?? "")));
    const result = { uri, title, snippet, metadata: { provider: "duckduckgo", query } };
    if (validSearchResult(result)) results.push(result);
  }
  return dedupeSearchResults(results);
}

function normalizeDuckDuckGoUri(raw: string): string {
  try {
    const absolute = raw.startsWith("//") ? `https:${raw}` : raw.startsWith("/") ? `https://duckduckgo.com${raw}` : raw;
    const url = new URL(absolute);
    const uddg = url.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    return url.toString();
  } catch {
    return raw;
  }
}

function dedupeSearchResults(results: WebSearchResult[]): WebSearchResult[] {
  const seen = new Set<string>();
  const out: WebSearchResult[] = [];
  for (const result of results) {
    const key = result.uri.replace(/#.*$/u, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(result);
  }
  return out;
}

function stripTags(value: string): string {
  return value.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
  return value
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => named[name.toLowerCase()] ?? m);
}

async function responseJson(response: Response): Promise<JsonValue> {
  const text = await response.text();
  const value = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`connector HTTP ${response.status}: ${text.slice(0, 500)}`);
  return value as JsonValue;
}

async function guardedWebFetch(url: URL, web: NonNullable<ScceRuntimeConfig["connectors"]["web"]>, init: RequestInit = {}): Promise<Response> {
  let current = new URL(url.toString());
  for (let redirect = 0; redirect <= 3; redirect++) {
    await assertSafeWebUrl(current, web.allowedHosts);
    const response = await fetch(current, { ...init, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    current = new URL(location, current);
  }
  throw new Error(`fetch redirect limit exceeded: ${url.origin}`);
}

async function assertSafeWebUrl(url: URL, allowedHosts: readonly string[]): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`unsupported web protocol: ${url.protocol}`);
  const hostname = normalizedHostname(url.hostname);
  if (unsafeLocalHostname(hostname)) throw new Error(`blocked local/private web host: ${hostname}`);
  if (!hostAllowlisted(hostname, allowedHosts)) throw new Error(`web host not allowlisted: ${hostname}`);
  if (isIP(hostname)) {
    if (privateOrReservedIp(hostname)) throw new Error(`blocked private/reserved web address: ${hostname}`);
    return;
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new Error(`web host did not resolve: ${hostname}`);
  for (const address of addresses) {
    if (privateOrReservedIp(address.address)) throw new Error(`blocked private/reserved web address for ${hostname}: ${address.address}`);
  }
}

function normalizedHostname(hostname: string): string {
  return hostname.trim().toLocaleLowerCase().replace(/^\[|\]$/g, "");
}

async function responseTextCapped(response: Response, maxBytes: number, label: string): Promise<string> {
  return new TextDecoder().decode(await responseBytesCapped(response, maxBytes, label));
}

async function responseBytesCapped(response: Response, maxBytes: number, label: string): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`response exceeded configured maxBytes: ${label}`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function privateOrReservedIp(address: string): boolean {
  const ip = address.toLocaleLowerCase();
  if (ip.startsWith("::ffff:")) return privateOrReservedIp(ip.slice("::ffff:".length));
  if (ip.includes(":")) return ip === "::"
    || ip === "::1"
    || ip.startsWith("fc")
    || ip.startsWith("fd")
    || ip.startsWith("fe80:")
    || ip.startsWith("ff");
  const octets = ip.split(".").map(part => Number(part));
  if (octets.length !== 4 || octets.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = octets as [number, number, number, number];
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}
