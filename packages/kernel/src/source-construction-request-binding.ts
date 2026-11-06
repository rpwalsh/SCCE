// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { DurableLanguageConstructionBundle, DurableSourceConstructionExample, SourceConstructionGraphBinding } from "./language-construction-memory.js";
import type { LearnedConstruction } from "./language-construction.js";
import type { RequestValueResolver, ResolvedRequestValue } from "./semantic-answer-construct.js";
import { graphNodeSurface } from "./semantic-proof-adapter.js";
import { canonicalStringify } from "./primitives.js";
import { splitSurfaceSentences, surfaceContainsBoundValue } from "./surface-linguistics.js";
import type { EvidenceSpan, GraphSnapshot, JsonValue } from "./types.js";

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
  const nodes = new Map(input.graph.nodes.map(node => [String(node.id), node]));
  const graphFacts: SourceRoleFact[] = input.graph.hyperedges.map(edge => ({
    ...edge, evidenceIds: edge.evidenceIds.map(String), participantPorts: edge.participantPorts.map(port => ({
      ...port, evidenceIds: port.evidenceIds.map(String), surface: port.nodeId ? graphNodeSurface(nodes.get(String(port.nodeId))) : undefined
    }))
  }));
  return {
    id: "resolver.acquired_source_construction",
    resolve(requestText, evidence) {
      const found: ResolvedRequestValue[] = [];
      const sourceFacts = [...graphFacts, ...interpretAcquiredSourceRoles(input.bundles, evidence)];
      for (const bundle of input.bundles) for (const construction of bundle.constructions) {
        const slots = invertSurface(construction, requestText);
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
            const ports = edge.participantPorts.filter(port => matchesPort(port, binding) && port.surface === surface);
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
    .filter(sentence => span.text.includes(sentence)).map(surface => ({ span, surface })));
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
    for (const { span, surface } of sentences) {
      if (!surface.includes(anchor)) continue;
      const slots = invertSurface(construction, surface);
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

function invertSurface(construction: LearnedConstruction, surface: string): Map<string, string> | undefined {
  if (!construction.sequence.some(part => part.kind === "literal" && part.surface)) return undefined;
  const memo = new Map<string, Array<Map<string, string>>>();
  const parse = (index: number, cursor: number): Array<Map<string, string>> => {
    if (index === construction.sequence.length) return cursor === surface.length ? [new Map()] : [];
    const key = `${index}:${cursor}`;
    const cached = memo.get(key);
    if (cached) return cached;
    const part = construction.sequence[index]!;
    if (part.kind === "literal") {
      const result = surface.startsWith(part.surface, cursor) ? parse(index + 1, cursor + part.surface.length) : [];
      memo.set(key, result);
      return result;
    }
    const next = construction.sequence[index + 1];
    if (next?.kind === "slot") return [];
    const results: Array<Map<string, string>> = [];
    let end = next?.kind === "literal" ? surface.indexOf(next.surface, cursor + 1) : surface.length;
    while (end > cursor) {
      for (const suffix of parse(index + 1, end)) {
        results.push(new Map([...suffix, [part.occurrenceId, surface.slice(cursor, end)]]));
        if (results.length > 1) { memo.set(key, results); return results; }
      }
      if (!next) break;
      end = surface.indexOf(next.surface, end + 1);
    }
    memo.set(key, results);
    return results;
  };
  const matches = parse(0, 0);
  return matches.length === 1 ? matches[0] : undefined;
}
