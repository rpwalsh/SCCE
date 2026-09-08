// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { kneserNeyProbability, predictKneserNey, trainKneserNey, type KneserNeyModel } from "./kneser-ney.js";
import { CORPUS_SOURCE_SYSTEM_IDS, corpusSourceAlias } from "./corpus-registry.js";
import { codeLanguageForPath } from "./code-request.js";
import type { NgramModelRecord } from "./storage.js";
import { CODE_LINE_SYMBOL, codeBracketBalance, codeIdentifierTokens, codeSurfaceTokens, renderCodeTokens } from "./code-surface.js";
import type { ProgramDiagnostic, RepairOperation } from "./program-repair-kernel.js";
import { LEARNED_CODE_CONSTRUCTION_REPAIR_FAMILY } from "./program-repair-kernel.js";
import { toJsonValue } from "./primitives.js";
import type { JsonValue } from "./types.js";

/**
 * Composing code the way the mouth composes prose: predict the next symbol from what the corpus taught, keep
 * only what is structurally admissible, and let the compiler decide.
 *
 * This is the producer the mouth's `candidate:generated:code:` lane was always written to consume. Nothing here
 * reads a compiler's suggested fix; the diagnostic supplies only a location. What replaces that location is
 * generated from two learned distributions and gated on bracket structure -- and then, by the caller, on whether
 * it builds. A proposal that does not build is rolled back and costs nothing, which is why generating is safe
 * here in a way it is not for a writer with no gate.
 */

/**
 * Weight on the corpus distribution against the file's own.
 *
 * A corpus model cannot emit an identifier it never saw, and the names a repair must use are usually local to
 * the file being repaired -- so a corpus-only distribution is structurally incapable of writing `row.label` for
 * a file whose `label` the corpus has never met. Interpolating a model trained on the target file itself closes
 * that, and the split decides which one leads: the corpus knows the shape of the language, the file knows its
 * names.
 *
 * Measured, not chosen. `tools/code-generation-calibration/calibrate.mjs` removes a line from a held-out file,
 * trains the local model on what is left, mixes the corpus models from other files, and scores how well the pair
 * predicts the removed line -- which is exactly the question this lane answers at repair time. Over 3,948
 * held-out symbols the minimum sits at 0.30, with both extremes far worse: corpus-only costs 4.17 nats per
 * token and file-only 3.63, against 2.96 at the minimum. Both distributions are load-bearing.
 *
 * The value is corpus-scaled: it was calibrated against a 12-model mixture, and a larger code corpus should
 * carry more weight than this. Re-run the tool when the corpus grows rather than nudging the constant.
 */
export const CODE_CORPUS_INTERPOLATION_WEIGHT = 0.3;

/** Symbols that end a generated fragment: a statement terminator or the line boundary it was asked to fill. */
const FRAGMENT_TERMINALS: ReadonlySet<string> = new Set([";", CODE_LINE_SYMBOL]);

const CONTEXT_SYMBOL_LIMIT = 48;
const CANDIDATE_SYMBOL_LIMIT = 40;
const PREDICTION_POOL = 24;
/** How many trained models the corpus distribution mixes; past this the search cost stops buying coverage. */
const CORPUS_MODEL_MIXTURE_LIMIT = 12;

export interface LearnedCodeRepairCandidate {
  /** The id the mouth's generated-code lane selects on, and the audit trail's name for this composition. */
  id: string;
  languageId: string;
  startLine: number;
  endLine: number;
  content: string;
  surface: string;
  strategy: "line" | "tail";
  averageLogProbability: number;
  /** Ranking objective: the above with required-symbol boosts applied. Never read as a probability. */
  score: number;
  coveredSymbols: string[];
  audit: JsonValue;
}

export interface LearnedCodeGenerationInput {
  /** Code n-gram models hydrated for this formal language; empty means nothing was learned and nothing is proposed. */
  models: readonly KneserNeyModel[];
  languageId: string;
  targetPath: string;
  targetText: string;
  diagnostics: readonly ProgramDiagnostic[];
  /** Names the request, the retrieved API surface, or the diagnostics put in play, boosted during generation. */
  requiredSymbols?: readonly string[];
  /**
   * The identifiers a toolchain says may legally stand at the diagnostic's own position, when one was asked.
   *
   * A constraint at that position rather than a preference, because it is not an opinion: an identifier outside
   * this set does not type-check there, and composing one spends an attempt proving what was already known. It
   * binds only the first symbol of a fragment that starts at the defect; every later position is one this
   * answer was never about.
   */
  admissibleSiteSymbols?: readonly string[];
  maxCandidates?: number;
  beamWidth?: number;
  corpusWeight?: number;
}

