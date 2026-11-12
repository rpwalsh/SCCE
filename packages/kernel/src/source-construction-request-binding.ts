// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { SOURCE_CONSTRUCTION_PREDICATE_SLOT_INDEX, type DurableLanguageConstructionBundle, type DurableSourceConstructionExample, type SourceConstructionGraphBinding } from "./language-construction-memory.js";
import type { LearnedConstruction } from "./language-construction.js";
import type { RequestValueResolver, ResolvedRequestValue } from "./semantic-answer-construct.js";
import { graphNodeSurface } from "./semantic-proof-adapter.js";
import { canonicalStringify } from "./primitives.js";
import { isSentenceBoundarySymbol, splitSurfaceSentences, stripTerminalSentenceBoundary, surfaceContainsBoundValue } from "./surface-linguistics.js";
import type { EvidenceSpan, GraphSnapshot, JsonValue } from "./types.js";
import { createLearnedSurfaceInterpreter, type LearnedSurfaceInterpreter } from "./learned-surface-interpretation.js";
import { normalizeCanonicalSurface } from "./normalization-contract.js";
import { unicodeLexicalSegments } from "./unicode-segmentation.js";

interface SourceRoleFact {
  relationId: string;
  qualifiers: JsonValue;
  modality: JsonValue;
  temporalScope: JsonValue;
  evidenceIds: readonly string[];
  participantPorts: Array<{ roleId: string; valueKind: string; realization: "observed" | "omitted"; evidenceIds: readonly string[]; surface?: string }>;
}

export interface SourceConstructionRequestBindingAudit {
  status: "bound" | "unavailable" | "ambiguous" | "incomplete";
  binding?: ResolvedRequestValue;
  candidates?: ResolvedRequestValue[];
  ambiguityCause?: "distinct_bindings" | "repeated_source_placement";
  visited: number;
}

/**
 * A request interpretation proved by an acquired construction before any source value is considered.
 * Literal fragments and graph-bound role fills remain separate so a source adapter can require a schema key
 * and its selector to come from the appropriate contiguous learned surface instead of treating the request as
 * an untyped bag of words. `matchedSurfaces` is retained only as a display/audit union.
 */
export interface LearnedRequestOmittedSlotDemand {
  requestSurface: string;
  relationId: string;
  requestedRoleId: string;
  valueKind: string;
  semanticRole?: SourceConstructionGraphBinding["semanticRole"];
  constructionIds: string[];
  bindingIds: string[];
  /** Exact learned literal fragments, kept separate so adapters cannot assemble a schema key across fragments. */
  matchedLiteralSurfaces: string[];
  /** Exact graph-bound role fills, with their declaration retained for typed source-selector binding. */
  matchedRoleSurfaces: Array<{
    surface: string;
    roleId: string;
    occurrenceId: string;
    graphBinding: SourceConstructionGraphBinding;
  }>;
  matchedSurfaces: string[];
}

export interface LearnedRequestOmittedSlotAudit {
  status: "value_demand" | "closed_proposition" | "unavailable" | "ambiguous" | "incomplete";
  demand?: LearnedRequestOmittedSlotDemand;
  matchedConstructionIds: string[];
  visited: number;
}
interface BindingInput {
  bundles: readonly DurableLanguageConstructionBundle[];
  graph: Pick<GraphSnapshot, "nodes" | "hyperedges">;
  maxTransitions?: number;
  sourceWindows?: readonly { evidenceId: string; startCodePoint: number; endCodePoint: number }[];
}

/**
 * Interprets only the request side of acquired constructions. A value demand exists solely when a complete
 * learned parse selects one unique typed null role. A complete construction with no null role is reported as a
 * closed proposition and can never authorize value extraction. Competing readings abstain.
 */
