// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
/**
 * A counterclaim surface may only be constructed from a source-attested
 * positive/negative pair.  The operator below is deliberately much narrower
 * than general text rewriting: it admits a transformation only when every
 * source grapheme is copied and the polarity-bearing difference is inserted.
 * That makes it safe to bind a new role value without replaying an observed
 * value, while leaving substitutions, deletions, and lexical guesses for
 * later evidence-backed learning.
 */
import { semanticFrameSurfaces, type LanguageMemoryRuntimeState } from "./language-memory-runtime.js";
import { applyEditProgram, induceEditProgram, type EditOperation } from "./universal-edit-program.js";
import type { SemanticAtom } from "./semantic-proof-types.js";
import type { JsonValue } from "./types.js";

export interface CounterclaimPolarityConstructionIntent {
  id: string;
  predicate: string;
  roles: SemanticAtom["roles"];
  constraints: SemanticAtom["constraints"];
  originalPolarity: SemanticAtom["polarity"];
  targetPolarity: SemanticAtom["polarity"];
  claimSourceSurface: string;
}

export interface CounterclaimPolarityConstruction {
  id: string;
  profileId: string;
  positiveSurface: string;
  negativeSurface: string;
  positiveSourceId: string;
  negativeSourceId: string;
  /** Typed source annotations that licensed this construction, when present. */
  positiveAtom: SemanticAtom;
  negativeAtom: SemanticAtom;
  editProgram: EditOperation[];
  support: number;
}

export interface CounterclaimPolarityConstructionResult {
  surface?: string;
  construction?: CounterclaimPolarityConstruction;
  audit: JsonValue;
}

interface SourceSurface {
  id: string;
  profileId: string;
  text: string;
  support: number;
  typedAtom?: SemanticAtom;
}

/**
 * Induce and apply one profile-owned, binding-preserving polarity transform.
 * The caller still independently interprets `surface` before it can issue a
 * search.  No natural-language negation vocabulary participates here.
 */
export function realizeCounterclaimWithInducedPolarityConstruction(input: {
  state: LanguageMemoryRuntimeState;
  profileId: string;
  intent: CounterclaimPolarityConstructionIntent;
  interpretSurface: (surface: string) => readonly SemanticAtom[];
}): CounterclaimPolarityConstructionResult {
  const targetSource = exactSingleAtom(input.interpretSurface(input.intent.claimSourceSurface));
  if (!targetSource
    || targetSource.polarity !== input.intent.originalPolarity
    || exactContentKey(targetSource) !== exactContentKey(input.intent)
  ) {
    return { audit: { accepted: false, reasonIds: ["counterclaim.construction_target_not_reinterpretable"] } };
  }
  const targetStructure = structuralKey(input.intent);
  const candidates = sourceSurfaces(input.state, input.profileId)
    .map(source => ({ source, atom: source.typedAtom ?? exactSingleAtom(input.interpretSurface(source.text)) }))
    .filter((row): row is { source: SourceSurface; atom: SemanticAtom } => Boolean(row.atom))
    .filter(row => row.atom.polarity === 1 || row.atom.polarity === -1)
    .filter(row => structuralKey(row.atom) === targetStructure);

  const constructions: CounterclaimPolarityConstruction[] = [];
  for (const positive of candidates.filter(row => row.atom.polarity === 1)) {
    for (const negative of candidates.filter(row => row.atom.polarity === -1)) {
      // The paired evidence must describe the same bound proposition.  The
      // target may change bindings later, but induction itself may not.
      if (exactContentKey(positive.atom) !== exactContentKey(negative.atom)) continue;
      const program = induceEditProgram(positive.source.text, negative.source.text);
      if (!isBindingPreservingInsertion(program, positive.source.text, negative.source.text)) continue;
      constructions.push({
        id: `counterclaim-polarity:${positive.source.id}:${negative.source.id}`,
        profileId: input.profileId,
        positiveSurface: positive.source.text,
        negativeSurface: negative.source.text,
        positiveSourceId: positive.source.id,
        negativeSourceId: negative.source.id,
        positiveAtom: positive.atom,
        negativeAtom: negative.atom,
        editProgram: program,
        support: positive.source.support + negative.source.support
      });
    }
  }
  const selected = constructions.sort((left, right) =>
    right.support - left.support || left.id.localeCompare(right.id))[0];
  if (!selected) {
    return { audit: { accepted: false, reasonIds: ["counterclaim.no_profile_scoped_polarity_construction"] } };
  }
  const surface = input.intent.originalPolarity === 1
    ? applyBoundaryInsertionConstruction(input.intent.claimSourceSurface, selected.editProgram, selected.positiveSurface)
    : undefined;
  // Reversing an induced insertion would require a separately attested
  // inverse construction.  Do not invent one by deleting a learned marker.
  if (!surface || !surface.trim()) {
    return { audit: { accepted: false, reasonIds: ["counterclaim.inverse_construction_unavailable"], constructionId: selected.id } };
  }
  return {
    surface,
    construction: selected,
    audit: {
      accepted: true,
      constructionId: selected.id,
      sourceIds: [selected.positiveSourceId, selected.negativeSourceId],
      operationKinds: selected.editProgram.map(operation => operation.kind)
    }
  };
}

