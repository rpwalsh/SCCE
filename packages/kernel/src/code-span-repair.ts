// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { kneserNeyProbability, predictKneserNey, type KneserNeyModel } from "./kneser-ney.js";
import { CODE_LINE_SYMBOL, codeBracketBalance, codeSurfaceTokens, renderCodeTokens } from "./code-surface.js";
import { applicableCodeConstructions, realizeCodeConstruction, type CodeConstruction } from "./code-construction-grammar.js";

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
/**
 * How many learned shapes are offered for one hole, and how many fillers are weighed for one of its slots.
 *
 * Offers are cheap in a way beam steps are not -- each is one realization of a shape the corpus already attests,
 * not a search -- and the build is what selects among them. Twelve was too few to reach the shapes that add
 * something: a construction one member longer than the hole ranks behind every rephrasing of it, and those are
 * exactly the repairs a missing member or a missing argument needs.
 */
const CONSTRUCTION_OFFERS = 32;
const SLOT_OPTIONS = 8;
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
  /**
   * Primitive types a signature says a call still wants an argument of.
   *
   * The only thing here that reaches a value rather than a name. A completion list enumerates what exists and a
   * missing numeric argument is not among them at any position, so `add(1)` could never reach `add(1, 2)` no
   * matter how the search was tuned. A literal of the declared type is admitted for that reason and no other.
   */
  expectedLiteralKinds?: ReadonlySet<string>;
  /** How many distinct fillings to return, longest-odds first. */
  limit?: number;
  /**
   * Learned shapes to fill the hole with, as an alternative to running the beam free.
   *
   * A beam predicts one symbol at a time and cannot hold a shape: it has no way to represent "an object literal
   * with one more member than this one has", so `{ x: 0 }` could never reach `{ x: 0, y: 0 }` however much
   * evidence there was, and the argument a call was missing was equally out of reach. A construction is that
   * shape -- induced from the corpus, with the positions that vary marked -- and filling one is a different move
   * from continuing a sequence. Both are offered; the build decides.
   */
  constructions?: readonly CodeConstruction[];
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

  // Both kinds of filling compete on one objective.
  //
  // A shape realized from a construction and a path found by the beam are scored the same way -- the models'
  // total log probability of the tokens -- so there is no reason to prefer one by provenance, and doing so was
  // actively harmful: offering shapes first let them consume the whole limit and crowded out beam fillings that
  // had been repairing files. Merged and ranked, each wins where it is actually the more likely thing to write.
  const pool: SpanFragment[] = constructionFillings(input, prompt);
  for (const beam of complete) {
    const text = renderCodeTokens(beam.symbols);
    if (!text.trim()) continue;
    const length = Math.max(1, beam.symbols.length);
    pool.push({
      symbols: beam.symbols,
      text,
      averageLogProbability: beam.logProbability / length,
      score: beam.logProbability
    });
  }
  const seen = new Set<string>();
  const out: SpanFragment[] = [];
  for (const filling of pool.sort((left, right) => right.score - left.score || left.text.localeCompare(right.text))) {
    if (seen.has(filling.text)) continue;
    seen.add(filling.text);
    out.push(filling);
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

/** Whether a token is a literal of a type the signature said it wants. */
function matchesExpectedLiteral(symbol: string, kinds: ReadonlySet<string> | undefined): boolean {
  if (!kinds?.size) return false;
  const first = symbol.slice(0, 1);
  if (kinds.has("number") && /\p{Number}/u.test(first)) return true;
  if (kinds.has("string") && (first === "\"" || first === "'" || first === "`")) return true;
  return kinds.has("boolean") && (symbol === "true" || symbol === "false");
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

/**
 * Fillings made by filling in a learned shape, rather than by continuing a sequence.
 *
 * The hole's own values are reused in the order it used them, because a repair keeps what the code already said;
 * positions the hole has nothing for are the ones being added, and those are chosen the way any symbol is
 * chosen -- by what the models make likely there, preferring what the type system admits inside the hole and
 * what the corpus has actually seen in that slot.
 *
 * One branch point, at the first added position. Enumerating every combination of every slot is a search whose
 * cost is the product of the slots and whose value is not, and the compiler is a cheap enough oracle that a
 * handful of real alternatives beats a thousand near-identical ones.
 */
function constructionFillings(input: SpanCompositionInput, prompt: readonly string[]): SpanFragment[] {
  const constructions = input.constructions ?? [];
  if (!constructions.length) return [];
  const originalTokens = codeSurfaceTokens(input.originalText);
  if (!originalTokens.length) return [];
  const holeValues = originalTokens.filter(valueLike);
  const requiredValues = holeValues.length;
  const requiredBrackets = bracketCounts(originalTokens);
  const out: SpanFragment[] = [];
  const seen = new Set<string>();

  for (const construction of applicableCodeConstructions(constructions, originalTokens, CONSTRUCTION_OFFERS)) {
    for (const branch of [0, 1]) {
      const fillers = new Map<number, string>();
      let branched = false;
      let usable = true;
      for (const slot of construction.slots) {
        const reused = holeValues[slot.index];
        if (reused !== undefined) {
          fillers.set(slot.index, reused);
          continue;
        }
        // The tokens already decided, so a filler is scored where it would actually stand. A whole realization
        // is impossible while slots remain unfilled, so the prefix is walked directly.
        const context = [...prompt, ...realizedPrefix(construction, fillers)];
        const options = rankedSlotFillers(input, context, slot.observed);
        const pick = options[branched || branch === 0 ? 0 : Math.min(1, options.length - 1)];
        if (!pick) { usable = false; break; }
        if (branch === 1 && !branched) branched = true;
        fillers.set(slot.index, pick);
      }
      if (!usable) continue;
      const symbols = realizeCodeConstruction(construction, fillers);
      if (!symbols || !symbols.length) continue;
      const balance = codeBracketBalance(symbols);
      if (balance.underflow || balance.open.length) continue;
      if (symbols.filter(valueLike).length < requiredValues) continue;
      if (!coversBrackets(bracketCounts(symbols), requiredBrackets)) continue;
      if (tokenClass(symbols[0] ?? "") !== tokenClass(originalTokens[0] ?? "")) continue;
      const text = renderCodeTokens(symbols);
      if (!text.trim() || text === input.originalText || seen.has(text)) continue;
      seen.add(text);
      const logProbability = sequenceLogProbability(input, prompt, symbols);
      out.push({
        symbols,
        text,
        averageLogProbability: logProbability / Math.max(1, symbols.length),
        score: logProbability
      });
    }
  }
  return out;
}

/**
 * What may stand in a slot, best first.
 *
 * The shape comes from the construction and the filler comes from the models, which is the same division the
 * beam already runs on -- so the candidates are the same ones the beam would weigh here, together with what the
 * type system admits inside the hole and what the corpus has actually seen in this slot. Restricting it to those
 * last two could not reach a literal at all: nothing offers `2` as a completion and no slot's commonest fillers
 * are numbers, so a call missing a numeric argument was unrepairable by construction.
 */
function rankedSlotFillers(
  input: SpanCompositionInput,
  context: readonly string[],
  observed: readonly string[]
): string[] {
  const candidates = new Set<string>([
    ...(input.admissibleInside ?? []),
    ...observed.slice(0, SLOT_OPTIONS * 2),
    ...interpolatedPredictions(input, context).map(item => item.symbol)
  ]);
  const admitted = input.admissibleInside;
  return [...candidates]
    // A slot is a value position by construction -- the signature that grouped these spans marked exactly the
    // places a name, number or literal stood -- so punctuation is not a filler for one. Without this the models'
    // own top predictions put a separator in the slot and composed `add(1,)`.
    .filter(symbol => symbol && valueLike(symbol) && !unterminatedLiteral(symbol))
    .map(symbol => ({
      symbol,
      weight: symbolProbability(input, context, symbol)
        * (admitted?.has(symbol) ? INSIDE_ADMITTED_PREFERENCE : 1)
        * (matchesExpectedLiteral(symbol, input.expectedLiteralKinds) ? INSIDE_ADMITTED_PREFERENCE : 1)
    }))
    .sort((left, right) => right.weight - left.weight || left.symbol.localeCompare(right.symbol))
    .slice(0, SLOT_OPTIONS)
    .map(row => row.symbol);
}

/** The construction's tokens up to its first unfilled slot: where the next filler would actually stand. */
function realizedPrefix(construction: CodeConstruction, fillers: ReadonlyMap<number, string>): string[] {
  const out: string[] = [];
  for (const part of construction.parts) {
    if (part.kind === "literal") {
      out.push(part.surface ?? "");
      continue;
    }
    const filler = fillers.get(part.slot ?? -1);
    if (filler === undefined) break;
    out.push(filler);
  }
  return out;
}

/** One symbol's interpolated probability in a context, the same mixture the beam samples from. */
function symbolProbability(
  input: Pick<SpanCompositionInput, "corpusModels" | "localModel" | "corpusWeight">,
  context: readonly string[],
  symbol: string
): number {
  const corpus = input.corpusModels.length
    ? input.corpusModels.reduce(
      (sum, model) => sum + kneserNeyProbability(model, context.slice(-Math.max(0, model.order - 1)), symbol),
      0
    ) / input.corpusModels.length
    : 0;
  const local = kneserNeyProbability(input.localModel, context.slice(-Math.max(0, input.localModel.order - 1)), symbol);
  return input.corpusWeight * corpus + (1 - input.corpusWeight) * local;
}

/** A realized shape scored on the same objective a generated one is: the model's own total, unboosted. */
function sequenceLogProbability(
  input: SpanCompositionInput,
  prompt: readonly string[],
  symbols: readonly string[]
): number {
  let total = 0;
  const context = [...prompt];
  for (const symbol of symbols) {
    total += Math.log(Math.max(1e-300, symbolProbability(input, context, symbol)));
    context.push(symbol);
  }
  return total;
}
