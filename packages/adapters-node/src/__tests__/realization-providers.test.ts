import { describe, expect, it } from "vitest";
import { buildProviderPrompt, createApiKeyProvider, stripCodeFence, createOllamaProvider, providerAsWordingRealizer, verifySurfaceAgainstFacts } from "../realization-providers.js";

const facts = [{ subject: "pump alpha", predicate: "is", object: "stable at 42 psi", evidenceIds: ["e1", "e2"] }];
const request = { requestText: "status?", facts, targetLanguage: "en", targetScript: "Latn", maxSentences: 2, closedClassWords: ["the", "and"] };
const fakeFetch = (body: unknown, ok = true): typeof fetch => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

describe("generate-then-verify", () => {
  it("accepts surfaces made only of fact words and closed-class words", () => {
    expect(verifySurfaceAgainstFacts("The pump alpha is stable at 42 psi.", facts, new Set(["the"]))).toBe(true);
  });

  it("rejects any unlicensed content word", () => {
    expect(verifySurfaceAgainstFacts("The pump alpha exploded.", facts, new Set(["the"]))).toBe(false);
    expect(verifySurfaceAgainstFacts("", facts, new Set())).toBe(false);
  });

  it("licenses words from the request being answered, never new content", () => {
    expect(verifySurfaceAgainstFacts("Pump alpha is stable at 42 psi in the north hall.", facts, new Set(["the", "in"]))).toBe(false);
    expect(verifySurfaceAgainstFacts("Pump alpha is stable at 42 psi in the north hall.", facts, new Set(["the", "in"]), "Which pump is in the north hall?")).toBe(true);
    expect(verifySurfaceAgainstFacts("Pump alpha exploded in the north hall.", facts, new Set(["the", "in"]), "Which pump is in the north hall?")).toBe(false);
  });
});

describe("provider prompt", () => {
  it("carries an instruction, the request, and each fact once", () => {
    const built = buildProviderPrompt({ ...request, facts: [...facts, ...facts] });
    expect(built.system).toMatch(/only words that appear in the facts/u);
    expect(built.prompt).toContain("status?");
    expect(built.prompt.split("pump alpha is stable at 42 psi").length).toBe(2);
  });
});

describe("code requests", () => {
  it("asks for the whole corrected file and is verified by the compile gate, not by prose licensing", async () => {
    const codeRequest = { requestText: "fix add", facts: [{ subject: "math.ts", predicate: "contains", object: "export function add(a: number, b: number) { return a - b; }", evidenceIds: ["source"] }], targetLanguage: "typescript", targetScript: "Latn", maxSentences: 40, closedClassWords: [] };
    const built = buildProviderPrompt(codeRequest);
    expect(built.system).toMatch(/complete corrected file/u);
    expect(built.prompt).toContain("return a - b");
    const provider = createOllamaProvider({ host: "http://localhost:11434", model: "m", fetchImpl: fakeFetch({ response: "```typescript\nexport function add(a: number, b: number) { return a + b; }\n```" }) });
    expect((await provider.realize(codeRequest))[0]).toMatchObject({ verified: true, text: "export function add(a: number, b: number) { return a + b; }" });
    expect(stripCodeFence("plain")).toBe("plain");
  });
});

describe("local model-server provider", () => {
  it("returns a verified surface and never marks unverified output as verified", async () => {
    const good = createOllamaProvider({ host: "http://localhost:11434", model: "m", fetchImpl: fakeFetch({ response: "pump alpha is stable at 42 psi." }) });
    expect((await good.realize(request))[0]).toMatchObject({ verified: true });
    const bad = createOllamaProvider({ host: "http://localhost:11434", model: "m", fetchImpl: fakeFetch({ response: "pump alpha exploded" }) });
    expect((await bad.realize(request))[0]).toMatchObject({ verified: false });
    expect(await providerAsWordingRealizer(bad).realize(request)).toEqual([]);
  });

  it("falls back to nothing on transport failure", async () => {
    const failing = createOllamaProvider({ host: "http://localhost:11434", model: "m", fetchImpl: (async () => { throw new Error("down"); }) as unknown as typeof fetch });
    expect(await failing.realize(request)).toEqual([]);
  });
});

describe("api-key provider sovereignty gate", () => {
  it("refuses to start without the explicit remote-exposure acknowledgement", () => {
    expect(() => createApiKeyProvider({ endpoint: "https://example.invalid/v1", model: "m", apiKeyEnv: "X_KEY", acknowledgeRemoteDataExposure: false, env: { X_KEY: "k" } })).toThrow(/acknowledgeRemoteDataExposure/u);
  });

  it("refuses to start when the key env var is unset (keys never live in config)", () => {
    expect(() => createApiKeyProvider({ endpoint: "https://example.invalid/v1", model: "m", apiKeyEnv: "X_KEY", acknowledgeRemoteDataExposure: true, env: {} })).toThrow(/X_KEY/u);
  });

  it("logs that evidence left the device, with destination and span count, and verifies output", async () => {
    const lines: string[] = [];
    const provider = createApiKeyProvider({
      endpoint: "https://example.invalid/v1/chat",
      model: "m",
      apiKeyEnv: "X_KEY",
      acknowledgeRemoteDataExposure: true,
      env: { X_KEY: "k" },
      fetchImpl: fakeFetch({ choices: [{ message: { content: "pump alpha is stable at 42 psi" } }] }),
      log: { info: message => lines.push(message), warn: message => lines.push(message) }
    });
    const [output] = await provider.realize(request);
    expect(output).toMatchObject({ verified: true, provider: "api:m" });
    expect(lines.join("\n")).toMatch(/left the device/u);
    expect(lines.join("\n")).toMatch(/example\.invalid/u);
    expect(lines.join("\n")).toMatch(/2 evidence spans/u);
  });
});

describe("invention", () => {
  it("prompts an invention without facts and admits the draft as invented", async () => {
    const provider = createOllamaProvider({ host: "http://x", model: "m", fetchImpl: fakeFetch({ response: "Einstein raised his chalk like a sword as the dragon circled the lecture hall." }) });
    const out = await provider.realize({ ...request, facts: [], invention: true, requestText: "write a short story about einstein fighting a dragon" });
    expect(out).toHaveLength(1);
    expect(out[0]!.verified).toBe(true);
    const built = buildProviderPrompt({ ...request, facts: [], invention: true });
    expect(built.system).toMatch(/Invent freely/u);
    expect(built.prompt).not.toContain("Facts:");
    expect(await provider.realize({ ...request, facts: [] })).toEqual([]);
  });
});

describe("invention trimming", () => {
  it("keeps only complete sentences of a draft cut off by the token budget", async () => {
    const { trimToSentenceBoundary } = await import("../realization-providers.js");
    expect(trimToSentenceBoundary("He drew his chalk. The dragon roared! Then the sky went dar")).toBe("He drew his chalk. The dragon roared!");
    expect(trimToSentenceBoundary("no boundary at all")).toBe("");
    const provider = createOllamaProvider({ host: "http://x", model: "m", fetchImpl: fakeFetch({ response: "Einstein won. The dragon fle" }) });
    const out = await provider.realize({ ...request, facts: [], invention: true });
    expect(out[0]?.text).toBe("Einstein won.");
  });
});