/**
 * Interpret a constructed counterclaim through its learned reversible source
 * geometry. The ordinary interpreter sees the reconstructed, unmarked base
 * surface; the typed construction supplies the polarity transition. This is
 * the production bridge for a source-derived marker the generic parser has
 * never seen before.
 */
export function reinterpretCounterclaimWithInducedPolarityConstruction(input: {
  intent: CounterclaimPolarityConstructionIntent;
  construction: CounterclaimPolarityConstruction;
  surface: string;
  interpretSurface: (surface: string) => readonly SemanticAtom[];
}): SemanticAtom[] {
  if (input.intent.originalPolarity !== 1 || input.intent.targetPolarity !== -1) return [];
  const reconstructed = removeBoundaryInsertions(input.surface, input.construction.editProgram, input.construction.positiveSurface);
  if (reconstructed !== input.intent.claimSourceSurface) return [];
  const atom = exactSingleAtom(input.interpretSurface(reconstructed));
  if (!atom || atom.polarity !== input.intent.originalPolarity || exactContentKey(atom) !== exactContentKey(input.intent)) return [];
  return [{ ...atom, polarity: input.intent.targetPolarity, sourceText: input.surface }];
}

function sourceSurfaces(state: LanguageMemoryRuntimeState, profileId: string): SourceSurface[] {
  const surfaces: SourceSurface[] = [];
  for (const unit of state.importedUnits) {
    if (unit.profileId !== profileId || (unit.unitKind !== "phrase" && unit.unitKind !== "symbol")) continue;
    if (unit.text.trim()) surfaces.push({ id: unit.id, profileId, text: unit.text.trim(), support: unit.alpha, typedAtom: typedAtomFromJson(unit.metadata, unit.id, unit.text) });
  }
  for (const frame of state.importedSemanticFrames) {
    if (frameProfileId(frame.frameJson) !== profileId) continue;
    for (const text of semanticFrameSurfaces(frame)) {
      if (text.trim()) surfaces.push({ id: frame.id, profileId, text: text.trim(), support: frame.alpha, typedAtom: typedAtomFromJson(frame.frameJson, frame.id, text) });
    }
  }
  const unique = new Map<string, SourceSurface>();
  for (const surface of surfaces) {
    const key = `${surface.id}\u0000${surface.text.normalize("NFKC")}`;
    const existing = unique.get(key);
    if (!existing || surface.support > existing.support) unique.set(key, surface);
  }
  return [...unique.values()].sort((left, right) => right.support - left.support || left.id.localeCompare(right.id) || left.text.localeCompare(right.text));
}

function exactSingleAtom(atoms: readonly SemanticAtom[]): SemanticAtom | undefined {
  return atoms.length === 1 && (atoms[0]!.polarity === 1 || atoms[0]!.polarity === -1) ? atoms[0] : undefined;
}

function isBindingPreservingInsertion(program: readonly EditOperation[], source: string, target: string): boolean {
  if (applyEditProgram(source, program) !== target || !program.some(operation => operation.kind === "insert")) return false;
  const sourceLength = [...source].length;
  const covered = new Array<boolean>(sourceLength).fill(false);
  for (const operation of program) {
    // Only the two surface boundaries transfer without assuming a fixed
    // character offset.  Interior edits need an independently learned slot
    // anchor and are intentionally unavailable here.
    if (operation.kind === "insert") {
      if (operation.sourceAnchor !== 0 && operation.sourceAnchor !== sourceLength) return false;
      continue;
    }
    if (operation.kind !== "copy" || operation.sourceStart === undefined || operation.sourceEnd === undefined) return false;
    for (let index = operation.sourceStart; index < operation.sourceEnd; index++) {
      if (covered[index]) return false;
      covered[index] = true;
    }
  }
  return covered.every(Boolean);
}

function applyBoundaryInsertionConstruction(source: string, program: readonly EditOperation[], inductionSource: string): string | undefined {
  const inductionLength = [...inductionSource].length;
  let prefix = "";
  let suffix = "";
  for (const operation of program) {
    if (operation.kind !== "insert") continue;
    if (operation.sourceAnchor === 0) prefix += operation.text ?? "";
    else if (operation.sourceAnchor === inductionLength) suffix += operation.text ?? "";
    else return undefined;
  }
  return `${prefix}${source}${suffix}`;
}

