import { splitPriorUnits, normalizePriorKey } from "./kernel-answer-primitives.js";
import { toJsonValue } from "./primitives.js";
import type { ExplicitTurnRequirement } from "./turn-requirements.js";

/**
 * Formal language identity, not natural-language vocabulary: these are the
 * names programs are written in, the same way a document title names a source.
 * Distinctive names identify a language on sight; short aliases ("go", "c",
 * "js") are ordinary words in prose and only count once other code structure
 * corroborates them.
 */
const DISTINCTIVE_LANGUAGE_IDS: ReadonlyMap<string, string> = new Map([
  ["typescript", "typescript"], ["javascript", "javascript"], ["python", "python"],
  ["rust", "rust"], ["golang", "go"], ["java", "java"], ["kotlin", "kotlin"],
  ["swift", "swift"], ["csharp", "csharp"], ["ruby", "ruby"], ["php", "php"],
  ["bash", "shell"], ["shell", "shell"], ["sql", "sql"], ["cpp", "cpp"], ["c++", "cpp"]
]);

const ALIAS_LANGUAGE_IDS: ReadonlyMap<string, string> = new Map([
  ["ts", "typescript"], ["tsx", "typescript"], ["js", "javascript"], ["jsx", "javascript"],
  ["py", "python"], ["rs", "rust"], ["go", "go"], ["c", "c"], ["cs", "csharp"],
  ["rb", "ruby"], ["sh", "shell"], ["kt", "kotlin"]
]);

/** Extension to formal language, for a path named in a request. */
const CODE_EXTENSION_LANGUAGES: ReadonlyMap<string, string> = new Map([
  ["ts", "typescript"], ["tsx", "typescript"], ["mts", "typescript"], ["cts", "typescript"],
  ["js", "javascript"], ["jsx", "javascript"], ["mjs", "javascript"], ["cjs", "javascript"],
  ["py", "python"], ["rs", "rust"], ["go", "go"], ["java", "java"], ["kt", "kotlin"],
  ["swift", "swift"], ["c", "c"], ["h", "c"], ["cc", "cpp"], ["cpp", "cpp"], ["hpp", "cpp"],
  ["cs", "csharp"], ["rb", "ruby"], ["php", "php"], ["sh", "shell"], ["sql", "sql"]
]);

export interface CodeRequestSignal {
  /** The formal language the request names or implies, when one is identifiable. */
  language?: string;
  /** Bounded structural evidence that this request concerns executable artifacts. */
  demand: number;
  /** Paths the request names, in request order. */
  paths: string[];
  signals: string[];
}

