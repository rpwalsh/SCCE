// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { isSurfaceUnitChar, splitSurfaceSentences, surfaceWords } from "./surface-linguistics.js";
import { surfaceEntityRuns } from "./kernel-answer-primitives.js";
import type { JsonValue } from "./types.js";

/**
 * The relation channel prose has never had.
 *
 * `structured-semantic-candidate.ts` reads `metadata.weakFreeSurfaceRelations` and turns each entry into an
 * `opaque_induced_relation` candidate on the `weak_free_surface` channel, which then flows through the same
 * promotion model and graph projection every other channel uses. That consumer has existed with one test and zero
 * producers, so the channel was designed and never fed. Measured on the live brain: 1.68M graph nodes over 22,259
 * Wikipedia sources, of which the dominant kind is one node per bigram (`{"feature":"bi:appointed|headmistress"}`),
 * and no subject-predicate-object triple derived from prose anywhere. This is the producer.
 *
 * WHAT THIS DELIBERATELY IS NOT: a parser. There is no part-of-speech table, no verb list, no grammar for any
 * language, and no dependency tree, because this repository does not hardcode the linguistics of one language and a
 * relation extractor that only worked on English would be worse than none. What is used instead is structure that
 * survives translation:
 *
 *   - an entity run is a maximal run of naming-signal words, which `surfaceEntityRuns` already computes;
 *   - a value is a numeric token, optionally with the tokens that trail it (a unit);
 *   - the predicate surface is whatever lies between two arguments, taken verbatim and normalized only for case and
 *     whitespace.
 *
 * A relation is therefore observed, not understood: the claim is "these two arguments were separated by this surface
 * in this sentence", which is exactly the "opaque induced relation" the candidate kind already names. Whether it is
 * true, and whether it means the same thing as another relation with a different surface, is decided downstream by
 * the promotion model's independent-corroboration rule, not here. That division is the point -- this layer must not
 * be the place where truth is decided.
 *
 * Support is deliberately low. `weak_free_surface` candidates default to 0.25 and nothing here exceeds that band,
 * because a surface co-occurrence is the weakest evidence for a relation that this system admits at all.
 */

/** How far apart two arguments may sit, in words, and still plausibly be related by the surface between them. */
const MAX_PREDICATE_WORDS = 6;

/** A predicate surface longer than this is a clause, not a relation, and joining across it invents structure. */
const MAX_PREDICATE_CHARS = 64;

/** Sentences beyond this are apparatus or tables; the relation channel reads prose. */
const MAX_SENTENCE_CHARS = 600;

export interface ProseRelationArgument {
  /** The argument exactly as the sentence writes it. */
  surface: string;
  /** `entity` for a naming run, `value` for a numeric token and any unit trailing it. */
  role: "entity" | "value";
}

export interface ProseRelation {
  subject: ProseRelationArgument;
  object: ProseRelationArgument;
  /** The verbatim surface between the two arguments, normalized for case and whitespace only. */
  predicateSurface: string;
  /** The sentence this was observed in, so a reader can check the claim against its own source. */
  sentence: string;
  support: number;
}

/**
 * Relations observable in one document's prose, as `weakFreeSurfaceRelations` entries.
 *
 * The returned shape is what `structuredSemanticCandidates` already consumes: participants, an observable structure,
 * a support number, and the assumptions and transformations this extraction made, recorded so a reviewer can see
 * exactly what was assumed rather than inferring it from the output.
 */
export function proseRelationMetadata(text: string, options: { maxRelations?: number } = {}): JsonValue {
  const relations = proseRelations(text, options);
  if (!relations.length) return [];
  return relations.map(relation => ({
    participants: [
      { value: relation.subject.surface, valueKind: relation.subject.role },
      { value: relation.object.surface, valueKind: relation.object.role }
    ],
    // Identity, not occurrence: the predicate surface recurs across documents and is what makes this relation this
    // relation, while the sentence is unique to one occurrence and belongs in anchors. Putting the sentence here
    // would give every relation its own seed and nothing would ever reach the independence promotion asks for.
    structure: {
      predicateSurface: relation.predicateSurface,
      arity: 2
    },
    support: relation.support,
    anchors: [{ id: "anchor.prose_sentence", text: relation.sentence }],
    assumptions: [
      { id: "assumption.adjacent_arguments_are_related" },
      { id: "assumption.intervening_surface_is_the_predicate" }
    ],
    transformations: [{ id: "transform.surface_case_and_whitespace_only" }],
    alternatives: [{ participantOrder: [1, 0] }]
  })) as unknown as JsonValue;
}

