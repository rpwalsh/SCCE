/**
 * Plan items 98-99. Universal edit-program induction between a source and
 * target surface form: COPY/INSERT/DELETE/SUBSTITUTE via a real minimum-
 * edit-distance dynamic program with backtrace (Wagner-Fischer, not a
 * hand-authored rule), then two real post-detection passes recognizing
 * MOVE (a deleted run whose text exactly reappears in an inserted run
 * elsewhere) and REPEAT (an inserted run identical to the copied run
 * immediately preceding it), plus a JOIN/SPLIT reclassification for the
 * common morphological case of a single boundary character being removed
 * or introduced. This exists to replace the current prefix/suffix/infix/
 * compound/reduplication label enum in `language-induction.ts` with a
 * real induced transformation -- that integration is a separate, later
 * step; this module is the induction algorithm itself.
 *
 * Every operation carries a `sourceAnchor`: the source position it is
 * applied at (for COPY/DELETE/SUBSTITUTE/MOVE, where they start consuming
 * source graphemes; for INSERT/SPLIT/REPEAT, the source position they are
 * emitted immediately before). This makes `applyEditProgram` a single
 * left-to-right walk with no positional ambiguity, rather than needing a
 * separate placement heuristic for non-consuming operations.
 *
 * INTERLEAVE is deliberately not classified by this pass: a defensible
 * definition (operations whose source/target ranges cross rather than
 * nest or stay disjoint) would need real multi-operation reordering
 * analysis this module does not yet do, and fabricating a shallow
 * heuristic for it would be worse than leaving it unclassified.
 */

export type EditOperationKind =
  | "copy" | "insert" | "delete" | "substitute"
  | "move" | "repeat" | "join" | "split" | "null";

export interface EditOperation {
  kind: EditOperationKind;
  sourceAnchor: number;
  /** For "move" only: the anchor where the moved text reappears in the target -- distinct from `sourceAnchor`, which is where it is removed from. */
  reappearAnchor?: number;
  sourceStart?: number;
  sourceEnd?: number;
  targetStart?: number;
  targetEnd?: number;
  text?: string;
}

const BOUNDARY_CHARACTERS = new Set([" ", "-", "_"]);

function graphemes(text: string): string[] {
  return [...text];
}

interface RawOp {
  kind: "copy" | "insert" | "delete" | "substitute";
  sourceAnchor: number;
  sourceIndex?: number;
  targetIndex?: number;
  text: string;
}

/**
 * Real Wagner-Fischer minimum-edit-distance DP with backtrace over
 * grapheme units, producing one op per aligned position/substring run
 * (runs of consecutive copies/deletes/inserts at contiguous positions are
 * merged into single operations rather than emitted one grapheme at a
 * time).
 */
