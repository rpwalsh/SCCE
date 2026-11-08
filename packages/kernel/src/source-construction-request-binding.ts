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

interface SourceRoleFact {
  relationId: string;
  qualifiers: JsonValue;
  modality: JsonValue;
  temporalScope: JsonValue;
  evidenceIds: readonly string[];
  participantPorts: Array<{ roleId: string; valueKind: string; realization: "observed" | "omitted"; evidenceIds: readonly string[]; surface?: string }>;
}

/** Invert acquired request forms using their declared graph ports, including the unspoken answer port. */
export function sourceConstructionRequestValueResolver(input: {
  bundles: readonly DurableLanguageConstructionBundle[];
  graph: Pick<GraphSnapshot, "nodes" | "hyperedges">;
}): RequestValueResolver {
  return {
    id: "resolver.acquired_source_construction",
    resolve(requestText, evidence) {
      const found: ResolvedRequestValue[] = [];
      const requestSurface = stripTerminalSentenceBoundary(requestText);
      const requests: Array<{ slots: Map<string, string>; anchors: DurableSourceConstructionExample["roles"]; answerBinding: SourceConstructionGraphBinding; relation?: string }> = [];
      for (const bundle of input.bundles) for (const construction of bundle.constructions) {
        const examples = bundle.sourceExamples.filter(example => construction.sourceExampleIds.includes(example.id));
        if (!examples.length) continue;
        const requestExamples = examples.filter(example => example.nullRoles.length === 1
          && Boolean(example.nullRoles[0]?.graphBinding)
          && example.roles.length > 0 && example.roles.every(role => Boolean(role.graphBinding) || isStructuralPredicateRole(role))
          );
        const slots = invertSurface(construction, createLearnedSurfaceInterpreter(requestSurface, true));
        if (!slots) continue;
        const realizationExamples = requestExamples.filter(example => example.roles.length === slots.size);
        for (const group of declarationGroups(realizationExamples)) {
          const matchingExamples = group.filter(example => rolesMatchSurface(example.roles, slots));
          if (!matchingExamples.length) continue;
          const exemplar = matchingExamples[0]!;
          const answerBinding = exemplar.nullRoles[0]!.graphBinding!;
          const anchors = exemplar.roles.filter(role => role.graphBinding);
          if (!anchors.length) continue;
          if (anchors.some(role => role.graphBinding!.relationId !== answerBinding.relationId)) continue;
          const predicates = new Map(matchingExamples.flatMap(example => example.roles.filter(isStructuralPredicateRole)
            .map(role => [normalizeCanonicalSurface(role.surface), role.surface] as const)));
          if (predicates.size > 1) continue;
          const relation = predicates.values().next().value as string | undefined;
          requests.push({ slots, anchors, answerBinding, ...(relation ? { relation } : {}) });
        }
      }
      if (!requests.length) return undefined;
      const nodes = new Map(input.graph.nodes.map(node => [String(node.id), node]));
      const graphFacts: SourceRoleFact[] = input.graph.hyperedges.map(edge => ({
        ...edge, evidenceIds: edge.evidenceIds.map(String), participantPorts: edge.participantPorts.map(port => ({
          ...port, evidenceIds: port.evidenceIds.map(String), surface: port.nodeId ? graphNodeSurface(nodes.get(String(port.nodeId))) : undefined
        }))
      }));
      const sourceFacts = [...graphFacts, ...interpretAcquiredSourceRoles(input.bundles, evidence)];
      for (const { slots, anchors, answerBinding, relation } of requests) {
        for (const edge of sourceFacts) {
          if (String(edge.relationId) !== answerBinding.relationId) continue;
          if (canonicalStringify(edge.qualifiers) !== canonicalStringify(answerBinding.qualifiers ?? {})
            || canonicalStringify(edge.modality) !== canonicalStringify(answerBinding.modality ?? {})
            || canonicalStringify(edge.temporalScope) !== canonicalStringify(answerBinding.temporalScope ?? {})) continue;
          const anchorSurfaces: string[] = [];
          const anchored = anchors.every(role => {
            const binding = role.graphBinding!;
            const surface = slots.get(role.occurrenceId);
            if (!surface || binding.relationId !== String(edge.relationId)) return false;
            const ports = edge.participantPorts.filter(port => matchesPort(port, binding) && port.surface !== undefined
              && normalizeCanonicalSurface(port.surface) === normalizeCanonicalSurface(surface));
            if (ports.length !== 1) return false;
            anchorSurfaces.push(surface);
            return true;
          });
          if (!anchored) continue;
          const ports = edge.participantPorts.filter(port => matchesPort(port, answerBinding));
          if (ports.length !== 1) continue;
          const port = ports[0]!;
          const value = port.surface;
          if (!value) continue;
          const ownerIds = new Set((port.evidenceIds.length ? port.evidenceIds : edge.evidenceIds).map(String));
          const evidenceIds = evidence.filter(span => span.status === "promoted" && ownerIds.has(String(span.id)) && surfaceContainsBoundValue(span.text, value)).map(span => String(span.id));
          if (!evidenceIds.length) continue;
          found.push({ value, evidenceIds, subject: anchorSurfaces.join(" "), ...(relation ? { relation } : {}),
            requestedRoleId: answerBinding.roleId, relationId: answerBinding.relationId });
        }
      }
      if (!found.length || new Set(found.map(row => canonicalStringify([row.value, row.subject, row.relation, row.requestedRoleId, row.relationId]))).size !== 1) return undefined;
      return { ...found[0]!, evidenceIds: [...new Set(found.flatMap(row => row.evidenceIds))] };
    }
  };
}

