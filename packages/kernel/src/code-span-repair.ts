// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { kneserNeyProbability, predictKneserNey, type KneserNeyModel } from "./kneser-ney.js";
import { CODE_LINE_SYMBOL, codeBracketBalance, codeSurfaceTokens, renderCodeTokens } from "./code-surface.js";

/**
 * Composing the text that belongs in an exact hole.
 *
 * Line-scoped repair asks a generator to rewrite a whole statement in order to change one token. That is both a
 * harder composition than the defect warrants and a standing licence to delete things -- a gate that only asks
 * "does it compile" is satisfied by removing the code that failed to. A span removes both problems at once: what
 * lies outside it is preserved byte for byte, so the only question left is what stands where the defect stood.
 *
 * The search is the same one the prose lane runs, over the same interpolated distribution. What differs is where
 * it stops: a fragment filling a hole ends when it is structurally closed, not when it reaches a statement
 * terminator, because the text after the hole already supplies one.
 */

const CONTEXT_SYMBOLS = 48;
/** Compute budget on the beam, in symbols. Not a statement about how long a repair may be. */
const MAX_FRAGMENT_SYMBOLS = 24;
const PREDICTION_POOL = 24;
/** Half the pool, so what a toolchain admits is always reachable without being all the search can see. */
const ADMITTED_POOL_SHARE = 12;
/** How much a name the type system admits inside the hole is preferred over one it does not. */
const INSIDE_ADMITTED_PREFERENCE = 3.2;

export interface SpanFragment {
  symbols: string[];
  text: string;
  /** The model's own average log probability per symbol. A reported statistic, not the ranking. */
  averageLogProbability: number;
  /**
   * Total log probability of the whole filling under the models alone, which is what ranks it.
   *
   * Not an average: fillings of a hole differ in length, and averaging let a fluent three-token run outrank the
   * one correct token. A total charges for every extra symbol, so the shortest adequate filling wins unless the
   * evidence really supports a longer one.
   *
   * And not boosted. A boost is a multiplier applied at every symbol, so carrying it into the objective pays a
   * filling for being long: with each wanted name worth the same bonus, `title row` outscored `title` purely by
   * having two of them. The boost decides what the search explores; the model alone decides what wins.
   */
  score: number;
}

export interface SpanCompositionInput {
  corpusModels: readonly KneserNeyModel[];
  localModel: KneserNeyModel;
  corpusWeight: number;
  boost: ReadonlyMap<string, number>;
  beamWidth: number;
  /** Everything before the hole; its tail is what the composition continues from. */
  prefixText: string;
  /** Everything after the hole. Never rewritten, and what the fragment has to join onto. */
  suffixText: string;
  /** The text being replaced, whose token count sets how far past it the search is worth running. */
  originalText: string;
  /** Identifiers a toolchain admits where the hole opens; when given, no other identifier may open the filling. */
  admissible?: ReadonlySet<string>;
  /**
   * Identifiers a toolchain admits one position inside the hole.
   *
   * For a hole that opens a structure this is the interesting set and the one at the opening position is not:
   * inside `{ x: 0 }` typed as `Point`, the type system admits exactly `y`, which is the whole content of the
   * repair. Kept reachable and preferred at every step rather than only the first, because where a missing
   * member belongs in the literal is a question about the corpus, not about the type.
   */
  admissibleInside?: ReadonlySet<string>;
  /** How many distinct fillings to return, longest-odds first. */
  limit?: number;
}

/**
 * Every structurally complete filling the beam finds, best first.
 *
 * A hole has no single right length, so completeness is checked at every step rather than at a terminator: any
 * prefix of a hypothesis whose brackets balance is a candidate filling, and the ranked pool is what the repair
 * loop then spends its attempts on. Returning several is the point -- the compiler is a cheap oracle and the
 * loop already rolls back, so offering it three real hypotheses beats offering it one confident guess.
 */
