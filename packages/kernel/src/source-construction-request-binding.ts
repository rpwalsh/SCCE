// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { DurableLanguageConstructionBundle, DurableSourceConstructionExample, SourceConstructionGraphBinding } from "./language-construction-memory.js";
import type { LearnedConstruction } from "./language-construction.js";
import type { RequestValueResolver, ResolvedRequestValue } from "./semantic-answer-construct.js";
import { graphNodeSurface } from "./semantic-proof-adapter.js";
import { canonicalStringify } from "./primitives.js";
import { splitSurfaceSentences, surfaceContainsBoundValue } from "./surface-linguistics.js";
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
      const requestInterpreter = createLearnedSurfaceInterpreter(requestText, true);
      const requests: Array<{ slots: Map<string, string>; anchors: DurableSourceConstructionExample["roles"]; answerBinding: SourceConstructionGraphBinding }> = [];
      for (const bundle of input.bundles) for (const construction of bundle.constructions) {
        const slots = invertSurface(construction, requestInterpreter);
        if (!slots) continue;
        const examples = bundle.sourceExamples.filter(example => construction.sourceExampleIds.includes(example.id));
        if (!examples.length) continue;
        const exemplar = examples[0]!;
        const requested = exemplar.nullRoles.filter(role => role.graphBinding);
        if (requested.length !== 1) continue;
        const answerRole = requested[0]!;
        const answerBinding = answerRole.graphBinding!;
        if (!examples.every(example => sameDeclarations(exemplar, example))) continue;
        const anchors = exemplar.roles.filter(role => role.graphBinding);
        if (!anchors.length || anchors.length !== slots.size) continue;
        requests.push({ slots, anchors, answerBinding });
      }
      if (!requests.length) return undefined;
      const nodes = new Map(input.graph.nodes.map(node => [String(node.id), node]));
      const graphFacts: SourceRoleFact[] = input.graph.hyperedges.map(edge => ({
        ...edge, evidenceIds: edge.evidenceIds.map(String), participantPorts: edge.participantPorts.map(port => ({
          ...port, evidenceIds: port.evidenceIds.map(String), surface: port.nodeId ? graphNodeSurface(nodes.get(String(port.nodeId))) : undefined
        }))
      }));
      const sourceFacts = [...graphFacts, ...interpretAcquiredSourceRoles(input.bundles, evidence)];
      for (const { slots, anchors, answerBinding } of requests) {
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
          found.push({ value, evidenceIds, subject: anchorSurfaces.join(" "), relation: answerBinding.roleId, relationId: answerBinding.relationId });
        }
      }
      if (!found.length || new Set(found.map(row => canonicalStringify([row.value, row.subject, row.relationId]))).size !== 1) return undefined;
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
      return { span, normalized: normalizeCanonicalSurface(surface), interpreter: () => interpreter ??= createLearnedSurfaceInterpreter(surface, true) };
    }));
  const facts: SourceRoleFact[] = [];
  for (const bundle of bundles) for (const construction of bundle.constructions) {
    const examples = bundle.sourceExamples.filter(example => construction.sourceExampleIds.includes(example.id));
    const exemplar = examples[0];
    if (!exemplar || exemplar.nullRoles.length || !exemplar.roles.length
      || !exemplar.roles.every(role => role.graphBinding)
      || !examples.every(example => sameDeclarations(exemplar, example))) continue;
    const scope = exemplar.roles[0]!.graphBinding!;
    const scopeKey = (binding: SourceConstructionGraphBinding) => canonicalStringify([
      binding.relationId, binding.qualifiers ?? {}, binding.modality ?? {}, binding.temporalScope ?? {}
    ]);
    if (!exemplar.roles.every(role => scopeKey(role.graphBinding!) === scopeKey(scope))) continue;
    const literals = construction.sequence.flatMap(part => part.kind === "literal" && part.surface ? [part.surface] : []);
    const anchor = literals.sort((left, right) => right.length - left.length)[0];
    if (!anchor) continue;
    const normalizedAnchor = normalizeCanonicalSurface(anchor);
    for (const { span, normalized, interpreter } of sentences) {
      if (!normalized.includes(normalizedAnchor)) continue;
      const slots = invertSurface(construction, interpreter());
      if (!slots || slots.size !== exemplar.roles.length) continue;
      const participantPorts: SourceRoleFact["participantPorts"] = [];
      for (const role of exemplar.roles) {
        const value = slots.get(role.occurrenceId);
        if (!value) break;
        participantPorts.push({ ...role.graphBinding!, surface: value, realization: "observed", evidenceIds: [String(span.id)] });
      }
      if (participantPorts.length !== exemplar.roles.length) continue;
      facts.push({ relationId: scope.relationId, qualifiers: scope.qualifiers ?? {}, modality: scope.modality ?? {}, temporalScope: scope.temporalScope ?? {},
        participantPorts, evidenceIds: [String(span.id)] });
    }
  }
  return facts;
}

function sameDeclarations(left: DurableSourceConstructionExample, right: DurableSourceConstructionExample): boolean {
  const declarations = (example: DurableSourceConstructionExample) => [
    example.roles.map(role => [role.occurrenceId, role.graphBinding ?? null]),
    example.nullRoles.map(role => [role.occurrenceId, role.graphBinding ?? null])
  ];
  return canonicalStringify(declarations(left)) === canonicalStringify(declarations(right));
}

function invertSurface(construction: LearnedConstruction, interpreter: LearnedSurfaceInterpreter): Map<string, string> | undefined {
  const roles = interpreter.interpret(construction);
  return roles ? new Map(roles.map(role => [role.occurrenceId, role.surface])) : undefined;
}