/**
 * The candidates a learned code lane offers for one diagnostic site, best first.
 *
 * Two strategies, because a diagnostic locates a defect at two useful granularities: `tail` keeps the line up to
 * the reported column and regenerates from there, which is what a mis-typed member or a wrong argument needs;
 * `line` regenerates the whole statement, which is what a line that is wrong from its start needs. Neither is
 * chosen here -- both are offered, and the build is the selector.
 */
export function generateLearnedCodeRepairs(input: LearnedCodeGenerationInput): LearnedCodeRepairCandidate[] {
  // Every model the corpus lane trained for this language, mixed. Each source file trains its own model, so a
  // language's competence is spread across them; taking one would be reading a single file's habits as the
  // language, and merging their counts is not something Kneser-Ney smoothing survives.
  const corpusModels = selectCorpusMixture(input.models);
  const corpusOrder = corpusModels[0]?.order;
  if (!corpusOrder) return [];
  const lines = input.targetText.split(/\r?\n/u);
  const fileTokens = codeSurfaceTokens(input.targetText);
  if (!fileTokens.length) return [];
  const corpusWeight = clampUnit(input.corpusWeight ?? CODE_CORPUS_INTERPOLATION_WEIGHT);
  const boost = boostedSymbols(input.requiredSymbols ?? []);
  const maxCandidates = Math.max(1, Math.min(8, Math.floor(input.maxCandidates ?? 4)));
  const out: LearnedCodeRepairCandidate[] = [];

  for (const site of repairSites(input.diagnostics, lines.length)) {
    const lineText: string | undefined = lines[site.line - 1];
    if (lineText === undefined) continue;
    const indent = lineText.match(/^[ \t]*/u)?.[0] ?? "";
    // The file's own model, trained on everything except the line being replaced.
    //
    // Left in, the defect is the strongest local evidence there is: a model that has read `row.labell`
    // predicts `labell` after `row .` more confidently than any corpus can outvote, and the lane regenerates
    // the very text it was asked to fix. Removing the line is also what makes the calibrated interpolation
    // weight apply, because a held-out line is the condition it was measured under.
    const localModel = trainKneserNey(
      codeSurfaceTokens([...lines.slice(0, site.line - 1), ...lines.slice(site.line)].join("\n")),
      { order: corpusOrder, discount: 0.75, vocabularyLimit: 8192 }
    );
    for (const strategy of ["tail", "line"] as const) {
      // At column 1 a tail is the whole line, so the two strategies are the same generation run.
      if (strategy === "tail" && site.column <= 1) continue;
      const prefixText: string = strategy === "tail" ? lineText.slice(0, site.column - 1) : "";
      const prompt = [
        ...codeSurfaceTokens(lines.slice(Math.max(0, site.line - 5), site.line - 1).join("\n")),
        CODE_LINE_SYMBOL,
        ...codeSurfaceTokens(prefixText)
      ].slice(-CONTEXT_SYMBOL_LIMIT);
      const generated = beamGenerateFragment({
        corpusModels,
        localModel,
        corpusWeight,
        // Only the tail begins at the reported position, so only the tail is bound by what is legal there.
        ...(strategy === "tail" && input.admissibleSiteSymbols?.length
          ? { firstSymbolVocabulary: new Set(input.admissibleSiteSymbols) }
          : {}),
        prompt,
        boost,
        beamWidth: Math.max(2, Math.min(12, Math.floor(input.beamWidth ?? 6)))
      });
      if (!generated) continue;
      const rendered = renderCodeTokens(generated.symbols).trimEnd();
      if (!rendered.trim()) continue;
      // What the fragment did not replace, it keeps. A tail regenerates from the defect to the end of a
      // statement, and where it stopped at the line boundary instead of a terminator the rest of the
      // original line was never in question -- dropping it turns a one-token repair into a rewrite.
      const preserved = strategy === "tail" && !rendered.endsWith(";")
        ? lineText.slice(site.column - 1).replace(/^[\p{Letter}\p{Number}_$]+/u, "")
        : "";
      const candidate: string = (strategy === "tail" ? `${prefixText}${rendered}${preserved}` : `${indent}${rendered}`).trimEnd();
      if (!candidate.trim() || candidate === lineText) continue;
      if (!preservesUninvolvedTokens(lineText, candidate, site.column)) continue;
      const coveredSymbols = (input.requiredSymbols ?? []).filter(symbol => generated.symbols.includes(symbol));
      out.push({
        id: `candidate:generated:code:${input.languageId}:${strategy}:${site.line}:${out.length}`,
        languageId: input.languageId,
        startLine: site.line,
        endLine: site.line,
        content: candidate,
        surface: candidate.trim(),
        strategy,
        averageLogProbability: generated.averageLogProbability,
        score: generated.score,
        coveredSymbols,
        audit: toJsonValue({
          source: "code-construction.generateLearnedCodeRepairs",
          strategy,
          languageId: input.languageId,
          targetPath: input.targetPath,
          diagnosticId: site.diagnosticId,
          line: site.line,
          column: site.column,
          corpusModels: corpusModels.length,
          corpusModelOrder: corpusOrder,
          localModelOrder: localModel.order,
          corpusWeight,
          promptSymbols: prompt.length,
          generatedSymbols: generated.symbols.length,
          averageLogProbability: generated.averageLogProbability,
          score: generated.score,
          bracketBalance: codeBracketBalance(generated.symbols).open.length,
          coveredSymbols
        })
      });
    }
  }

  // Two diagnostics on the same statement compose the same replacement, and offering it twice spends a second
  // attempt re-proving the first one's rejection. The loop's budget is for distinct hypotheses.
  const distinct = new Map<string, LearnedCodeRepairCandidate>();
  for (const candidate of out.sort((left, right) =>
    right.coveredSymbols.length - left.coveredSymbols.length
    || right.score - left.score
    || left.id.localeCompare(right.id))) {
    const key = `${candidate.startLine}\u0001${candidate.content}`;
    if (!distinct.has(key)) distinct.set(key, candidate);
  }
  return [...distinct.values()].slice(0, maxCandidates);
}

