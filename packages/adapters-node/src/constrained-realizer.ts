import type { WordingRealizerFact, WordingRealizerPort, WordingRealizerRequest } from "@scce/kernel";

/**
 * Lexically-constrained decoding realizer (declared in models.declared.json,
 * off unless realization.constrainedDecoding.enabled). Wording authority only:
 * at every decode step the logits are masked to tokens that occur in the
 * evidence-licensed facts plus the active language's closed-class vocabulary,
 * so no content token the evidence did not license can be emitted. Weights
 * load from a local directory only; inference never fetches anything.
 */

export interface ConstrainedTokenizer {
  encode(text: string): number[];
  decode(ids: readonly number[]): string;
  eosTokenId: number;
  vocabSize: number;
}

export interface ConstrainedModel {
  /** Generates token ids after `promptIds`, calling `mask` on each step's logits before sampling. */
  generate(promptIds: readonly number[], options: { maxNewTokens: number; mask: (logits: Float32Array, step: number) => void }): Promise<number[]>;
}

export interface ConstrainedRuntime {
  tokenizer: ConstrainedTokenizer;
  model: ConstrainedModel;
}

export interface ConstrainedRealizerOptions {
  modelId: string;
  modelDir: string;
  dtype?: "q8" | "q4" | "fp16" | "fp32";
  maxNewTokens?: number;
  closedClassWords?: () => ReadonlySet<string>;
  /** Injected for tests; default loads @huggingface/transformers lazily from modelDir only. */
  loader?: () => Promise<ConstrainedRuntime | undefined>;
  log?: (message: string) => void;
}

const MAX_FACTS = 12;
const DEFAULT_MAX_NEW_TOKENS = 96;

export function factSurfaceUnits(facts: readonly WordingRealizerFact[]): string[] {
  const out = new Set<string>();
  for (const fact of facts.slice(0, MAX_FACTS)) {
    for (const part of [fact.subject, fact.predicate, fact.object]) {
      for (const unit of String(part ?? "").split(/\s+/u)) if (unit.trim()) out.add(unit.trim());
    }
  }
  return [...out];
}

/** Token ids the decoder may emit: every token of every fact unit, every closed-class word (bare and space-prefixed), EOS, and basic punctuation. */
export function allowedTokenIds(tokenizer: ConstrainedTokenizer, facts: readonly WordingRealizerFact[], closedClassWords: ReadonlySet<string>): Set<number> {
  const allowed = new Set<number>([tokenizer.eosTokenId]);
  const words = [...factSurfaceUnits(facts), ...closedClassWords];
  for (const word of words) {
    for (const variant of [word, ` ${word}`, word.toLocaleLowerCase(), ` ${word.toLocaleLowerCase()}`]) {
      for (const id of tokenizer.encode(variant)) allowed.add(id);
    }
  }
  for (const punctuation of [".", ",", " .", " ,", ":", ";", "(", ")", " (", ")", "\n"]) {
    for (const id of tokenizer.encode(punctuation)) allowed.add(id);
  }
  return allowed;
}

/** In-place logit mask: everything outside `allowed` becomes -Infinity. Pure; no runtime dependency. */
export function applyLexicalMask(logits: Float32Array, allowed: ReadonlySet<number>): void {
  for (let id = 0; id < logits.length; id++) if (!allowed.has(id)) logits[id] = Number.NEGATIVE_INFINITY;
}

/** Degenerate output: empty, letterless, or one n-gram repeated three or more times. */
export function degenerateSurface(text: string): boolean {
  const clean = text.replace(/\s+/gu, " ").trim();
  if (!clean || !/\p{L}/u.test(clean)) return true;
  const units = clean.toLocaleLowerCase().split(" ");
  for (const n of [1, 2, 3]) {
    const seen = new Map<string, number>();
    for (let index = 0; index + n <= units.length; index++) {
      const gram = units.slice(index, index + n).join(" ");
      const count = (seen.get(gram) ?? 0) + 1;
      seen.set(gram, count);
      if (count >= 3 && units.length <= n * 4) return true;
    }
  }
  return false;
}