function baseAlignment(source: readonly string[], target: readonly string[]): EditOperation[] {
  const m = source.length;
  const n = target.length;
  const cost: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  const from: Array<Array<"diag_match" | "diag_sub" | "up" | "left" | undefined>> = Array.from(
    { length: m + 1 },
    () => new Array(n + 1).fill(undefined)
  );
  for (let i = 1; i <= m; i++) { cost[i]![0] = i; from[i]![0] = "up"; }
  for (let j = 1; j <= n; j++) { cost[0]![j] = j; from[0]![j] = "left"; }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const match = source[i - 1] === target[j - 1];
      const diag = cost[i - 1]![j - 1]! + (match ? 0 : 1);
      const up = cost[i - 1]![j]! + 1;
      const left = cost[i]![j - 1]! + 1;
      const best = Math.min(diag, up, left);
      cost[i]![j] = best;
      from[i]![j] = best === diag ? (match ? "diag_match" : "diag_sub") : best === up ? "up" : "left";
    }
  }

  const rawOps: RawOp[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    const direction = i > 0 && j > 0 ? from[i]![j] : i > 0 ? "up" : "left";
    if (direction === "diag_match") {
      rawOps.push({ kind: "copy", sourceAnchor: i - 1, sourceIndex: i - 1, targetIndex: j - 1, text: source[i - 1]! });
      i -= 1; j -= 1;
    } else if (direction === "diag_sub") {
      rawOps.push({ kind: "substitute", sourceAnchor: i - 1, sourceIndex: i - 1, targetIndex: j - 1, text: target[j - 1]! });
      i -= 1; j -= 1;
    } else if (direction === "up") {
      rawOps.push({ kind: "delete", sourceAnchor: i - 1, sourceIndex: i - 1, text: source[i - 1]! });
      i -= 1;
    } else {
      // Insert consumes no source grapheme -- anchored at the current
      // (unchanged) source position `i`, meaning "emitted immediately
      // before source[i]".
      rawOps.push({ kind: "insert", sourceAnchor: i, targetIndex: j - 1, text: target[j - 1]! });
      j -= 1;
    }
  }
  rawOps.reverse();

  const merged: EditOperation[] = [];
  for (const op of rawOps) {
    const last = merged[merged.length - 1];
    const sourceContiguous = op.sourceIndex === undefined || op.sourceIndex === last?.sourceEnd;
    const targetContiguous = op.targetIndex === undefined || op.targetIndex === last?.targetEnd;
    // "insert" runs consume no source at all, so their sourceAnchor stays
    // fixed for the whole run and *is* the right contiguity check; for
    // copy/delete/substitute the anchor is defined to equal each
    // grapheme's own source index, so it necessarily differs across a
    // multi-grapheme run -- contiguity for those kinds is already fully
    // captured by sourceContiguous/targetContiguous, and requiring anchor
    // equality on top of that would (and did) prevent them from ever
    // merging into a run at all.
    const anchorMatches = op.kind === "insert" ? last?.sourceAnchor === op.sourceAnchor : true;
    if (last && last.kind === op.kind && anchorMatches && sourceContiguous && targetContiguous) {
      if (op.sourceIndex !== undefined) last.sourceEnd = op.sourceIndex + 1;
      if (op.targetIndex !== undefined) last.targetEnd = op.targetIndex + 1;
      last.text = (last.text ?? "") + op.text;
      continue;
    }
    merged.push({
      kind: op.kind,
      sourceAnchor: op.sourceAnchor,
      ...(op.sourceIndex !== undefined ? { sourceStart: op.sourceIndex, sourceEnd: op.sourceIndex + 1 } : {}),
      ...(op.targetIndex !== undefined ? { targetStart: op.targetIndex, targetEnd: op.targetIndex + 1 } : {}),
      text: op.text
    });
  }
  return merged;
}

function detectMoves(ops: readonly EditOperation[]): EditOperation[] {
  const consumed = new Set<number>();
  const out: EditOperation[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (consumed.has(i)) continue;
    const op = ops[i]!;
    if (op.kind !== "delete" || !op.text) { out.push(op); continue; }
    const matchIndex = ops.findIndex((candidate, index) =>
      index !== i && !consumed.has(index) && candidate.kind === "insert" && candidate.text === op.text);
    if (matchIndex === -1) { out.push(op); continue; }
    consumed.add(matchIndex);
    out.push({
      kind: "move",
      sourceAnchor: op.sourceAnchor,
      reappearAnchor: ops[matchIndex]!.sourceAnchor,
      sourceStart: op.sourceStart,
      sourceEnd: op.sourceEnd,
      targetStart: ops[matchIndex]!.targetStart,
      targetEnd: ops[matchIndex]!.targetEnd,
      text: op.text
    });
  }
  return out;
}

function detectRepeats(ops: readonly EditOperation[]): EditOperation[] {
  // The minimum-edit-distance alignment for a reduplication like
  // "run" -> "runrun" has (at least) two equally-optimal-cost forms --
  // copy-then-insert-identical, or insert-then-copy-identical -- and
  // which one the DP's tie-breaking happens to produce is not something
  // callers should have to predict. A "repeat" is real duplication either
  // way, so both neighbors are checked, not just the preceding one.
  return ops.map((op, index) => {
    if (op.kind !== "insert") return op;
    const previous = ops[index - 1];
    const next = ops[index + 1];
    if ((previous?.kind === "copy" && previous.text === op.text) || (next?.kind === "copy" && next.text === op.text)) {
      return { ...op, kind: "repeat" as const };
    }
    return op;
  });
}