/**
 * The trained code models a hydrated language memory is holding for one formal language.
 *
 * Hydration carries the stored records alongside the parsed models, and it is the records that say which corpus
 * and which file a model came from -- so this is where a turn finds out whether it has ever been shown the
 * language it is being asked to write. No models means the honest answer is that nothing was learned, and the
 * lane proposes nothing rather than composing out of prose.
 */
export function codeModelsFromRecords(
  records: readonly NgramModelRecord[],
  languageId: string,
  limit = CORPUS_MODEL_MIXTURE_LIMIT
): KneserNeyModel[] {
  const out: KneserNeyModel[] = [];
  for (const record of records) {
    const stored = record.modelJson && typeof record.modelJson === "object" && !Array.isArray(record.modelJson)
      ? record.modelJson as Record<string, unknown>
      : {};
    // Records carry the corpus label the trainer stamped, not the opaque source-system identity.
    if (stored.sourceSystem !== undefined && stored.sourceSystem !== corpusSourceAlias(CORPUS_SOURCE_SYSTEM_IDS.ossCode)) continue;
    const declared = typeof stored.formalLanguage === "string" ? stored.formalLanguage : codeLanguageForPath(record.streamId);
    if (declared !== languageId) continue;
    const model = stored.model as KneserNeyModel | undefined;
    if (!model || typeof model !== "object" || !Number.isInteger(model.order) || !model.counts) continue;
    out.push(model);
    if (out.length >= limit) break;
  }
  return out.sort((left, right) => right.order - left.order);
}

export interface LearnedCodeSurface {
  languageId: string;
  text: string;
  averageLogProbability: number;
  lines: number;
  coveredSymbols: string[];
  audit: JsonValue;
}

/**
 * Code composed for a request that names no file: the chat case.
 *
 * The repair lane above conditions on the code around a defect. Here the only conditioning material is the
 * request itself -- the identifiers it spells and any code it quotes -- so the prompt is seeded from that and
 * each accepted line is fed back as the context for the next. It is the same generator either way; what changes
 * is what it is given to continue from.
 *
 * Nothing is claimed about whether the result builds. A caller with a toolchain should verify it and say so; a
 * caller without one should present it as composed and unproven, never as an artifact.
 */