export function buildRealizationPrompt(request: WordingRealizerRequest): string {
  // Language-neutral: the facts themselves, in their own language, one per line.
  return request.facts.slice(0, MAX_FACTS).map(fact => `${fact.subject} ${fact.predicate} ${fact.object}`).join("\n") + "\n";
}

export function createConstrainedDecodingRealizer(options: ConstrainedRealizerOptions): WordingRealizerPort {
  const log = options.log ?? (() => undefined);
  let runtimePromise: Promise<ConstrainedRuntime | undefined> | undefined;
  const runtime = () => {
    if (!runtimePromise) {
      runtimePromise = (options.loader ?? (() => loadLocalTransformersRuntime(options)))().catch(error => {
        log(`constrained realizer unavailable: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      });
    }
    return runtimePromise;
  };
  return {
    id: `constrained-decoding:${options.modelId}`,
    async realize(request) {
      const facts = request.facts.filter(fact => fact.evidenceIds.length > 0);
      if (!facts.length) return [];
      const loaded = await runtime();
      if (!loaded) return [];
      const allowed = allowedTokenIds(loaded.tokenizer, facts, new Set([...(request.closedClassWords ?? []), ...(options.closedClassWords?.() ?? [])]));
      const promptIds = loaded.tokenizer.encode(buildRealizationPrompt({ ...request, facts }));
      const generated = await loaded.model.generate(promptIds, {
        maxNewTokens: Math.max(8, options.maxNewTokens ?? DEFAULT_MAX_NEW_TOKENS),
        mask: logits => applyLexicalMask(logits, allowed)
      });
      const text = loaded.tokenizer.decode(generated.filter(id => id !== loaded.tokenizer.eosTokenId)).trim();
      if (degenerateSurface(text)) return [];
      const sentences = text.split(/(?<=[.!?。！？])\s+/u).filter(Boolean).slice(0, Math.max(1, request.maxSentences));
      return [sentences.join(" ")];
    }
  };
}

async function loadLocalTransformersRuntime(options: ConstrainedRealizerOptions): Promise<ConstrainedRuntime | undefined> {
  const specifier = "@huggingface/transformers";
  const transformers = await import(specifier) as typeof import("@huggingface/transformers");
  transformers.env.allowRemoteModels = false;
  transformers.env.allowLocalModels = true;
  transformers.env.localModelPath = options.modelDir;
  const tokenizer = await transformers.AutoTokenizer.from_pretrained(options.modelId, { local_files_only: true });
  const model = await transformers.AutoModelForCausalLM.from_pretrained(options.modelId, { local_files_only: true, dtype: options.dtype ?? "q8", device: "cpu" });
  const eosTokenId = Number(tokenizer.eos_token_id ?? (model as { config?: { eos_token_id?: number } }).config?.eos_token_id ?? -1);
  const vocabSize = Number((model as { config?: { vocab_size?: number } }).config?.vocab_size ?? 0);
  class LexicalMaskProcessor extends transformers.LogitsProcessor {
    constructor(private readonly mask: (logits: Float32Array, step: number) => void) { super(); }
    private step = 0;
    override _call(_inputIds: bigint[][], logits: { data: Float32Array }): unknown {
      this.mask(logits.data as Float32Array, this.step++);
      return logits;
    }
  }
  return {
    tokenizer: {
      encode: text => Array.from(tokenizer.encode(text, { add_special_tokens: false }) as ArrayLike<number>).map(Number),
      decode: ids => tokenizer.decode(ids as number[], { skip_special_tokens: true }),
      eosTokenId,
      vocabSize
    },
    model: {
      async generate(promptIds, generateOptions) {
        const processors = new transformers.LogitsProcessorList();
        processors.push(new LexicalMaskProcessor(generateOptions.mask));
        const inputs = new transformers.Tensor("int64", BigInt64Array.from(promptIds.map(id => BigInt(id))), [1, promptIds.length]);
        const output = await model.generate({
          inputs,
          logits_processor: processors,
          generation_config: { max_new_tokens: generateOptions.maxNewTokens, do_sample: false } as never
        }) as { tolist(): bigint[][] };
        const row = output.tolist()[0] ?? [];
        return row.slice(promptIds.length).map(id => Number(id));
      }
    }
  };
}