function removeBoundaryInsertions(surface: string, program: readonly EditOperation[], inductionSource: string): string | undefined {
  const inductionLength = [...inductionSource].length;
  let prefix = "";
  let suffix = "";
  for (const operation of program) {
    if (operation.kind !== "insert") continue;
    if (operation.sourceAnchor === 0) prefix += operation.text ?? "";
    else if (operation.sourceAnchor === inductionLength) suffix += operation.text ?? "";
    else return undefined;
  }
  if (!surface.startsWith(prefix) || !surface.endsWith(suffix)) return undefined;
  return surface.slice(prefix.length, suffix ? surface.length - suffix.length : surface.length);
}

/**
 * Typed frame annotations are language-neutral records produced upstream by
 * ingestion. They are optional: older language units retain the stricter
 * ordinary-interpreter path. A malformed annotation is simply unusable.
 */
function typedAtomFromJson(value: JsonValue, id: string, sourceText: string): SemanticAtom | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, JsonValue>;
  const raw = record.semanticAtom;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const atom = raw as Record<string, JsonValue>;
  const predicate = typeof atom.predicate === "string" ? atom.predicate : undefined;
  const polarity = atom.polarity === 1 || atom.polarity === -1 ? atom.polarity : undefined;
  if (!predicate || !polarity || !Array.isArray(atom.roles) || !Array.isArray(atom.constraints)) return undefined;
  const roles = atom.roles.map(rawRole => {
    if (!rawRole || typeof rawRole !== "object" || Array.isArray(rawRole)) return undefined;
    const role = rawRole as Record<string, JsonValue>;
    const name = typeof role.name === "string" ? role.name : undefined;
    const roleValue = typeof role.value === "string" ? role.value : undefined;
    const type = typeof role.type === "string" ? role.type : undefined;
    if (!name || !roleValue || !type) return undefined;
    return { name, value: roleValue, normalized: typeof role.normalized === "string" ? role.normalized : normalize(roleValue), type,
      features: Array.isArray(role.features) ? role.features.filter((feature): feature is string => typeof feature === "string") : [], weight: typeof role.weight === "number" ? role.weight : 1 };
  });
  const constraints = atom.constraints.map((rawConstraint, index) => {
    if (!rawConstraint || typeof rawConstraint !== "object" || Array.isArray(rawConstraint)) return undefined;
    const constraint = rawConstraint as Record<string, JsonValue>;
    const kind = typeof constraint.kind === "string" ? constraint.kind : undefined;
    const subject = typeof constraint.subject === "string" ? constraint.subject : undefined;
    const operator = typeof constraint.operator === "string" ? constraint.operator : undefined;
    if (!kind || !subject || !operator || !("value" in constraint)) return undefined;
    return { id: typeof constraint.id === "string" ? constraint.id : `${id}:constraint:${index}`, kind, subject, operator, value: constraint.value,
      confidence: typeof constraint.confidence === "number" ? constraint.confidence : 1, evidenceIds: [] };
  });
  if (roles.some(role => !role) || constraints.some(constraint => !constraint)) return undefined;
  return {
    id: `${id}:semantic-atom`, predicate, predicateFeatures: [], roles: roles as SemanticAtom["roles"], constraints: constraints as SemanticAtom["constraints"], polarity,
    alpha: 1, modality: "", source: "typed-language-frame", sourceText, evidenceIds: [], nodeIds: [], vector: [], proofClass: "none", certifiesFactualProof: false
  };
}

function exactContentKey(atom: Pick<SemanticAtom, "predicate" | "roles" | "constraints">): string {
  return JSON.stringify({
    predicate: atom.predicate,
    roles: atom.roles.map(role => [role.name, role.normalized || normalize(role.value), role.type]).sort(compareJson),
    constraints: atom.constraints.map(constraint => [constraint.kind, constraint.subject, constraint.operator, constraint.value]).sort(compareJson)
  });
}

/** The construction can reuse a frame only where typed predicate/role slots still match. */
function structuralKey(atom: Pick<SemanticAtom, "predicate" | "roles" | "constraints">): string {
  return JSON.stringify({
    predicate: atom.predicate,
    roles: atom.roles.map(role => [role.name, role.type]).sort(compareJson),
    constraints: atom.constraints.map(constraint => [constraint.kind, constraint.subject, constraint.operator]).sort(compareJson)
  });
}

function compareJson(left: unknown, right: unknown): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function normalize(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase();
}

function frameProfileId(value: JsonValue): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const profileId = (value as Record<string, JsonValue>).profileId;
  return typeof profileId === "string" && profileId ? profileId : undefined;
}
