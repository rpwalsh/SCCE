import type { WordingRealizerFact, WordingRealizerPort, WordingRealizerRequest } from "@scce/kernel";
import { createConstrainedDecodingRealizer, degenerateSurface } from "./constrained-realizer.js";
import type { ScceRuntimeConfig } from "./config.js";

/**
 * Realization providers (Phase 5). Every provider is a WordingRealizerPort: its
 * surfaces join the mouth's candidate pool subject to every existing gate. The
 * native mouth is always the default and the fallback on any provider error.
 *
 * - native: no port (the three native strategies), or the Phase 2 constrained decoder.
 * - ollama: local generate-then-verify over http://localhost:11434 (no sovereignty gate; loopback).
 * - api:    remote generate-then-verify; refuses to start unless
 *           realization.apiProvider.acknowledgeRemoteDataExposure === true; every call is
 *           logged with destination and evidence-span count; key read from an env var.
 */

export interface RealizationOutput {
  text: string;
  verified: boolean;
  provider: string;
}

export interface RealizationProvider {
  id: string;
  realize(request: WordingRealizerRequest): Promise<RealizationOutput[]>;
}

export interface ProviderLogger {
  info(message: string): void;
  warn(message: string): void;
}

const WORD_RE = /[\p{L}\p{M}\p{N}'’-]+/gu;

/** Generate-then-verify: every content word of the surface must occur in the facts (closed-class words and numbers from facts excepted). Pure. */
export function verifySurfaceAgainstFacts(surface: string, facts: readonly WordingRealizerFact[], closedClassWords: ReadonlySet<string>): boolean {
  const licensed = new Set<string>();
  for (const fact of facts) for (const part of [fact.subject, fact.predicate, fact.object]) for (const word of String(part ?? "").match(WORD_RE) ?? []) licensed.add(word.toLocaleLowerCase());
  const words = surface.match(WORD_RE) ?? [];
  if (!words.length) return false;
  return words.every(word => {
    const lower = word.toLocaleLowerCase();
    return licensed.has(lower) || closedClassWords.has(lower) || lower.length <= 2;
  });
}

export function buildProviderPrompt(request: WordingRealizerRequest): string {
  // Language-neutral: the facts in their own language; the verifier, not the prompt, enforces faithfulness.
  return request.facts.map(fact => `${fact.subject} ${fact.predicate} ${fact.object}`).join("\n") + "\n";
}

export interface OllamaProviderOptions {
  host: string;
  model: string;
  fetchImpl?: typeof fetch;
  log?: ProviderLogger;
  timeoutMs?: number;
}

export function createOllamaProvider(options: OllamaProviderOptions): RealizationProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const host = options.host.replace(/\/$/u, "");
  return {
    id: `ollama:${options.model}`,
    async realize(request) {
      const facts = request.facts.filter(fact => fact.evidenceIds.length > 0);
      if (!facts.length) return [];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
      try {
        const response = await fetchImpl(`${host}/api/generate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: options.model, prompt: buildProviderPrompt({ ...request, facts }), stream: false, options: { temperature: 0, num_predict: 96 } }),
          signal: controller.signal
        });
        if (!response.ok) return [];
        const payload = await response.json() as { response?: string };
        const text = String(payload.response ?? "").trim();
        if (!text || degenerateSurface(text)) return [];
        const verified = verifySurfaceAgainstFacts(text, facts, new Set(request.closedClassWords ?? []));
        return [{ text, verified, provider: this.id }];
      } catch {
        return [];
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

export interface ApiProviderOptions {
  endpoint: string;
  model: string;
  apiKeyEnv: string;
  acknowledgeRemoteDataExposure: boolean;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  log?: ProviderLogger;
  timeoutMs?: number;
}

/** Sovereignty gate: constructing this provider without the explicit acknowledgement throws — it never starts silently. */
export function createApiKeyProvider(options: ApiProviderOptions): RealizationProvider {
  if (options.acknowledgeRemoteDataExposure !== true) {
    throw new Error("realization.apiProvider refused: set realization.apiProvider.acknowledgeRemoteDataExposure=true to send evidence off-device");
  }
  const env = options.env ?? process.env;
  const apiKey = env[options.apiKeyEnv];
  if (!apiKey) throw new Error(`realization.apiProvider refused: environment variable ${options.apiKeyEnv} is not set (keys are never stored in config)`);
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? { info: () => undefined, warn: () => undefined };
  return {
    id: `api:${options.model}`,
    async realize(request) {
      const facts = request.facts.filter(fact => fact.evidenceIds.length > 0);
      if (!facts.length) return [];
      const spanCount = new Set(facts.flatMap(fact => fact.evidenceIds)).size;
      log.info(`realization.api: evidence left the device -> ${new URL(options.endpoint).host} (model ${options.model}, ${spanCount} evidence spans)`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
      try {
        const response = await fetchImpl(options.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: options.model, messages: [{ role: "user", content: buildProviderPrompt({ ...request, facts }) }], temperature: 0, max_tokens: 96 }),
          signal: controller.signal
        });
        if (!response.ok) return [];
        const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; content?: Array<{ text?: string }> };
        const text = String(payload.choices?.[0]?.message?.content ?? payload.content?.[0]?.text ?? "").trim();
        if (!text || degenerateSurface(text)) return [];
        const verified = verifySurfaceAgainstFacts(text, facts, new Set(request.closedClassWords ?? []));
        return [{ text, verified, provider: this.id }];
      } catch (error) {
        log.warn(`realization.api failed, native fallback: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

/** Adapts a provider to the kernel port: only verified surfaces reach the candidate pool; errors yield nothing (native fallback). */
export function providerAsWordingRealizer(provider: RealizationProvider): WordingRealizerPort {
  return {
    id: provider.id,
    async realize(request) {
      try {
        return (await provider.realize(request)).filter(output => output.verified).map(output => output.text);
      } catch {
        return [];
      }
    }
  };
}

/** Selects the configured provider; `native` (default) returns the Phase 2 constrained decoder when enabled, otherwise no port. */
export function selectRealizationPort(config: ScceRuntimeConfig, options: { log?: ProviderLogger; env?: Record<string, string | undefined> } = {}): WordingRealizerPort | undefined {
  const realization = config.realization;
  const provider = realization?.provider ?? "native";
  const log = options.log ?? { info: message => console.error(`[scce] ${message}`), warn: message => console.error(`[scce] ${message}`) };
  if (provider === "ollama" && realization?.ollama) {
    return providerAsWordingRealizer(createOllamaProvider({ host: realization.ollama.host, model: realization.ollama.model, log }));
  }
  if (provider === "api" && realization?.apiProvider) {
    return providerAsWordingRealizer(createApiKeyProvider({
      endpoint: realization.apiProvider.endpoint,
      model: realization.apiProvider.model,
      apiKeyEnv: realization.apiProvider.apiKeyEnv,
      acknowledgeRemoteDataExposure: realization.apiProvider.acknowledgeRemoteDataExposure === true,
      env: options.env,
      log
    }));
  }
  const constrained = realization?.constrainedDecoding;
  if (constrained?.enabled) {
    return createConstrainedDecodingRealizer({ modelId: constrained.modelId, modelDir: constrained.modelDir, dtype: constrained.dtype, maxNewTokens: constrained.maxNewTokens, log: message => log.warn(message) });
  }
  return undefined;
}