const FENCE = /```/u;
const CAMEL_OR_SNAKE = /\b\p{Ll}[\p{L}\p{N}]*(?:\p{Lu}[\p{L}\p{N}]*|_[\p{L}\p{N}]+)/u;
const CALL_SHAPE = /[\p{L}\p{N}_$]\([^)]*\)/u;
const CODE_PUNCTUATION = /=>|::|\{\s*\}|<\p{Lu}[\p{L}\p{N}]*>/u;
const PATH_SHAPE = /(?:[\p{L}\p{N}_$.@-]+\/)+[\p{L}\p{N}_$.-]+\.([\p{L}\p{N}]{1,4})\b|\b[\p{L}\p{N}_$-]+\.([\p{L}\p{N}]{1,4})\b/gu;

/**
 * Structural, language-neutral evidence that a request is about code: fenced
 * blocks, a named formal language, identifier and call shapes, and paths with
 * code extensions. No natural-language vocabulary is consulted, so this holds
 * for a request written in any language. Pure.
 */
export function codeRequestSignal(requestText: string): CodeRequestSignal {
  const text = requestText ?? "";
  const signals: string[] = [];
  let demand = 0;
  let language: string | undefined;
  let distinctiveLanguage = false;

  const fenced = FENCE.test(text);
  if (fenced) { signals.push("code.signal.fenced_block"); demand += 0.45; }

  const requestUnits = splitPriorUnits(normalizePriorKey(text)).map(unit => unit.replace(/^[^\p{L}\p{N}+#]+|[^\p{L}\p{N}+#]+$/gu, ""));
  for (const unit of requestUnits) {
    const distinctive = DISTINCTIVE_LANGUAGE_IDS.get(unit);
    if (distinctive) { language ??= distinctive; distinctiveLanguage = true; signals.push("code.signal.formal_language"); demand += 0.4; break; }
  }
  if (!distinctiveLanguage) {
    for (const unit of requestUnits) {
      const alias = ALIAS_LANGUAGE_IDS.get(unit);
      if (alias) { language ??= alias; signals.push("code.signal.language_alias"); demand += 0.15; break; }
    }
  }

  const paths: string[] = [];
  for (const match of text.matchAll(PATH_SHAPE)) {
    const extension = String(match[1] ?? match[2] ?? "").toLocaleLowerCase();
    const extensionLanguage = CODE_EXTENSION_LANGUAGES.get(extension);
    if (!extensionLanguage) continue;
    const path = match[0];
    if (!paths.includes(path)) paths.push(path);
    language ??= extensionLanguage;
  }
  if (paths.length) { signals.push("code.signal.code_path"); demand += 0.35; }

  const identifierShape = CAMEL_OR_SNAKE.test(text);
  const callShape = CALL_SHAPE.test(text);
  const codePunctuation = CODE_PUNCTUATION.test(text);
  if (identifierShape) { signals.push("code.signal.identifier_shape"); demand += 0.2; }
  if (callShape) { signals.push("code.signal.call_shape"); demand += 0.2; }
  if (codePunctuation) { signals.push("code.signal.code_punctuation"); demand += 0.2; }

  return { ...(language ? { language } : {}), demand: Math.min(1, demand), paths: paths.slice(0, 8), signals };
}

/**
 * One structural signal is never enough: a named language is corroborated by
 * code shape, an alias only by a fenced block or a path. This is what keeps an
 * ordinary sentence containing "go" or "c" out of the artifact lane.
 */
export function codeRequestRecognized(signal: CodeRequestSignal): boolean {
  const has = (id: string) => signal.signals.includes(id);
  if (has("code.signal.code_path")) return true;
  if (has("code.signal.fenced_block") && signal.language !== undefined) return true;
  if (has("code.signal.formal_language")) return true;
  return has("code.signal.language_alias") && codeRequestCorroborated(signal);
}

/** Code shape around the language name: an artifact is being written, not discussed. Pure. */
export function codeRequestCorroborated(signal: CodeRequestSignal): boolean {
  return ["code.signal.identifier_shape", "code.signal.call_shape", "code.signal.code_punctuation", "code.signal.fenced_block", "code.signal.code_path"]
    .some(id => signal.signals.includes(id));
}

/**
 * Converts recognized code structure into the same explicit requirement shape a
 * structured authority uses, so routing stays one learned projection rather
 * than a second router.
 */
export function codeRequestRequirements(requestText: string, signal: CodeRequestSignal): ExplicitTurnRequirement[] {
  if (!codeRequestRecognized(signal)) return [];
  const charEnd = [...requestText].length;
  const values: Array<[ExplicitTurnRequirement["dimension"], number]> = [
    // Corroborated code shape asks for an artifact outright; a bare language name only tilts the projection, which still weighs the learned field.
    ["executableArtifactDemand", codeRequestCorroborated(signal) ? 0.92 : 0.58],
    ["formatConstraintStrength", 0.72],
    ["externalTruthAuthority", 0.2]
  ];
  return values.map(([dimension, value]) => ({
    id: `requirement.code_request.${dimension}.v1`,
    dimension,
    value,
    confidence: Math.min(1, 0.6 + signal.demand * 0.4),
    polarity: "required" as const,
    status: "explicit" as const,
    span: { charStart: 0, charEnd },
    semanticRoleId: "role.request.code.v1",
    learnedFrameOrPatternId: "pattern.code_request.structure.v1",
    sourceActivationId: "activation.structure.code_request.v1",
    trace: toJsonValue({ source: "kernel.code_request.structure", signals: signal.signals, language: signal.language ?? null, paths: signal.paths })
  }));
}
