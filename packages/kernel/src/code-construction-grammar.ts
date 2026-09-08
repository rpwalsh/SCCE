// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { codeSurfaceTokens } from "./code-surface.js";
import { createClock, createHasher } from "./primitives.js";
import { createIdFactory } from "./ids.js";

/**
 * Constructions induced from what code is shaped like, rather than from what a sentence is shaped like.
 *
 * The corpus lane already induces constructions over the code token stream, and they are unusable: its slots
 * come from `induceSemanticFrames`, which finds a predicate and takes what sits either side of it. That is
 * subject-verb-object reasoning, correct for prose and meaningless for a token stream -- it yielded a
 * construction whose two variable positions were `const` and `kernel`, which are not the parts of that code that
 * vary. Nothing built on those slots can compose anything.
 *
 * What varies in code is what brackets contain. An argument list, an object literal, an index, a block: each is
 * a balanced span whose contents differ between occurrences while its punctuation does not. Grouping spans by
 * that punctuation and anti-unifying the members recovers exactly the positions that vary, which is what a slot
 * is. No grammar is written down and no language is assumed beyond brackets pairing -- everything else is read
 * off the corpus.
 */

const CONSTRUCTION_ID_FACTORY = createIdFactory({
  clock: createClock({ fixedTime: 0, stepMs: 1 }),
  hasher: createHasher(),
  deterministicReplay: true,
  namespace: "code-construction-grammar"
});