export function inspectLearnedRequestOmittedSlot(input: Pick<BindingInput, "bundles" | "maxTransitions">,
  requestText: string): LearnedRequestOmittedSlotAudit {
  const requestSurface = stripTerminalSentenceBoundary(requestText);
  const interpreter = createLearnedSurfaceInterpreter(requestSurface, true);
  const parts = input.bundles.reduce((sum, bundle) => sum + bundle.constructions.reduce((count, construction) => count + construction.sequence.length + 1, 0), 1);
  const size = BigInt([...requestSurface].length + 1) ** 2n * BigInt(parts);
  let remaining = input.maxTransitions ?? Number(size > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : size);
  if (!Number.isSafeInteger(remaining) || remaining < 1) return { status: "incomplete", matchedConstructionIds: [], visited: 0 };
  const allowance = remaining;
  let incomplete = false, closed = false;
  const matchedConstructionIds = new Set<string>();
  const found: Array<{ binding: SourceConstructionGraphBinding; constructionId: string; bindingId: string;
    placementSignature: string; literalSurfaces: string[]; roleSurfaces: LearnedRequestOmittedSlotDemand["matchedRoleSurfaces"] }> = [];
  for (const bundle of input.bundles) for (const construction of bundle.constructions) {
    if (remaining < 1) { incomplete = true; break; }
    // A contextual-QA bundle intentionally contains both the request header
    // (the source example carrying supervision and one omitted role) and the
    // declarative source construction used to recover that role.  The latter
    // is not an alternative parse of the request.  Keep this distinction from
    // the acquired provenance instead of guessing from surface shape.
    const contextualRequestBundle = bundle.sourceExamples.some(example => example.contextualQaSupervision !== undefined);
    const examples = bundle.sourceExamples.filter(example => construction.sourceExampleIds.includes(example.id)
      && (!contextualRequestBundle || example.contextualQaSupervision !== undefined)
      && example.roles.length > 0 && example.roles.every(role => Boolean(role.graphBinding) || isStructuralPredicateRole(role)));
    if (!examples.length) continue;
    const groups = declarationGroups(examples);
    const result = interpreter.enumerate({ sequence: terminalSequence(construction) }, {
      maxTransitions: remaining,
      collect: false,
      consumeTransition: () => { if (remaining < 1) return false; remaining--; return true; },
      visit: roles => {
        const slots = new Map(roles.map(role => [role.occurrenceId, role.surface]));
        for (const group of groups) {
          const exemplar = group[0]!;
          if (!rolesMatchSurface(exemplar.roles, slots, group)) continue;
          matchedConstructionIds.add(construction.id);
          if (exemplar.nullRoles.length === 0) { closed = true; continue; }
          if (exemplar.nullRoles.length !== 1 || !exemplar.nullRoles[0]!.graphBinding) continue;
          const binding = exemplar.nullRoles[0]!.graphBinding!;
          if (!group.every(example => example.nullRoles.length === 1
            && canonicalStringify(example.nullRoles[0]!.graphBinding) === canonicalStringify(binding))) continue;
          const declarations = new Map(exemplar.roles.map(role => [role.occurrenceId, role]));
          const placementSignature = canonicalStringify(roles.map(role => {
            const declaration = declarations.get(role.occurrenceId);
            return [role.startCodePoint, role.endCodePoint, normalizeCanonicalSurface(role.surface),
              declaration?.graphBinding ?? (declaration && isStructuralPredicateRole(declaration) ? "structural_predicate" : null)];
          }).sort((left, right) => compareCanonical(left, right)));
          const literalSurfaces = [...new Set(terminalSequence(construction)
            .flatMap(part => part.kind === "literal" && part.surface.trim() ? [part.surface.normalize("NFC").trim()] : []))];
          const roleSurfaces = roles.flatMap(role => {
            const declaration = declarations.get(role.occurrenceId);
            return declaration?.graphBinding ? [{ surface: role.surface.normalize("NFC").trim(), roleId: role.roleId,
              occurrenceId: role.occurrenceId, graphBinding: declaration.graphBinding }] : [];
          }).filter(row => Boolean(row.surface));
          found.push({ binding, constructionId: construction.id, bindingId: bundle.bindingId,
            placementSignature, literalSurfaces, roleSurfaces });
        }
      }
    });
    if (!result.complete) incomplete = true;
    if (incomplete) break;
  }
  const visited = allowance - remaining;
  const ids = [...matchedConstructionIds].sort();
  if (incomplete) return { status: "incomplete", matchedConstructionIds: ids, visited };
  if (!found.length) return { status: closed ? "closed_proposition" : "unavailable", matchedConstructionIds: ids, visited };
  if (closed) return { status: "ambiguous", matchedConstructionIds: ids, visited };
  if (new Set(found.map(row => row.placementSignature)).size !== 1) {
    return { status: "ambiguous", matchedConstructionIds: ids, visited };
  }
  const byBinding = new Map<string, typeof found>();
  for (const row of found) {
    const key = canonicalStringify(row.binding);
    byBinding.set(key, [...(byBinding.get(key) ?? []), row]);
  }
  if (byBinding.size !== 1) return { status: "ambiguous", matchedConstructionIds: ids, visited };
  const rows = byBinding.values().next().value as typeof found;
  const binding = rows[0]!.binding;
  const matchedLiteralSurfaces = [...new Set(rows.flatMap(row => row.literalSurfaces))].sort();
  const matchedRoleSurfaces = [...new Map(rows.flatMap(row => row.roleSurfaces).map(row => [canonicalStringify(row), row])).values()]
    .sort((left, right) => compareCanonical(left, right));
  return {
    status: "value_demand",
    demand: {
      requestSurface,
      relationId: binding.relationId,
      requestedRoleId: binding.roleId,
      valueKind: binding.valueKind,
      ...(binding.semanticRole ? { semanticRole: binding.semanticRole } : {}),
      constructionIds: [...new Set(rows.map(row => row.constructionId))].sort(),
      bindingIds: [...new Set(rows.map(row => row.bindingId))].sort(),
      matchedLiteralSurfaces,
      matchedRoleSurfaces,
      matchedSurfaces: [...new Set([...matchedLiteralSurfaces, ...matchedRoleSurfaces.map(row => row.surface)])].sort()
    },
    matchedConstructionIds: ids,
    visited
  };
}