function matchesPort(port: SourceRoleFact["participantPorts"][number], binding: SourceConstructionGraphBinding): boolean {
  return port.realization === "observed" && port.roleId === binding.roleId && port.valueKind === binding.valueKind;
}

/** Interpret complete acquired declaratives; their declared ports condition the source relation, not token frequency. */
function interpretAcquiredSourceRoles(bundles: readonly DurableLanguageConstructionBundle[], evidence: readonly EvidenceSpan[]): SourceRoleFact[] {
  const sentences = evidence.filter(span => span.status === "promoted").flatMap(span => splitSurfaceSentences(span.text)
    .filter(sentence => span.text.includes(sentence)).map(surface => {
      let interpreter: LearnedSurfaceInterpreter | undefined;
      return { span, interpreter: () => interpreter ??= createLearnedSurfaceInterpreter(stripTerminalSentenceBoundary(surface), true) };
    }));
  const facts: SourceRoleFact[] = [];
  for (const bundle of bundles) for (const construction of bundle.constructions) {
    const examples = bundle.sourceExamples.filter(example => construction.sourceExampleIds.includes(example.id));
    const sourceExamples = examples.filter(example => example.nullRoles.length === 0
      && example.roles.length > 0 && example.roles.every(role => Boolean(role.graphBinding) || isStructuralPredicateRole(role)));
    for (const group of declarationGroups(sourceExamples)) {
      const exemplar = group[0]!;
      const boundRoles = exemplar.roles.filter(role => role.graphBinding);
      const scope = boundRoles[0]?.graphBinding;
      if (!scope) continue;
      const scopeKey = (binding: SourceConstructionGraphBinding) => canonicalStringify([
        binding.relationId, binding.qualifiers ?? {}, binding.modality ?? {}, binding.temporalScope ?? {}
      ]);
      if (!boundRoles.every(role => scopeKey(role.graphBinding!) === scopeKey(scope))) continue;
      for (const { span, interpreter } of sentences) {
        const slots = invertSurface(construction, interpreter());
        if (!slots || slots.size !== exemplar.roles.length || !rolesMatchSurface(exemplar.roles, slots, group)) continue;
        const participantPorts: SourceRoleFact["participantPorts"] = [];
        for (const role of boundRoles) {
          const value = slots.get(role.occurrenceId);
          if (!value) break;
          participantPorts.push({ ...role.graphBinding!, surface: value, realization: "observed", evidenceIds: [String(span.id)] });
        }
        if (participantPorts.length !== boundRoles.length) continue;
        facts.push({ relationId: scope.relationId, qualifiers: scope.qualifiers ?? {}, modality: scope.modality ?? {}, temporalScope: scope.temporalScope ?? {},
          participantPorts, evidenceIds: [String(span.id)] });
      }
    }
  }
  return facts;
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

function invertSurface(construction: LearnedConstruction, interpreter: LearnedSurfaceInterpreter): Map<string, string> | undefined {
  const sequence = [...construction.sequence];
  const last = sequence.at(-1);
  if (last?.kind === "literal") {
    const characters = [...last.surface];
    if (characters.length && isSentenceBoundarySymbol(characters.at(-1)!)) {
      characters.pop();
      const projected = characters.join("");
      if (projected) sequence[sequence.length - 1] = { ...last, surface: projected };
      else sequence.pop();
    }
  }
  const roles = interpreter.interpret({ sequence });
  return roles ? new Map(roles.map(role => [role.occurrenceId, role.surface])) : undefined;
}