export function generateLearnedCodeSurface(input: {
  models: readonly KneserNeyModel[];
  languageId: string;
  requestText: string;
  requiredSymbols?: readonly string[];
  contextCode?: string;
  maxLines?: number;
  beamWidth?: number;
  corpusWeight?: number;
}): LearnedCodeSurface | undefined {
  const corpusModels = selectCorpusMixture(input.models);
  const corpusOrder = corpusModels[0]?.order;
  if (!corpusOrder) return undefined;
  const seedTokens = codeSurfaceTokens(`${input.contextCode ?? ""}\n${input.requestText}`);
  // With no file to adapt to, the request's own tokens are the only local evidence there is. A model trained on
  // them is thin, but it is what carries the names this request is about into a distribution the corpus lacks.
  const localModel = trainKneserNey(seedTokens.length ? seedTokens : [CODE_LINE_SYMBOL], { order: corpusOrder, discount: 0.75, vocabularyLimit: 4096 });
  const boost = boostedSymbols(input.requiredSymbols ?? []);
  const maxLines = Math.max(1, Math.min(24, Math.floor(input.maxLines ?? 8)));
  const corpusWeight = clampUnit(input.corpusWeight ?? CODE_CORPUS_INTERPOLATION_WEIGHT);
  const beamWidth = Math.max(2, Math.min(12, Math.floor(input.beamWidth ?? 6)));

  const context: string[] = codeSurfaceTokens(input.contextCode ?? "").slice(-CONTEXT_SYMBOL_LIMIT);
  const lines: string[] = [];
  let totalLogProbability = 0;
  let totalSymbols = 0;
  const emitted: string[] = [];
  for (let line = 0; line < maxLines; line++) {
    const generated = beamGenerateFragment({
      corpusModels,
      localModel,
      corpusWeight,
      prompt: [...context, CODE_LINE_SYMBOL].slice(-CONTEXT_SYMBOL_LIMIT),
      boost,
      beamWidth
    });
    if (!generated) break;
    const rendered = renderCodeTokens(generated.symbols, indentForDepth(codeBracketBalance(context).open.length)).trimEnd();
    if (!rendered.trim()) break;
    lines.push(rendered);
    emitted.push(...generated.symbols);
    totalLogProbability += generated.averageLogProbability * generated.symbols.length;
    totalSymbols += generated.symbols.length;
    context.push(...generated.symbols, CODE_LINE_SYMBOL);
    // A composition that has closed everything it opened is a complete unit; continuing past that is padding.
    if (lines.length > 1 && !codeBracketBalance(context).open.length) break;
  }
  if (!lines.length) return undefined;
  const coveredSymbols = (input.requiredSymbols ?? []).filter(symbol => emitted.includes(symbol));
  return {
    languageId: input.languageId,
    text: lines.join("\n"),
    averageLogProbability: totalSymbols ? totalLogProbability / totalSymbols : 0,
    lines: lines.length,
    coveredSymbols,
    audit: toJsonValue({
      source: "code-construction.generateLearnedCodeSurface",
      languageId: input.languageId,
      corpusModels: corpusModels.length,
      corpusModelOrder: corpusOrder,
      corpusWeight,
      seedSymbols: seedTokens.length,
      lines: lines.length,
      symbols: totalSymbols,
      averageLogProbability: totalSymbols ? totalLogProbability / totalSymbols : 0,
      unclosedBrackets: codeBracketBalance(context).open.length,
      coveredSymbols
    })
  };
}

/** Two spaces per open bracket: the indentation almost every formal language is written with, and none require. */
function indentForDepth(depth: number): string {
  return "  ".repeat(Math.max(0, Math.min(8, depth)));
}

/** One learned candidate as the repair operation the code mouth applies, verifies, and rolls back. */
export function learnedCodeRepairOperation(
  candidate: LearnedCodeRepairCandidate,
  targetPath: string
): RepairOperation {
  return {
    id: `repair.learned_code.${candidate.strategy}.${candidate.startLine}`,
    kind: "replace",
    path: targetPath,
    startLine: candidate.startLine,
    endLine: candidate.endLine,
    content: candidate.content,
    reason: `composed from learned ${candidate.languageId} constructions at ${targetPath}:${candidate.startLine}; the build decides`,
    risk: 0.35,
    riskStatus: "provisional-uncalibrated",
    repairFamilyId: LEARNED_CODE_CONSTRUCTION_REPAIR_FAMILY
  };
}

