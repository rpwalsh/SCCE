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

import { createTypeScriptSnippetVerifier, type CodeVerifier } from "./code-verification.js";

export interface RealizationProvider {
  id: string;
  realize(request: WordingRealizerRequest): Promise<RealizationOutput[]>;
}

export interface ProviderLogger {
  info(message: string): void;
  warn(message: string): void;
}

const WORD_RE = /[\p{L}\p{M}\p{N}'’-]+/gu;

/** Generate-then-verify: every content word of the surface must occur in the facts or in the request being answered (closed-class words excepted). Pure. */
export function verifySurfaceAgainstFacts(surface: string, facts: readonly WordingRealizerFact[], closedClassWords: ReadonlySet<string>, requestText = ""): boolean {
  const licensed = new Set<string>();
  for (const word of requestText.match(WORD_RE) ?? []) licensed.add(word.toLocaleLowerCase());
  for (const fact of facts) for (const part of [fact.subject, fact.predicate, fact.object]) for (const word of String(part ?? "").match(WORD_RE) ?? []) licensed.add(word.toLocaleLowerCase());
  const words = surface.match(WORD_RE) ?? [];
  if (!words.length) return false;
  return words.every(word => {
    const lower = word.toLocaleLowerCase();
    return licensed.has(lower) || closedClassWords.has(lower) || lower.length <= 2;
  });
}

const CODE_LANGUAGES = new Set(["typescript", "javascript", "python", "rust", "go", "java", "c", "cpp", "csharp", "ruby", "php", "kotlin", "swift", "shell", "sql"]);

/** Code requests are verified by a compiler, not by prose word licensing. */
export function isCodeRequest(request: Pick<WordingRealizerRequest, "targetLanguage" | "codeLanguage">): boolean {
  return CODE_LANGUAGES.has(String(request.codeLanguage ?? request.targetLanguage ?? "").toLocaleLowerCase());
}

/** A request that carries the current file text asks for a rewrite of it; without one it asks for a new artifact. */
export function isWholeFileCodeRequest(request: WordingRealizerRequest): boolean {
  return request.facts.some(fact => fact.predicate === "contains");
}

/** A draft cut off by the token budget keeps its complete sentences; a cut with no boundary keeps nothing. Pure. */
export function trimToSentenceBoundary(text: string): string {
  const trimmed = text.trim();
  const match = /^[\s\S]*[.!?。！？؟।]["”’')\]]*/u.exec(trimmed);
  return match ? match[0].trim() : "";
}

/** Strips a single markdown code fence a model may wrap code in. Pure. */
export function stripCodeFence(text: string): string {
  const match = /^\s*```[\w+-]*\r?\n([\s\S]*?)\r?\n```\s*$/u.exec(text);
  return (match?.[1] ?? text).replace(/\s+$/u, "");
}

export interface ProviderPrompt {
  system: string;
  prompt: string;
}

/** Request + deduplicated facts in their own language; the verifier, not the prompt, enforces faithfulness. */
export function buildProviderPrompt(request: WordingRealizerRequest): ProviderPrompt {
  if (isCodeRequest(request)) {
    const language = String(request.codeLanguage ?? request.targetLanguage).toLocaleLowerCase();
    const source = request.facts.find(fact => fact.predicate === "contains")?.object ?? "";
    const notes = request.facts.filter(fact => fact.predicate !== "contains" && fact.predicate !== "asks").map(fact => `${fact.subject} ${fact.predicate} ${fact.object}`);
    if (!isWholeFileCodeRequest(request)) {
      return {
        system: `You write ${language}. Reply with the complete ${language} source only: no explanation, no commentary, no markdown fences. Include every import, type and helper the code needs to compile on its own.`,
        prompt: `Request:
${request.requestText}

${notes.length ? `Context:
${notes.join("\n")}

` : ""}Source:`
      };
    }
    return {
      system: `You edit ${language} source files. Reply with the complete corrected file contents only: no explanation, no markdown fences, no omitted sections. Change only what the request and the compiler diagnostics require.`,
      prompt: `Request:\n${request.requestText}\n\n${notes.length ? `Compiler diagnostics and workspace facts:\n${notes.join("\n")}\n\n` : ""}Current file:\n${source}\n\nCorrected file:`
    };
  }
  const facts = [...new Set(request.facts.map(fact => `${fact.subject} ${fact.predicate} ${fact.object}`.replace(/\s+/gu, " ").trim()))];
  if (request.invention) {
    const sentences = Math.max(1, request.maxSentences ?? 8);
    return {
      system: `Write the requested piece in at most ${sentences} sentences, in the language of the request. Invent freely; if facts are given, keep them true and do not contradict them. No preamble, title, or commentary.`,
      prompt: `Request:\n${request.requestText}\n\n${facts.length ? `Facts:\n${facts.join("\n")}\n\n` : ""}Piece:`
    };
  }
  const sentences = Math.max(1, request.maxSentences ?? 2);
  return {
    system: `Answer the request in at most ${sentences} complete sentence(s), each with a subject and a verb, restating the facts that answer it. Use only words that appear in the facts and keep every name and number you use exactly as written there. Write in the language of the facts. No preamble, commentary, or questions.`,
    prompt: `Request:\n${request.requestText}\n\nFacts:\n${facts.join("\n")}\n\nAnswer:`
  };
}

export interface OllamaProviderOptions {
  host: string;
  model: string;
  fetchImpl?: typeof fetch;
  log?: ProviderLogger;
  timeoutMs?: number;
  /** Proves a generated artifact by compiling it; without one, code is emitted unproven. */
  codeVerifier?: CodeVerifier;
  /** Generation attempts for an artifact that fails its compiler. */
  codeRepairAttempts?: number;
}

export function createOllamaProvider(options: OllamaProviderOptions): RealizationProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const host = options.host.replace(/\/$/u, "");
  return {
    id: `ollama:${options.model}`,
    async realize(request) {
      const facts = request.facts.filter(fact => fact.evidenceIds.length > 0);
      const invention = request.invention === true;
      const code = isCodeRequest(request);
      if (!facts.length && !invention && !code) return [];
      const language = String(request.codeLanguage ?? request.targetLanguage ?? "").toLocaleLowerCase();
      const generate = async (diagnostics: readonly string[]): Promise<string> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? (code ? 120_000 : invention ? 20_000 : 8_000));
        try {
          const built = buildProviderPrompt({ ...request, facts });
          // A failed compile is the only instruction a repair attempt needs: the compiler said what is wrong.
          const prompt = diagnostics.length
            ? `${built.prompt}\n\nThe previous attempt did not compile:\n${diagnostics.join("\n")}\n\nCorrected source:`
            : built.prompt;
          const response = await fetchImpl(`${host}/api/generate`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: options.model, system: built.system, prompt, stream: false, options: { temperature: invention ? 0.7 : 0, num_predict: code ? 2048 : invention ? 320 : 96 } }),
            signal: controller.signal
          });
          if (!response.ok) return "";
          const payload = await response.json() as { response?: string };
          return String(payload.response ?? "");
        } finally {
          clearTimeout(timer);
        }
      };
      try {
        if (code) {
          const attempts = Math.max(1, Math.min(3, options.codeRepairAttempts ?? 2));
          let diagnostics: readonly string[] = [];
          let unproven: RealizationOutput | undefined;
          for (let attempt = 1; attempt <= attempts; attempt++) {
            const artifact = stripCodeFence(await generate(diagnostics)).trim();
            if (!artifact) break;
            const verification = options.codeVerifier
              ? await options.codeVerifier.verify({ language, source: artifact })
              : { status: "unsupported" as const, diagnostics: [] };
            if (verification.status === "verified") {
              return [{ text: artifact, verified: true, provider: this.id }];
            }
            if (verification.status === "unsupported") {
              // Nothing proved it wrong and nothing proved it right; keep it only if no attempt ever compiles.
              unproven ??= { text: artifact, verified: true, provider: this.id };
              break;
            }
            diagnostics = verification.diagnostics;
            options.log?.warn(`[scce] generated ${language} did not compile (attempt ${attempt}/${attempts})`);
          }
          // Code that failed its compiler is never returned: a broken artifact is worse than none.
          return unproven ? [unproven] : [];
        }
        const raw = await generate([]);
        const text = invention ? trimToSentenceBoundary(raw) : raw.trim();
        if (!text.trim() || degenerateSurface(text)) return [];
        // An invention is admitted as invented; only sourced prose is word-licensed against the facts.
        const verified = invention || verifySurfaceAgainstFacts(text, facts, new Set(request.closedClassWords ?? []), request.requestText);
        return [{ text, verified, provider: this.id }];
      } catch {
        return [];
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
      const built = buildProviderPrompt({ ...request, facts });
      log.info(`realization.api: evidence left the device -> ${new URL(options.endpoint).host} (model ${options.model}, ${spanCount} evidence spans)`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
      try {
        const response = await fetchImpl(options.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: options.model, messages: [{ role: "system", content: built.system }, { role: "user", content: built.prompt }], temperature: 0, max_tokens: 96 }),
          signal: controller.signal
        });
        if (!response.ok) return [];
        const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; content?: Array<{ text?: string }> };
        const text = String(payload.choices?.[0]?.message?.content ?? payload.content?.[0]?.text ?? "").trim();
        if (!text || degenerateSurface(text)) return [];
        const verified = verifySurfaceAgainstFacts(text, facts, new Set(request.closedClassWords ?? []), request.requestText);
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
    return providerAsWordingRealizer(createOllamaProvider({ host: realization.ollama.host, model: realization.ollama.model, log, codeVerifier: createTypeScriptSnippetVerifier() }));
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