const OPENING = new Map([["(", ")"], ["[", "]"], ["{", "}"]]);
const CLOSING = new Set([")", "]", "}"]);
/** A token that stands for a thing rather than punctuating one; these are the positions that vary. */
const VALUE = /^[\p{Letter}\p{Number}_$"'`]/u;
/** What a slot is written as in a shape signature. */
const SLOT_MARK = "";

export interface CodeConstructionPart {
  kind: "literal" | "slot";
  /** The exact token, for a literal. */
  surface?: string;
  /** Which slot this position fills, for a slot. */
  slot?: number;
}

export interface CodeConstructionSlot {
  index: number;
  /** Every filler seen in this position, most frequent first. What the corpus says may stand here. */
  observed: string[];
}

export interface CodeConstruction {
  id: string;
  /** Literal tokens and slots, in order. Rendering is the caller's; this is the token program. */
  parts: CodeConstructionPart[];
  slots: CodeConstructionSlot[];
  /** How many occurrences it was induced from, and how many distinct documents those came from. */
  occurrences: number;
  documents: number;
  /** Token length of one realization, which is fixed: same signature, same length. */
  length: number;
}

export interface CodeConstructionInductionInput {
  documents: ReadonlyArray<{ id: string; text?: string; tokens?: readonly string[] }>;
  /** Distinct documents a shape must appear in before it counts as the language's rather than one file's. */
  minimumDocuments?: number;
  minimumOccurrences?: number;
  /** Longest span considered, in tokens. Longer spans are the bodies that contain the shapes worth learning. */
  maximumLength?: number;
  limit?: number;
}

/**
 * Every recurring bracketed shape in a corpus, with the positions that vary marked as slots.
 *
 * A shape has to recur across documents to be admitted: one file's habits are that file's, and a construction
 * that only ever appeared in the place it was induced from can compose nothing that was not already there.
 */
export function induceCodeConstructions(input: CodeConstructionInductionInput): CodeConstruction[] {
  const minimumDocuments = Math.max(1, Math.floor(input.minimumDocuments ?? 2));
  const minimumOccurrences = Math.max(2, Math.floor(input.minimumOccurrences ?? 2));
  const maximumLength = Math.max(3, Math.min(64, Math.floor(input.maximumLength ?? 24)));
  const limit = Math.max(1, Math.min(4096, Math.floor(input.limit ?? 512)));

  const groups = new Map<string, { members: string[][]; documents: Set<string> }>();
  for (const document of input.documents) {
    const tokens = document.tokens ?? codeSurfaceTokens(document.text ?? "");
    for (const span of bracketedSpans(tokens, maximumLength)) {
      const signature = shapeSignature(span);
      const group = groups.get(signature) ?? { members: [], documents: new Set<string>() };
      group.members.push(span);
      group.documents.add(document.id);
      groups.set(signature, group);
    }
  }

  const out: CodeConstruction[] = [];
  for (const [signature, group] of groups) {
    if (group.documents.size < minimumDocuments || group.members.length < minimumOccurrences) continue;
    const construction = antiUnifySpans(signature, group.members, group.documents.size);
    if (construction) out.push(construction);
  }
  return out
    .sort((left, right) =>
      right.documents - left.documents
      || right.occurrences - left.occurrences
      || left.length - right.length
      || left.id.localeCompare(right.id))
    .slice(0, limit);
}

/**
 * One construction realized: its literals, and a filler for each slot.
 *
 * Returns the token stream rather than text, because what may follow a token is the question the corpus models
 * answer and rendering is a separate concern.
 */
export function realizeCodeConstruction(
  construction: CodeConstruction,
  fillers: ReadonlyMap<number, string>
): string[] | undefined {
  const out: string[] = [];
  for (const part of construction.parts) {
    if (part.kind === "literal") {
      out.push(part.surface ?? "");
      continue;
    }
    const filler = fillers.get(part.slot ?? -1);
    if (filler === undefined || !filler) return undefined;
    out.push(filler);
  }
  return out;
}

/**
 * The constructions that could stand where a hole is, best fit first.
 *
 * Two things decide fit, and neither is popularity. A filling has to be able to keep the structure the hole
 * already had, so the hole's punctuation must appear in the construction's literals in the same order -- that is
 * the ordered form of the rule that a repair may not drop a bracket. And it has to be near the hole in size,
 * because a construction much longer than what it replaces is a rewrite. Ranking by how many documents attest a
 * shape instead put `<0> ( <1> )` and `<0> [ ]` ahead of `<0> ( <1> , <2> )` for a call missing an argument,
 * which is the one construction that could have repaired it.
 */
export function applicableCodeConstructions(
  constructions: readonly CodeConstruction[],
  holeTokens: readonly string[],
  limit = 8
): CodeConstruction[] {
  const opening = holeTokens[0];
  if (!opening) return [];
  const holeIsValue = VALUE.test(opening);
  const holePunctuation = holeTokens.filter(token => !VALUE.test(token));
  const scored: Array<{ construction: CodeConstruction; distance: number }> = [];
  for (const construction of constructions) {
    const first = construction.parts[0];
    if (!first) continue;
    const firstIsValue = first.kind === "slot" || VALUE.test(first.surface ?? "");
    if (firstIsValue !== holeIsValue) continue;
    if (first.kind === "literal" && first.surface !== opening) continue;
    const literals = construction.parts.flatMap(part => (part.kind === "literal" ? [part.surface ?? ""] : []));
    if (!containsInOrder(literals, holePunctuation)) continue;
    // Same length is a rephrasing, longer is an addition, shorter is a loss; loss is the one to rank last.
    const delta = construction.length - holeTokens.length;
    scored.push({ construction, distance: delta < 0 ? 100 - delta : delta });
  }
  return scored
    .sort((left, right) =>
      left.distance - right.distance
      || right.construction.documents - left.construction.documents
      || left.construction.id.localeCompare(right.construction.id))
    .slice(0, Math.max(1, limit))
    .map(row => row.construction);
}

/** Whether every token of `required` appears in `sequence`, in order. */
function containsInOrder(sequence: readonly string[], required: readonly string[]): boolean {
  let at = 0;
  for (const token of required) {
    const found = sequence.indexOf(token, at);
    if (found < 0) return false;
    at = found + 1;
  }
  return true;
}

/**
 * Balanced bracketed spans, each with the token that introduces it.
 *
 * The head matters: `f ( a , b )` and `if ( a , b )` are different constructions even though their brackets are
 * identical, and the corpus is what says which heads take which shapes.
 */
function bracketedSpans(tokens: readonly string[], maximumLength: number): string[][] {
  const out: string[][] = [];
  const open: number[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (OPENING.has(token)) {
      open.push(index);
      continue;
    }
    if (!CLOSING.has(token)) continue;
    const start = open.pop();
    if (start === undefined) continue;
    if (OPENING.get(tokens[start]!) !== token) continue;
    // The head is the token before the bracket when it names something; `(` alone is a grouping, `f(` is a call.
    const headIndex = start > 0 && VALUE.test(tokens[start - 1]!) ? start - 1 : start;
    const span = tokens.slice(headIndex, index + 1);
    if (span.length >= 3 && span.length <= maximumLength) out.push(span);
  }
  return out;
}

/** Values replaced by a mark, punctuation kept. Two spans share a signature when they differ only in what they name. */
function shapeSignature(span: readonly string[]): string {
  return span.map(token => (VALUE.test(token) ? SLOT_MARK : token)).join(" ");
}

/**
 * Position-wise anti-unification: where every member agrees, a literal; where they differ, a slot.
 *
 * Members of one signature group have equal length by construction, so the general alignment problem does not
 * arise -- the signature preserves punctuation positionally and marks everything else.
 */
function antiUnifySpans(signature: string, members: readonly string[][], documents: number): CodeConstruction | undefined {
  const length = members[0]?.length ?? 0;
  if (!length || members.some(member => member.length !== length)) return undefined;
  const parts: CodeConstructionPart[] = [];
  const slots: CodeConstructionSlot[] = [];
  for (let position = 0; position < length; position++) {
    const values = members.map(member => member[position]!);
    const distinct = new Set(values);
    if (distinct.size === 1) {
      parts.push({ kind: "literal", surface: values[0]! });
      continue;
    }
    const index = slots.length;
    slots.push({ index, observed: rankedByFrequency(values) });
    parts.push({ kind: "slot", slot: index });
  }
  // A construction with no slot is a quotation, not a template: it can only ever emit what it was induced from.
  if (!slots.length) return undefined;
  return {
    id: CONSTRUCTION_ID_FACTORY.semanticId("code_construction", { signature, length, slots: slots.length }),
    parts,
    slots,
    occurrences: members.length,
    documents,
    length
  };
}

function rankedByFrequency(values: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([value]) => value);
}