/** Every relation the prose of `text` observably states, ordered by the sentence they appear in. Pure. */
export function proseRelations(text: string, options: { maxRelations?: number } = {}): ProseRelation[] {
  const maxRelations = Math.max(1, Math.min(2_000, Math.floor(options.maxRelations ?? 400)));
  const out: ProseRelation[] = [];
  for (const sentence of splitSurfaceSentences(text)) {
    if (sentence.length > MAX_SENTENCE_CHARS) continue;
    for (const relation of sentenceRelations(sentence)) {
      out.push(relation);
      if (out.length >= maxRelations) return out;
    }
  }
  return out;
}

/**
 * The relations one sentence states, read from the order its arguments appear in.
 *
 * Arguments are located by position, then paired with their immediate successor. Pairing only adjacent arguments is
 * what keeps this from inventing structure: in "A worked with B on C", the observable claims are (A, B) and (B, C),
 * and asserting (A, C) would be a composition this layer has no basis for. Composition is the graph's job.
 */
function sentenceRelations(sentence: string): ProseRelation[] {
  const args = sentenceArguments(sentence);
  if (args.length < 2) return [];
  const out: ProseRelation[] = [];
  for (let index = 0; index + 1 < args.length; index++) {
    const left = args[index]!;
    const right = args[index + 1]!;
    const between = sentence.slice(left.end, right.start);
    const predicateSurface = normalizePredicate(between);
    if (!predicateSurface) continue;
    if (predicateSurface.length > MAX_PREDICATE_CHARS) continue;
    // A predicate needs lexical content. Two names separated by nothing but a comma or a dash are a list or a
    // range -- "Smith, Jones", "1997-2001" -- and the surface between them asserts no relation. Measured on 16
    // corpus documents without this guard, the only relations that recurred across enough independent sources to
    // promote were "'", ",", "-" and ", '": the promotion gate was doing its job on evidence that was punctuation.
    // surfaceWords counts a bare apostrophe as a word, so the test is for a unit character -- a letter or a digit
    const predicateWords = surfaceWords(predicateSurface);
    if (predicateWords.length > MAX_PREDICATE_WORDS) continue;
    if (![...predicateSurface].some(isSurfaceUnitChar)) continue;
    out.push({
      subject: { surface: left.surface, role: left.role },
      object: { surface: right.surface, role: right.role },
      predicateSurface,
      sentence,
      // A value argument is a stronger signal than two adjacent names: "X decomposes at 417" states a measurement,
      // while two names beside each other are often a list. Still inside the weak band either way.
      support: right.role === "value" || left.role === "value" ? 0.25 : 0.18
    });
  }
  return out;
}

interface PositionedArgument extends ProseRelationArgument {
  start: number;
  end: number;
}

/** Entity runs and numeric values in the order they occur, non-overlapping, earliest first. Pure. */
function sentenceArguments(sentence: string): PositionedArgument[] {
  const found: PositionedArgument[] = [];
  for (const run of surfaceEntityRuns(sentence)) {
    const at = sentence.indexOf(run);
    if (at < 0) continue;
    found.push({ surface: run, role: "entity", start: at, end: at + run.length });
  }
  for (const match of sentence.matchAll(/\d[\d,.]*/gu)) {
    const start = match.index ?? 0;
    // A number ends at its last digit: a trailing separator is the sentence's punctuation, not part of the value.
    const raw = match[0].replace(/[^0-9]+$/u, "");
    if (!raw) continue;
    // A unit is whatever word follows the number, taken verbatim: "degrees", "metres", "%" are units in their own
    // languages and none of them needs a table here. Only one word, so "417 degrees Celsius later that year" does not
    // swallow the clause.
    const after = sentence.slice(start + raw.length);
    const unit = after.match(/^\s*[\p{L}%°][\p{L}\p{N}%°]*/u)?.[0] ?? "";
    found.push({
      surface: `${raw}${unit}`.trim(),
      role: "value",
      start,
      end: start + raw.length + unit.length
    });
  }
  return found
    .sort((left, right) => left.start - right.start || right.end - left.end)
    .filter((argument, index, all) => index === 0 || argument.start >= all[index - 1]!.end);
}

/** Case- and whitespace-normalized, with nothing else changed: the predicate is the source's own words. Pure. */
function normalizePredicate(between: string): string {
  const clean = between.replace(/\s+/gu, " ").trim().toLocaleLowerCase();
  // A boundary inside the gap means the two arguments are in different clauses or different sentences.
  if (/[.!?;:()[\]{}"]/u.test(clean)) return "";
  return clean;
}