function compareCanonical(left: unknown, right: unknown): number {
  const a = canonicalStringify(left), b = canonicalStringify(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Join current request and source roles before deciding whether their interpretation is unique. */
export function sourceConstructionRequestValueResolver(input: BindingInput): RequestValueResolver & {
  inspect(requestText: string, evidence: readonly EvidenceSpan[]): SourceConstructionRequestBindingAudit;
} {
  return { id: "resolver.acquired_source_construction",
    resolve(requestText, evidence) { return inspectSourceConstructionRequestBinding(input, requestText, evidence).binding; },
    inspect(requestText, evidence) { return inspectSourceConstructionRequestBinding(input, requestText, evidence); }
  };
}

function inspectSourceConstructionRequestBinding(input: BindingInput, requestText: string, evidence: readonly EvidenceSpan[]): SourceConstructionRequestBindingAudit {
  const requestSurface = stripTerminalSentenceBoundary(requestText);
  const requestInterpreter = createLearnedSurfaceInterpreter(requestSurface, true);
  const parts = input.bundles.reduce((sum, bundle) => sum + bundle.constructions.reduce((count, construction) => count + construction.sequence.length + 1, 0), 1);
  const preflightSize = BigInt([...requestSurface].length + 1) ** 2n * BigInt(parts);
  let preflightRemaining = input.maxTransitions ?? Number(preflightSize > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : preflightSize);
  if (!Number.isSafeInteger(preflightRemaining) || preflightRemaining < 1) return { status: "incomplete", visited: 0 };
  const preflightAllowance = preflightRemaining, matchingPrograms = new Set<string>();
  for (const bundle of input.bundles) for (const construction of bundle.constructions) {
    if (!bundle.sourceExamples.some(example => construction.sourceExampleIds.includes(example.id) && example.nullRoles.length === 1
      && Boolean(example.nullRoles[0]?.graphBinding) && example.roles.length > 0
      && example.roles.every(role => Boolean(role.graphBinding) || isStructuralPredicateRole(role)))) continue;
    if (preflightRemaining < 1) return { status: "incomplete", visited: preflightAllowance };
    const parsed = requestInterpreter.enumerate({ sequence: terminalSequence(construction) }, { maxTransitions: preflightRemaining,
      collect: false, visit: () => { matchingPrograms.add(construction.id); } });
    preflightRemaining -= parsed.visited;
    if (!parsed.complete) return { status: "incomplete", visited: preflightAllowance - preflightRemaining };
  }
  const preflightVisited = preflightAllowance - preflightRemaining;
  if (!matchingPrograms.size) return { status: "unavailable", visited: preflightVisited };
  const observed = inspectObservedContextualQaBinding(input, requestSurface, matchingPrograms, evidence);
  if (observed) return { ...observed, visited: preflightVisited };
  const sourcePrograms = input.bundles.flatMap(bundle => bundle.constructions.flatMap(construction => {
    const examples = bundle.sourceExamples.filter(example => construction.sourceExampleIds.includes(example.id)
      && example.nullRoles.length === 0 && example.roles.length > 0
      && example.roles.every(role => Boolean(role.graphBinding) || isStructuralPredicateRole(role)));
    const contextualQa = bundle.sourceExamples.some(example => example.contextualQaSupervision !== undefined);
    return declarationGroups(examples).map(group => ({ construction, group, exemplar: group[0]!, contextualQa }));
  }));
  const sentences = evidence.filter(span => span.status === "promoted").flatMap(span => {
    const windows = input.sourceWindows?.filter(window => window.evidenceId === String(span.id));
    const points = [...span.text];
    const surfaces = input.sourceWindows ? (windows ?? []).flatMap(window => Number.isSafeInteger(window.startCodePoint) && Number.isSafeInteger(window.endCodePoint)
      && window.startCodePoint >= 0 && window.endCodePoint > window.startCodePoint && window.endCodePoint <= points.length
      ? [points.slice(window.startCodePoint, window.endCodePoint).join("")] : []) : [span.text];
    return surfaces.flatMap(surface => splitSurfaceSentences(surface))
    .filter(sentence => span.text.includes(sentence)).map(surface => ({ span, surface: stripTerminalSentenceBoundary(surface),
      interpreter: createLearnedSurfaceInterpreter(stripTerminalSentenceBoundary(surface), true) }));
  });
  const nodes = new Map(input.graph.nodes.map(node => [String(node.id), node]));
  const graphFacts: SourceRoleFact[] = input.graph.hyperedges.map(edge => ({ ...edge, evidenceIds: edge.evidenceIds.map(String),
    participantPorts: edge.participantPorts.map(port => ({ ...port, evidenceIds: port.evidenceIds.map(String),
      surface: port.nodeId ? graphNodeSurface(nodes.get(String(port.nodeId))) : undefined })) }));
  const size = BigInt([...requestSurface].length + 1) * BigInt(sentences.reduce((sum, row) => sum + [...row.surface].length + 1, 1))
    * BigInt(parts);
  let remaining = (input.maxTransitions ?? Number(size > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : size)) - preflightVisited;
  if (!Number.isSafeInteger(remaining) || remaining < 1) return { status: "incomplete", visited: preflightVisited };
  const allowance = remaining;
  let incomplete = false, ambiguous = false;
  let ambiguityCause: SourceConstructionRequestBindingAudit["ambiguityCause"];
  const found: Array<{ binding: ResolvedRequestValue; key: string }> = [];
  const sourceAmbiguity = new Map<object, WeakMap<object, boolean>>();
  const enumerate = (interpreter: LearnedSurfaceInterpreter, construction: LearnedConstruction,
    knownSurfaces: ReadonlyMap<string, string>, acceptRole: (role: import("./learned-surface-interpretation.js").InterpretedSurfaceRole) => boolean,
    visit: (slots: Map<string, string>, roles: readonly import("./learned-surface-interpretation.js").InterpretedSurfaceRole[]) => boolean | void,
    matchMode: "full" | "substring" = "full") => {
    if (remaining < 1) { incomplete = true; return; }
    const result = interpreter.enumerate({ sequence: terminalSequence(construction) }, { maxTransitions: remaining, matchMode, knownSurfaces, acceptRole, collect: false,
      consumeTransition: () => { if (remaining < 1) return false; remaining--; return true; },
      visit: roles => visit(new Map(roles.map(role => [role.occurrenceId, role.surface])), roles) });
    if (!result.complete && !ambiguous) incomplete = true;
  };
  const publish = (edge: SourceRoleFact, exemplar: DurableSourceConstructionExample, slots: ReadonlyMap<string, string>, relation: string | undefined,
    requestRoles: readonly import("./learned-surface-interpretation.js").InterpretedSurfaceRole[]) => {
    const answerBinding = exemplar.nullRoles[0]!.graphBinding!;
    if (!scopeMatches(edge, answerBinding)) return;
    const anchors = exemplar.roles.filter(role => role.graphBinding), anchored: Array<{ surface: string; port: number; role: string; start: number; end: number }> = [];
    for (const role of anchors) {
      const surface = slots.get(role.occurrenceId), binding = role.graphBinding!;
      const ports = edge.participantPorts.flatMap((port, index) => matchesPort(port, binding) && port.surface !== undefined
        && surface && normalizeCanonicalSurface(port.surface) === normalizeCanonicalSurface(surface) ? [index] : []);
      const current = requestRoles.find(current => current.occurrenceId === role.occurrenceId);
      if (!surface || !current || ports.length !== 1) return;
      anchored.push({ surface, port: ports[0]!, role: binding.roleId, start: current.startCodePoint, end: current.endCodePoint });
    }
    if (!anchored.length) return;
    const ports = edge.participantPorts.filter(port => matchesPort(port, answerBinding));
    if (ports.length !== 1 || !ports[0]!.surface) return;
    const port = ports[0]!, value = port.surface!;
    const ownerIds = new Set((port.evidenceIds.length ? port.evidenceIds : edge.evidenceIds).map(String));
    const evidenceIds = evidence.filter(span => span.status === "promoted" && ownerIds.has(String(span.id)) && surfaceContainsBoundValue(span.text, value)).map(span => String(span.id));
    if (!evidenceIds.length) return;
    const subject = [...anchored].sort((a, b) => a.port - b.port).map(anchor => anchor.surface).join(" ");
    const binding = { value, evidenceIds, subject, ...(relation ? { relation } : {}), requestedRoleId: answerBinding.roleId, relationId: answerBinding.relationId };
    // Distinct surface predicates can realize the same typed fact. They are explanatory labels, not competing
    // answers; ambiguity is about the resolved value/subject/role tuple.
    const key = canonicalStringify([normalizeCanonicalSurface(value.trim()), normalizeCanonicalSurface(subject.trim()), answerBinding.roleId, answerBinding.relationId,
      anchored.map(anchor => [anchor.role, normalizeCanonicalSurface(anchor.surface), anchor.start, anchor.end])]);
    if (found.length && found[0]!.key !== key) { ambiguous = true; ambiguityCause = "distinct_bindings"; }
    found.push({ binding, key });
  };
  for (const bundle of input.bundles) for (const construction of bundle.constructions) {
    if (!matchingPrograms.has(construction.id)) continue;
    const examples = bundle.sourceExamples.filter(example => construction.sourceExampleIds.includes(example.id)
      && example.nullRoles.length === 1 && Boolean(example.nullRoles[0]?.graphBinding)
      && example.roles.length > 0 && example.roles.every(role => Boolean(role.graphBinding) || isStructuralPredicateRole(role)));
    for (const group of declarationGroups(examples)) {
      const exemplar = group[0]!, answerBinding = exemplar.nullRoles[0]!.graphBinding!, anchors = exemplar.roles.filter(role => role.graphBinding);
      if (!anchors.length || anchors.some(role => role.graphBinding!.relationId !== answerBinding.relationId)) continue;
      const relationFor = (slots: ReadonlyMap<string, string>) => {
        const matching = group.filter(example => rolesMatchSurface(example.roles, slots, group));
        if (!matching.length) return null;
        const predicates = new Map(matching.flatMap(example => example.roles.filter(isStructuralPredicateRole)
          .map(role => [normalizeCanonicalSurface(role.surface), role.surface] as const)));
        return predicates.size > 1 ? null : { value: predicates.values().next().value as string | undefined };
      };
      for (const edge of graphFacts) {
        if (!scopeMatches(edge, answerBinding)) continue;
        const known = new Map<string, string>();
        for (const role of anchors) { const ports = edge.participantPorts.filter(port => matchesPort(port, role.graphBinding!) && port.surface !== undefined);
          if (ports.length === 1) known.set(role.occurrenceId, ports[0]!.surface!); }
        if (known.size !== anchors.length) continue;
        enumerate(requestInterpreter, construction, known, () => true, (slots, roles) => {
          const relation = relationFor(slots); if (relation) publish(edge, exemplar, slots, relation.value, roles);
          return !ambiguous;
        });
        if (ambiguous || incomplete) break;
      }
      if (ambiguous || incomplete) break;
      for (const source of sourcePrograms) {
        const boundRoles = source.exemplar.roles.filter(role => role.graphBinding), scope = boundRoles[0]?.graphBinding;
        if (!scope || !scopeMatches(scopeAsFact(scope), answerBinding)
          || !boundRoles.every(role => scopeMatches(scopeAsFact(role.graphBinding!), scope))) continue;
        for (const sentence of sentences) {
          const comparable = normalizeCanonicalSurface(sentence.surface);
          const lexicalBoundaries = new Set([0, [...sentence.surface].length,
            ...unicodeLexicalSegments(sentence.surface).flatMap(segment => [segment.codePointStart, segment.codePointEnd])]);
          enumerate(requestInterpreter, construction, new Map(), role => {
            const anchor = anchors.find(anchor => anchor.occurrenceId === role.occurrenceId);
            return !anchor || comparable.includes(normalizeCanonicalSurface(role.surface));
          }, (slots, requestRoles) => {
            const relation = relationFor(slots); if (!relation) return;
            const allowed = (role: import("./learned-surface-interpretation.js").InterpretedSurfaceRole) => {
              const declaration = source.exemplar.roles.find(candidate => candidate.occurrenceId === role.occurrenceId);
              if (!declaration) return false;
              if (isStructuralPredicateRole(declaration)) return normalizeCanonicalSurface(role.surface) === normalizeCanonicalSurface(declaration.surface);
              const isAnswerRole = Boolean(declaration.graphBinding && matchesBinding(declaration.graphBinding, answerBinding));
              if (isAnswerRole && unicodeLexicalSegments(role.surface).length > 0) {
                const structural = roleBoundaryAnchors(source.construction, role.occurrenceId);
                if ((!structural.start && !lexicalBoundaries.has(role.startCodePoint))
                  || (!structural.end && !lexicalBoundaries.has(role.endCodePoint))) return false;
              }
              if (declaration.graphBinding?.surfaceClass === "observed" && !source.group.some(example => example.roles.some(candidate =>
                candidate.occurrenceId === role.occurrenceId && candidate.surface === role.surface))) return false;
              // Preserve a role's measured lexical cardinality when every independent training witness agrees.
              // This is learned from Unicode segmentation, not a language-specific token heuristic, and prevents
              // the omitted answer role from absorbing arbitrary preceding context during subspan realization.
              const observedShapes = new Set(source.group.flatMap(example => example.roles
                .filter(candidate => candidate.occurrenceId === role.occurrenceId)
                .map(candidate => lexicalSurfaceShape(candidate.surface))));
              return !isAnswerRole || observedShapes.size !== 1 || observedShapes.has(lexicalSurfaceShape(role.surface));
            };
            let bySentence = sourceAmbiguity.get(source); if (!bySentence) { bySentence = new WeakMap(); sourceAmbiguity.set(source, bySentence); }
            let repeatedRelation = bySentence.get(sentence);
            if (repeatedRelation === undefined) {
              let placement: string | undefined; repeatedRelation = false;
              if (remaining < 1) { incomplete = true; return false; }
              const parsed = sentence.interpreter.enumerate({ sequence: terminalSequence(source.construction) }, {
                maxTransitions: remaining, collect: false, acceptRole: allowed,
                consumeTransition: () => { if (remaining < 1) return false; remaining--; return true; },
                visit: roles => {
                  const next = literalPlacementSignature(source.construction, roles, [...sentence.surface].length);
                  if (placement !== undefined && placement !== next) { repeatedRelation = true; return false; }
                  placement = next;
                }
              });
              if (!parsed.complete && !repeatedRelation) { incomplete = true; return false; }
              bySentence.set(sentence, repeatedRelation);
            }
            if (repeatedRelation) { ambiguous = true; ambiguityCause = "repeated_source_placement"; return false; }
            const known = new Map<string, string>();
            for (const role of boundRoles) {
              const matching = anchors.filter(anchor => matchesBinding(anchor.graphBinding!, role.graphBinding!));
              const values = [...new Set(matching.map(anchor => slots.get(anchor.occurrenceId)).filter((value): value is string => value !== undefined))];
              if (matching.length && values.length !== 1) return;
              if (values.length) known.set(role.occurrenceId, values[0]!);
            }
            enumerate(sentence.interpreter, source.construction, known, allowed, sourceSlots => {
              if (!rolesMatchSurface(source.exemplar.roles, sourceSlots, source.group)) return;
              const participantPorts = boundRoles.flatMap(role => {
                const surface = sourceSlots.get(role.occurrenceId); return surface ? [{ ...role.graphBinding!, surface, realization: "observed" as const, evidenceIds: [String(sentence.span.id)] }] : [];
              });
              if (participantPorts.length !== boundRoles.length) return;
              publish({ ...scopeAsFact(scope), participantPorts, evidenceIds: [String(sentence.span.id)] }, exemplar, slots, relation.value, requestRoles);
              return !ambiguous;
            }, source.contextualQa ? "substring" : "full");
            return !ambiguous && !incomplete;
          });
          if (ambiguous || incomplete) break;
        }
        if (ambiguous || incomplete) break;
      }
      if (ambiguous || incomplete) break;
    }
    if (ambiguous || incomplete) break;
  }
  const visited = preflightVisited + allowance - remaining;
  if (ambiguous) return { status: "ambiguous", ...(ambiguityCause ? { ambiguityCause } : {}),
    candidates: [...new Map(found.map(row => [row.key, row.binding])).values()], visited };
  if (incomplete) return { status: "incomplete", visited };
  if (!found.length) return { status: "unavailable", visited };
  return { status: "bound", visited, binding: { ...found[0]!.binding, evidenceIds: [...new Set(found.flatMap(row => row.binding.evidenceIds))] } };
}

/**
 * A source-observed contextual relation is already an exact, typed fact: the request construction owns the
 * omitted role and its supervision owns the answer coordinates in the retained evidence. Re-parsing that same
 * prose with a transfer construction can only discard information and, for unconstrained natural sentences,
 * invent competing subspans. Resolve the retained fact directly; generalized source parsing remains responsible
 * for evidence that was not one of the qualified observations.
 */
function inspectObservedContextualQaBinding(input: BindingInput, requestSurface: string,
  matchingPrograms: ReadonlySet<string>, evidence: readonly EvidenceSpan[]): Omit<SourceConstructionRequestBindingAudit, "visited"> | undefined {
  const promoted = new Map(evidence.filter(span => span.status === "promoted").map(span => [String(span.id), span]));
  const found = new Map<string, ResolvedRequestValue>();
  for (const bundle of input.bundles) {
    if (bundle.acquisitionStatus !== "source_observed") continue;
    for (const construction of bundle.constructions) {
      if (!matchingPrograms.has(construction.id)) continue;
      for (const example of bundle.sourceExamples) {
        const supervision = example.contextualQaSupervision;
        if (!supervision || !construction.sourceExampleIds.includes(example.id)
          || normalizeCanonicalSurface(stripTerminalSentenceBoundary(example.surface)) !== normalizeCanonicalSurface(requestSurface)
          || example.nullRoles.length !== 1 || !example.nullRoles[0]!.graphBinding) continue;
        const answerBinding = example.nullRoles[0]!.graphBinding;
        const anchors = example.roles.filter(role => role.graphBinding?.relationId === answerBinding.relationId)
          .sort((left, right) => left.slotIndex - right.slotIndex || left.occurrenceIndex - right.occurrenceIndex);
        if (!anchors.length) continue;
        const span = promoted.get(example.evidenceId);
        if (!span || String(span.sourceVersionId) !== example.sourceVersionId) continue;
        const selected = supervision.answerRange ?? (supervision.derivedAnswerAlignment ? {
          startCodePoint: supervision.derivedAnswerAlignment.sourceAnswerStartCodePoint,
          endCodePoint: supervision.derivedAnswerAlignment.sourceAnswerEndCodePoint
        } : undefined);
        const points = [...span.text];
        if (!selected || !Number.isSafeInteger(selected.startCodePoint) || !Number.isSafeInteger(selected.endCodePoint)
          || selected.startCodePoint < supervision.contextStartCodePoint || selected.endCodePoint > supervision.contextEndCodePoint
          || selected.startCodePoint < 0 || selected.endCodePoint <= selected.startCodePoint || selected.endCodePoint > points.length
          || supervision.supportingSourceRanges?.length && !supervision.supportingSourceRanges.some(range =>
            selected.startCodePoint >= range.startCodePoint && selected.endCodePoint <= range.endCodePoint)
          || input.sourceWindows && !input.sourceWindows.some(window => window.evidenceId === example.evidenceId
            && selected.startCodePoint >= window.startCodePoint && selected.endCodePoint <= window.endCodePoint)) continue;
        const value = points.slice(selected.startCodePoint, selected.endCodePoint).join("");
        const subject = anchors.map(anchor => anchor.surface).join(" ");
        if (!value || !subject) continue;
        const binding: ResolvedRequestValue = { value, subject, evidenceIds: [example.evidenceId],
          requestedRoleId: answerBinding.roleId, relationId: answerBinding.relationId };
        const key = canonicalStringify([normalizeCanonicalSurface(value.trim()), normalizeCanonicalSurface(subject.trim()),
          answerBinding.roleId, answerBinding.relationId]);
        const previous = found.get(key);
        found.set(key, previous ? { ...previous, evidenceIds: [...new Set([...previous.evidenceIds, example.evidenceId])].sort() } : binding);
      }
    }
  }
  const candidates = [...found.values()];
  if (!candidates.length) return undefined;
  if (candidates.length > 1) return { status: "ambiguous", ambiguityCause: "distinct_bindings", candidates };
  return { status: "bound", binding: candidates[0] };
}
function scopeAsFact(binding: SourceConstructionGraphBinding): SourceRoleFact {
  return { relationId: binding.relationId, qualifiers: binding.qualifiers ?? {}, modality: binding.modality ?? {}, temporalScope: binding.temporalScope ?? {}, participantPorts: [], evidenceIds: [] };
}
function scopeMatches(edge: Pick<SourceRoleFact, "relationId" | "qualifiers" | "modality" | "temporalScope">, binding: SourceConstructionGraphBinding): boolean {
  return edge.relationId === binding.relationId && canonicalStringify(edge.qualifiers) === canonicalStringify(binding.qualifiers ?? {})
    && canonicalStringify(edge.modality) === canonicalStringify(binding.modality ?? {}) && canonicalStringify(edge.temporalScope) === canonicalStringify(binding.temporalScope ?? {});
}
function matchesBinding(left: SourceConstructionGraphBinding, right: SourceConstructionGraphBinding): boolean {
  return left.relationId === right.relationId && left.roleId === right.roleId && left.valueKind === right.valueKind;
}
function terminalSequence(construction: LearnedConstruction): LearnedConstruction["sequence"] {
  const sequence = [...construction.sequence], last = sequence.at(-1);
  if (last?.kind === "literal") { const points = [...last.surface];
    if (points.length && isSentenceBoundarySymbol(points.at(-1)!)) { points.pop(); const surface = points.join("");
      if (surface) sequence[sequence.length - 1] = { ...last, surface }; else sequence.pop(); } }
  return sequence;
}
function literalPlacementSignature(construction: LearnedConstruction,
  roles: readonly import("./learned-surface-interpretation.js").InterpretedSurfaceRole[], length: number): string {
  const sequence = terminalSequence(construction), byId = new Map(roles.map(role => [role.occurrenceId, role]));
  return canonicalStringify(sequence.flatMap((part, index) => {
    if (part.kind !== "literal" || !part.surface.trim()) return [];
    const previous = sequence.slice(0, index).reverse().find(part => part.kind === "slot");
    const next = sequence.slice(index + 1).find(part => part.kind === "slot");
    return [[index, previous?.kind === "slot" ? byId.get(previous.occurrenceId)?.endCodePoint : 0,
      next?.kind === "slot" ? byId.get(next.occurrenceId)?.startCodePoint : length]];
  }));
}

function matchesPort(port: SourceRoleFact["participantPorts"][number], binding: SourceConstructionGraphBinding): boolean {
  return port.realization === "observed" && port.roleId === binding.roleId && port.valueKind === binding.valueKind;
}

function isStructuralPredicateRole(role: DurableSourceConstructionExample["roles"][number]): boolean {
  return !role.graphBinding && role.slotIndex === SOURCE_CONSTRUCTION_PREDICATE_SLOT_INDEX;
}

function rolesMatchSurface(roles: readonly DurableSourceConstructionExample["roles"][number][], slots: ReadonlyMap<string, string>, examples: readonly DurableSourceConstructionExample[] = []): boolean {
  return roles.filter(isStructuralPredicateRole).every(role => {
    const surface = slots.get(role.occurrenceId);
    return Boolean(surface) && normalizeCanonicalSurface(surface!) === normalizeCanonicalSurface(role.surface);
  }) && roles.filter(role => role.graphBinding?.surfaceClass === "observed").every(role => {
    const surface = slots.get(role.occurrenceId);
    return surface !== undefined && examples.some(example => example.roles.some(observed => observed.occurrenceId === role.occurrenceId
      && canonicalStringify(observed.graphBinding) === canonicalStringify(role.graphBinding) && observed.surface === surface));
  });
}

function lexicalSurfaceShape(surface: string): string {
  const points = [...surface], segments = unicodeLexicalSegments(surface);
  if (!segments.length) return canonicalStringify([0, points.length, 0]);
  return canonicalStringify([segments.length, segments[0]!.codePointStart, points.length - segments.at(-1)!.codePointEnd]);
}

/**
 * A learned literal adjacent to a role is itself a measured boundary. Requiring
 * Unicode word segmentation at that same edge rejects valid constructions such
 * as `<author>'s <title>` because the apostrophe belongs to the surrounding word
 * under Unicode segmentation. An unanchored edge still needs a lexical boundary
 * so substring interpretation cannot begin or end inside unrelated material.
 */
function roleBoundaryAnchors(construction: LearnedConstruction, occurrenceId: string): { start: boolean; end: boolean } {
  const sequence = terminalSequence(construction), index = sequence.findIndex(part => part.kind === "slot" && part.occurrenceId === occurrenceId);
  if (index < 0) return { start: false, end: false };
  const previous = sequence[index - 1], next = sequence[index + 1];
  return {
    start: previous?.kind === "literal" && previous.surface.length > 0,
    end: next?.kind === "literal" && next.surface.length > 0
  };
}

function declarationGroups(examples: readonly DurableSourceConstructionExample[]): DurableSourceConstructionExample[][] {
  const groups = new Map<string, DurableSourceConstructionExample[]>();
  for (const example of examples) {
    const key = canonicalStringify([
      example.roles.map(role => [role.occurrenceId, role.graphBinding ?? null]),
      example.nullRoles.map(role => [role.occurrenceId, role.graphBinding ?? null])
    ]);
    const group = groups.get(key) ?? [];
    group.push(example);
    groups.set(key, group);
  }
  return [...groups.values()];
}
