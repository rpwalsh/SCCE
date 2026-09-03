import { describe, expect, it } from "vitest";
import { buildProviderPrompt, createApiKeyProvider, createOllamaProvider, providerAsWordingRealizer, verifySurfaceAgainstFacts } from "../realization-providers.js";

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