export function composeSpanFillings(input: SpanCompositionInput): SpanFragment[] {
  const prompt = codeSurfaceTokens(input.prefixText).slice(-CONTEXT_SYMBOLS);
  const originalTokens = codeSurfaceTokens(input.originalText);
  // A repair may rewrite what the diagnostic named. It may not say less than it did.
  //
  // Scoping the edit to a span bounds where a filling may act, not what it may leave out, and the search finds
  // the difference: `add(1)` was filled with `(1)`, `titel` with nothing at all, and `"three"` with a bare
  // semicolon -- all structurally valid, all type-checking, all destroying the expression they were asked to
  // fix. The count is of value-bearing tokens rather than identifiers alone, because a literal carries a value
  // exactly as a name does and replacing one with punctuation is the same erasure.
  const requiredValues = originalTokens.filter(valueLike).length;
  // And it may not drop the shape either.
  //
  // Names alone were not enough: `add(1)` filled with `add` keeps its one name, type-checks, and quietly turns a
  // number into a function reference. What it dropped was the call. Every bracket the hole opened has to be
  // opened again, which is a structural claim and not a semantic guess -- literals stay replaceable, so a repair
  // may still turn `"three"` into `3`.
  const requiredBrackets = bracketCounts(originalTokens);
  // Where the toolchain names what may legally stand here and the hole opened with a name, the filling opens
  // with one of those names -- not merely with something that is not forbidden.
  const headMustBeAdmissible = Boolean(input.admissible?.size) && identifierLike(originalTokens[0] ?? "");
  // And it opens the way the hole opened.
  //
  // A structural claim, not a semantic one: an object literal is replaced by something that also starts by
  // opening a brace, a name by something that also starts with a name. Without it the search filled `{ x: 0 }`
  // with `; Point { x: number; }`, which balances, carries enough values, and is not an expression.
  const requiredOpening = tokenClass(originalTokens[0] ?? "");
  // Length is priced, not forbidden.
  //
  // A cap tied to the hole's own size is a guess about how much repair a defect needs, and a wrong guess makes
  // the right answer unreachable rather than unlikely: at three tokens of headroom `{ x: 0 }` could not express
  // `{ x: 0, y: 0 }` by one symbol, and no amount of evidence could have changed that. The objective already
  // charges for length -- every additional symbol multiplies in a probability below one -- so a longer filling
  // has to earn its extra tokens against every shorter one. What remains here is a compute budget on the search
  // and nothing more, which is why it is a constant of this module rather than a function of the input.
  const maxSymbols = MAX_FRAGMENT_SYMBOLS;
  const limit = Math.max(1, Math.min(8, Math.floor(input.limit ?? 4)));

  type Beam = { symbols: string[]; logProbability: number; score: number };
  let beams: Beam[] = [{ symbols: [], logProbability: 0, score: 0 }];
  const complete: Beam[] = [];

  for (let step = 0; step < maxSymbols && beams.length; step++) {
    const next: Beam[] = [];
    for (const beam of beams) {
      const context = [...prompt, ...beam.symbols];
      // At the opening position the admissible names are evaluated whether or not either model ranked them, so
      // a name the corpus has barely met is still reachable when the type system says it is the one that fits.
      const forced = step === 0 && input.admissible
        ? [...input.admissible, ...(input.admissibleInside ?? [])]
        : [...(input.admissibleInside ?? []), ...input.boost.keys()];
      for (const item of interpolatedPredictions(input, context, forced)) {
        if (step === 0 && input.admissible) {
          if (headMustBeAdmissible && !input.admissible.has(item.symbol)) continue;
          if (identifierLike(item.symbol) && !input.admissible.has(item.symbol)) continue;
        }
        // A hole is inline: the text after it is on the same line and stays there. A filling carrying a line
        // boundary splits the statement in two and the line-scoped operation then writes back only the first
        // half, which silently truncated `export const total = add(1);` to `export const total = add`.
        if (item.symbol === CODE_LINE_SYMBOL) continue;
        // An unterminated literal is a token the tokenizer produces at end of input and never valid to write.
        if (unterminatedLiteral(item.symbol)) continue;
        if (step === 0 && requiredOpening && tokenClass(item.symbol) !== requiredOpening) continue;
        const symbols = [...beam.symbols, item.symbol];
        const balance = codeBracketBalance(symbols);
        // A filling may not close a bracket it did not open: that bracket belongs to the text around the hole.
        if (balance.underflow) continue;
        const grown = {
          symbols,
          logProbability: beam.logProbability + Math.log(Math.max(1e-300, item.probability)),
          score: beam.score + Math.log(Math.max(1e-300, item.probability * (input.boost.get(item.symbol) ?? 1)))
        };
        if (!balance.open.length
          && symbols.filter(valueLike).length >= requiredValues
          && coversBrackets(bracketCounts(symbols), requiredBrackets)) {
          complete.push(grown);
        }
        next.push(grown);
      }
    }
    // Pruning compares hypotheses of equal depth, where the average and the total agree; ranking finished
    // fillings compares different lengths, where only the total is meaningful.
    beams = next.sort(byDepthScore).slice(0, input.beamWidth);
  }

  const seen = new Set<string>();
  const out: SpanFragment[] = [];
  for (const beam of complete.sort(byTotalProbability)) {
    const text = renderCodeTokens(beam.symbols);
    if (!text.trim() || seen.has(text)) continue;
    seen.add(text);
    const length = Math.max(1, beam.symbols.length);
    out.push({
      symbols: beam.symbols,
      text,
      averageLogProbability: beam.logProbability / length,
      score: beam.logProbability
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Hypotheses at one search depth have the same length, so their totals and averages order them identically. */
function byDepthScore(
  left: { symbols: string[]; score: number },
  right: { symbols: string[]; score: number }
): number {
  return right.score - left.score || left.symbols.join(" ").localeCompare(right.symbols.join(" "));
}

/**
 * Total log probability, not the per-symbol average.
 *
 * Averaging is right when the alternatives are the same length and wrong here, where they are not: it made a
 * fluent three-token run beat the single correct token, so `titel` was filled with `title : string` rather than
 * `title`. Every additional symbol multiplies in a probability below one, so the total prefers the shortest
 * filling that is adequate and only pays for extra length where the evidence genuinely supports it -- which is
 * exactly the preference a hole wants.
 */
function byTotalProbability(
  left: { symbols: string[]; logProbability: number },
  right: { symbols: string[]; logProbability: number }
): number {
  return right.logProbability - left.logProbability
    || left.symbols.join(" ").localeCompare(right.symbols.join(" "));
}

/**
 * The corpus mixture and the file's own model, mixed at the calibrated weight.
 *
 * `forced` names symbols that must be scored whether or not either model ranked them highly enough to appear in
 * its own top-K. Without it a boost is unreachable for exactly the symbols it exists to reach: `title` after
 * `row.` is rare in a general corpus and absent from a truncated pool, so the search never saw the one name the
 * type system had already said was the only legal one. Truncation then also weighs the boost, so a wanted symbol
 * survives it rather than being cut before the preference applies.
 */
function interpolatedPredictions(
  input: Pick<SpanCompositionInput, "corpusModels" | "localModel" | "corpusWeight" | "boost" | "admissibleInside">,
  context: readonly string[],
  forced: Iterable<string> = []
): Array<{ symbol: string; probability: number }> {
  const localContext = context.slice(-Math.max(0, input.localModel.order - 1));
  const required = new Set<string>(forced);
  const symbols = new Set<string>(required);
  for (const model of input.corpusModels) {
    for (const item of predictKneserNey(model, context.slice(-Math.max(0, model.order - 1)), PREDICTION_POOL)) {
      symbols.add(item.symbol);
    }
  }
  for (const item of predictKneserNey(input.localModel, localContext, PREDICTION_POOL)) symbols.add(item.symbol);
  const out: Array<{ symbol: string; probability: number }> = [];
  for (const symbol of symbols) {
    if (symbol === "<s>" || symbol === "<unk>" || symbol === "</s>") continue;
    const corpus = input.corpusModels.length
      ? input.corpusModels.reduce(
        (sum, model) => sum + kneserNeyProbability(model, context.slice(-Math.max(0, model.order - 1)), symbol),
        0
      ) / input.corpusModels.length
      : 0;
    const probability = input.corpusWeight * corpus
      + (1 - input.corpusWeight) * kneserNeyProbability(input.localModel, localContext, symbol);
    if (probability > 0) out.push({ symbol, probability });
  }
  // Forcing a symbol into the scoring and then truncating it out again is the same as never forcing it: `title`,
  // at a healthy 1.1e-2 and the only name the type system would accept, sat outside the top of a list a dozen
  // corpus models had filled and was cut before the search saw it. So the admitted names get a reserved share of
  // the pool -- but a share, not the pool: where the admissible set is the whole global scope, admitting all of
  // it unranked buries every real continuation under a hundred equally implausible ones.
  const weight = (symbol: string): number =>
    (input.boost.get(symbol) ?? 1) * (input.admissibleInside?.has(symbol) ? INSIDE_ADMITTED_PREFERENCE : 1);
  const ranked = out.sort((left, right) =>
    right.probability * weight(right.symbol) - left.probability * weight(left.symbol)
    || left.symbol.localeCompare(right.symbol));
  const admitted = ranked.filter(item => required.has(item.symbol)).slice(0, ADMITTED_POOL_SHARE);
  const rest = ranked.filter(item => !required.has(item.symbol));
  return [...admitted, ...rest.slice(0, Math.max(0, PREDICTION_POOL - admitted.length))];
}

/** How many of each opening bracket a token run introduces. */
function bracketCounts(symbols: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const symbol of symbols) {
    if (symbol === "(" || symbol === "[" || symbol === "{") counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
  }
  return counts;
}

function coversBrackets(present: ReadonlyMap<string, number>, required: ReadonlyMap<string, number>): boolean {
  for (const [bracket, count] of required) {
    if ((present.get(bracket) ?? 0) < count) return false;
  }
  return true;
}

function identifierLike(symbol: string): boolean {
  return /^[\p{Letter}_$]/u.test(symbol);
}

/**
 * What kind of thing a token is, for the one comparison a repair needs: does the filling open the way the hole
 * did. Three classes, all decidable from the token alone in any formal language.
 */
function tokenClass(symbol: string): "bracket" | "value" | "operator" | undefined {
  if (!symbol) return undefined;
  if (symbol === "(" || symbol === "[" || symbol === "{") return "bracket";
  if (valueLike(symbol)) return "value";
  return "operator";
}

/** A quote that never closed: what the tokenizer emits at end of input, and never something to write. */
function unterminatedLiteral(symbol: string): boolean {
  const quote = symbol.slice(0, 1);
  if (quote !== '"' && quote !== "'" && quote !== "`") return false;
  return symbol.length < 2 || !symbol.endsWith(quote);
}

/** A token that carries a value: a name, a number, or a delimited literal. Punctuation carries none. */
function valueLike(symbol: string): boolean {
  return /^[\p{Letter}\p{Number}_$"'`]/u.test(symbol);
}