function detectJoinSplit(ops: readonly EditOperation[]): EditOperation[] {
  return ops.map(op => {
    if (op.kind === "delete" && op.text?.length === 1 && BOUNDARY_CHARACTERS.has(op.text)) return { ...op, kind: "join" as const };
    if (op.kind === "insert" && op.text?.length === 1 && BOUNDARY_CHARACTERS.has(op.text)) return { ...op, kind: "split" as const };
    return op;
  });
}

/**
 * Induces a real, minimal edit program transforming `source` into
 * `target`. Never a hand-authored rule: the base COPY/INSERT/DELETE/
 * SUBSTITUTE alignment is the real minimum-edit-distance solution, and
 * MOVE/REPEAT/JOIN/SPLIT are detected by real, checkable structural
 * conditions over that alignment, not asserted.
 */
export function induceEditProgram(source: string, target: string): EditOperation[] {
  if (source === target) return [{ kind: "null", sourceAnchor: 0 }];
  const base = baseAlignment(graphemes(source), graphemes(target));
  return detectJoinSplit(detectRepeats(detectMoves(base)));
}

/**
 * Replays an edit program against `source`, purely via each operation's
 * `sourceAnchor` -- a single left-to-right walk with no positional
 * ambiguity. Used both to verify an induction is self-consistent (applying
 * a program to the exact source it was induced from must reproduce the
 * exact target) and, for item 99's held-out productivity test, to check
 * whether one family's induced program actually generalizes when applied
 * to a *different* source.
 */
export function applyEditProgram(source: string, ops: readonly EditOperation[]): string {
  if (ops.length === 1 && ops[0]!.kind === "null") return source;
  const sourceGraphemes = graphemes(source);
  const byAnchor = new Map<number, EditOperation[]>();
  for (const op of ops) {
    const bucket = byAnchor.get(op.sourceAnchor) ?? [];
    bucket.push(op);
    byAnchor.set(op.sourceAnchor, bucket);
  }
  // A "move" op's text must be emitted at its *reappearance* anchor, not
  // its (consuming) sourceAnchor -- indexed separately so the emission
  // loop below can find it there regardless of how far apart the two
  // anchors are.
  const reappearAt = new Map<number, EditOperation[]>();
  for (const op of ops) {
    if (op.kind !== "move" || op.reappearAnchor === undefined) continue;
    const bucket = reappearAt.get(op.reappearAnchor) ?? [];
    bucket.push(op);
    reappearAt.set(op.reappearAnchor, bucket);
  }
  let out = "";
  let index = 0;
  while (index <= sourceGraphemes.length) {
    for (const op of byAnchor.get(index) ?? []) {
      if (op.kind === "insert" || op.kind === "split" || op.kind === "repeat") out += op.text ?? "";
    }
    for (const op of reappearAt.get(index) ?? []) out += op.text ?? "";
    if (index === sourceGraphemes.length) break;
    const consuming = (byAnchor.get(index) ?? []).find(op =>
      op.kind === "copy" || op.kind === "delete" || op.kind === "substitute" || op.kind === "move" || op.kind === "join");
    if (!consuming) { out += sourceGraphemes[index]; index += 1; continue; }
    if (consuming.kind === "copy") {
      // Copy from the *current* source at this span, not the literal text
      // captured during induction -- this is what lets a program induced
      // from one example genuinely generalize to a held-out source rather
      // than just replaying the original pair it was learned from.
      out += sourceGraphemes.slice(consuming.sourceStart, consuming.sourceEnd).join("");
    } else if (consuming.kind === "substitute") {
      out += consuming.text ?? "";
    }
    index = consuming.sourceEnd ?? index + 1;
  }
  return out;
}