/**
 * A repair may rewrite what the diagnostic points at. Everything else on that line was never in question.
 *
 * Without this the gate is satisfiable by deletion, and the search finds that out: asked to fix a call with too
 * few arguments, it replaced `export const total = add(1);` with `add`, which type-checks perfectly and destroys
 * the module. "It compiles" is a real criterion but a one-sided one -- it bounds what is wrong with a program,
 * not what the program has to still be. The token the diagnostic names may change or vanish; every other token
 * on the line has to survive, because removing one is a different operation that nobody asked for.
 */
function preservesUninvolvedTokens(originalLine: string, candidate: string, column: number): boolean {
  const before = originalLine.slice(0, Math.max(0, column - 1));
  const after = originalLine.slice(Math.max(0, column - 1)).replace(/^[\p{Letter}\p{Number}_$]+/u, "");
  const required = codeSurfaceTokens(`${before}${after}`);
  const present = new Map<string, number>();
  for (const token of codeSurfaceTokens(candidate)) present.set(token, (present.get(token) ?? 0) + 1);
  for (const token of required) {
    const remaining = present.get(token) ?? 0;
    if (remaining <= 0) return false;
    present.set(token, remaining - 1);
  }
  return true;
}

interface RepairSite {
  line: number;
  column: number;
  diagnosticId: string;
}

/** Where the diagnostics say the defect is. A location only -- nothing here reads what the compiler suggests. */
function repairSites(diagnostics: readonly ProgramDiagnostic[], lineCount: number): RepairSite[] {
  const seen = new Set<string>();
  const out: RepairSite[] = [];
  for (const diagnostic of diagnostics) {
    const line = Number(diagnostic.line ?? 0);
    if (!Number.isInteger(line) || line < 1 || line > lineCount) continue;
    const column = Math.max(1, Number(diagnostic.column ?? 1));
    const key = `${line}:${column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ line, column, diagnosticId: diagnostic.id });
  }
  return out.slice(0, 8);
}

interface GeneratedFragment {
  symbols: string[];
  /** The model's own average log probability for this path: boosts steer the search, they never inflate this. */
  averageLogProbability: number;
  /** The search's objective, which is the above with the required-symbol boosts applied. */
  score: number;
}

/**
 * Beam search over the interpolated distribution, with bracket structure as a hard constraint.
 *
 * Balance is the one property that is decidable without knowing the language and that almost every uncompilable
 * fragment violates, so hypotheses that close a bracket they never opened die immediately and a fragment only
 * finishes with everything it opened closed. That is a real reduction in what the compiler has to reject, not a
 * heuristic about what good code looks like.
 */
function beamGenerateFragment(input: {
  corpusModels: readonly KneserNeyModel[];
  localModel: KneserNeyModel;
  corpusWeight: number;
  prompt: readonly string[];
  boost: ReadonlyMap<string, number>;
  beamWidth: number;
  /** What may legally be named at the position the fragment starts at; unset means nothing bounds it. */
  firstSymbolVocabulary?: ReadonlySet<string>;
}): GeneratedFragment | undefined {
  type Beam = { symbols: string[]; logProbability: number; score: number };
  let beams: Beam[] = [{ symbols: [], logProbability: 0, score: 0 }];
  const finished: Beam[] = [];

  for (let step = 0; step < CANDIDATE_SYMBOL_LIMIT && beams.length; step++) {
    const next: Beam[] = [];
    for (const beam of beams) {
      const context = [...input.prompt, ...beam.symbols];
      for (const item of interpolatedPredictions(input, context)) {
        if (step === 0 && input.firstSymbolVocabulary && identifierLikeSymbol(item.symbol)
          && !input.firstSymbolVocabulary.has(item.symbol)) continue;
        const symbols = [...beam.symbols, item.symbol];
        // Self-contained: a fragment may close only what it opened itself. Balancing against the prompt instead
        // let a replacement close an enclosing block it was not replacing -- `return row.}` scored well because
        // the `}` legitimately closed the function two lines up, and the result was never valid at that position.
        const balance = codeBracketBalance(symbols);
        if (balance.underflow) continue;
        const boost = input.boost.get(item.symbol) ?? 1;
        const grown = {
          symbols,
          logProbability: beam.logProbability + Math.log(Math.max(1e-300, item.probability)),
          score: beam.score + Math.log(Math.max(1e-300, item.probability * boost))
        };
        if (FRAGMENT_TERMINALS.has(item.symbol)) {
          if (!balance.open.length && symbols.length > 1) finished.push(grown);
          continue;
        }
        next.push(grown);
      }
    }
    beams = next.sort(byNormalizedScore).slice(0, input.beamWidth);
    if (finished.length >= input.beamWidth) break;
  }

  const best = finished.sort(byNormalizedScore)[0];
  if (!best) return undefined;
  // The terminator is part of the statement when it is one, and merely the boundary when it is the line symbol.
  const symbols = best.symbols[best.symbols.length - 1] === CODE_LINE_SYMBOL ? best.symbols.slice(0, -1) : best.symbols;
  if (!symbols.length) return undefined;
  const length = Math.max(1, best.symbols.length);
  return { symbols, averageLogProbability: best.logProbability / length, score: best.score / length };
}

function byNormalizedScore(
  left: { symbols: string[]; score: number },
  right: { symbols: string[]; score: number }
): number {
  const leftScore = left.score / Math.max(1, left.symbols.length);
  const rightScore = right.score / Math.max(1, right.symbols.length);
  return rightScore - leftScore || left.symbols.join(" ").localeCompare(right.symbols.join(" "));
}

/**
 * The corpus model and the file's own model, mixed.
 *
 * Each model's pool is scored under both distributions rather than merged by rank, so a symbol only one of them
 * knows is still weighed against what the other would have given it.
 */
function interpolatedPredictions(
  input: { corpusModels: readonly KneserNeyModel[]; localModel: KneserNeyModel; corpusWeight: number },
  context: readonly string[]
): Array<{ symbol: string; probability: number }> {
  const localContext = context.slice(-(input.localModel.order - 1));
  const symbols = new Set<string>();
  for (const model of input.corpusModels) {
    for (const item of predictKneserNey(model, context.slice(-(model.order - 1)), PREDICTION_POOL)) symbols.add(item.symbol);
  }
  for (const item of predictKneserNey(input.localModel, localContext, PREDICTION_POOL)) symbols.add(item.symbol);
  const out: Array<{ symbol: string; probability: number }> = [];
  for (const symbol of symbols) {
    if (symbol === "<s>" || symbol === "<unk>" || symbol === "</s>") continue;
    const corpus = input.corpusModels.length
      ? input.corpusModels.reduce(
        (sum, model) => sum + kneserNeyProbability(model, context.slice(-(model.order - 1)), symbol),
        0
      ) / input.corpusModels.length
      : 0;
    const probability = input.corpusWeight * corpus
      + (1 - input.corpusWeight) * kneserNeyProbability(input.localModel, localContext, symbol);
    if (probability <= 0) continue;
    out.push({ symbol, probability });
  }
  return out
    .sort((left, right) => right.probability - left.probability || left.symbol.localeCompare(right.symbol))
    .slice(0, PREDICTION_POOL);
}

/**
 * What generation is pulled toward: the names the request or the retrieved API surface put in play.
 *
 * Deliberately not every name in the file. Those are already in the local model, normalised by how often they
 * actually occur; boosting them again double-counts the same evidence and flattens it, which measurably favoured
 * whichever name was most frequent over whichever was right (`row.string` for a file whose commonest identifiers
 * were its type names). A boost, never a constraint -- a symbol still has to be probable to be emitted.
 */
function boostedSymbols(required: readonly string[]): Map<string, number> {
  const boost = new Map<string, number>();
  for (const symbol of required) if (symbol.trim()) boost.set(symbol, 3.2);
  return boost;
}

/**
 * Which trained models represent the language.
 *
 * The corpus holds one model per source file and only a bounded mixture is affordable, so the choice of which
 * ones matters. Longest order first, because a shorter model answers a shorter question; then most observed
 * symbols, because a model built from more of the language is a better estimate of it than one built from less.
 * Both are properties of the model rather than of the store's return order, which keeps the mixture -- and every
 * composition that comes out of it -- the same from one run to the next as the corpus grows around it.
 */
function selectCorpusMixture(models: readonly KneserNeyModel[]): KneserNeyModel[] {
  return [...models]
    .sort((left, right) =>
      right.order - left.order
      || right.observedSymbolCount - left.observedSymbolCount
      || right.vocabularySize - left.vocabularySize)
    .slice(0, CORPUS_MODEL_MIXTURE_LIMIT);
}

/** A symbol that names something rather than punctuating it: the only class a symbol table has an opinion on. */
function identifierLikeSymbol(symbol: string): boolean {
  return /^[\p{Letter}_$]/u.test(symbol);
}

function clampUnit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : CODE_CORPUS_INTERPOLATION_WEIGHT;
}
