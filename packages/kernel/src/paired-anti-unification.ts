import { canonicalStringify, createHasher, toJsonValue } from "./primitives.js";
import type { ReversibleConstruction } from "./reversible-construction.js";
import type { LanguagePatternRecord } from "./storage.js";
import type { Hasher, JsonValue } from "./types.js";

export const PAIRED_ANTI_UNIFIED_CONSTRUCTION_SCHEMA =
  "scce.paired_anti_unified_construction.v1" as const;
export const PAIRED_ANTI_UNIFIED_PATTERN_SCHEMA =
  "scce.paired_anti_unified_construction_pattern.v1" as const;

export interface AntiUnifiedGraphVariable {
  id: string;
  structuralPortKey: string;
  kind: "relation" | "incidence";
  relationId: string;
  portId?: string;
  roleId?: string;
  valueKind?: string;
  realization?: "observed" | "omitted";
  examples: Array<{
    constructionId: string;
    graphTargetId: string;
    participantNodeId: string | null;
  }>;
}

export type AntiUnifiedSurfacePart =
  | { kind: "literal"; surface: string }
  | {
    kind: "slot";
    id: string;
    mode: "fixed" | "variable";
    fixedSurface: string | null;
    graphVariableIds: string[];
    observedSurfaces: string[];
  };

export interface PairedAntiUnifiedConstruction {
  schema: typeof PAIRED_ANTI_UNIFIED_CONSTRUCTION_SCHEMA;
  id: string;
  profileId: string;
  profileIds: string[];
  sourceConstructionIds: string[];
  sourceFamilyIds: string[];
  graphVariables: AntiUnifiedGraphVariable[];
  surfaceProgram: {
    parts: AntiUnifiedSurfacePart[];
    variableSlotIds: string[];
  };
  discourseConditions: ReversibleConstruction["discourseConditions"];
  populationPosteriors: Array<{
    constructionId: string;
    posterior: Array<{ populationId: string; probability: number }>;
  }>;
  support: {
    independentSourceFamilies: number;
    sourceConstructions: number;
    variableSurfaceSlots: number;
    minimumHeldoutCoverage: number;
    minimumCycleRecall: number;
    unsupportedAdditionCount: 0;
  };
  provenance: {
    evidenceIds: string[];
    promotionModelIds: string[];
    creationSnapshotIds: string[];
  };
  creationSnapshot: {
    id: string;
    createdAt: number;
  };
  executableDirections: ["interpretation", "realization"];
  audit: JsonValue;
}

export interface AntiUnifiedBinding {
  graphVariableId: string;
  graphTargetId: string;
  relationId: string;
  participantNodeId?: string;
  valueKind?: string;
  surface: string;
  evidenceIds?: readonly string[];
}

export type AntiUnifiedRealization =
  | {
    status: "realized";
    constructionId: string;
    text: string;
    graphTargetIds: string[];
    bindings: AntiUnifiedBinding[];
  }
  | {
    status: "rejected";
    constructionId: string;
    reasons: string[];
  };

export type AntiUnifiedInterpretation =
  | {
    status: "interpreted";
    constructionId: string;
    graphTargetIds: string[];
    bindings: AntiUnifiedBinding[];
  }
  | {
    status: "rejected";
    constructionId: string;
    reasons: string[];
  };

export interface PairedAntiUnificationCompilation {
  constructions: PairedAntiUnifiedConstruction[];
  rejections: Array<{
    shapeId: string;
    constructionIds: string[];
    reasons: string[];
  }>;
}

export function compilePairedAntiUnifiedConstructions(input: {
  constructions: readonly ReversibleConstruction[];
  minimumIndependentSourceFamilies?: number;
  createdAt: number;
  creationSnapshotId: string;
  hasher?: Hasher;
}): PairedAntiUnificationCompilation {
  const hasher = input.hasher ?? createHasher();
  const minimumFamilies = bounded(
    input.minimumIndependentSourceFamilies,
    2,
    32,
    2
  );
  const ineligible = input.constructions.filter(construction =>
    !promotedExactConstruction(construction));
  const prepared = input.constructions.flatMap(construction => {
    if (!promotedExactConstruction(construction)) return [];
    const value = prepareConstruction(construction, hasher);
    return value ? [value] : [];
  });
  const groups = new Map<string, PreparedConstruction[]>();
  for (const row of prepared) {
    const group = groups.get(row.shapeId) ?? [];
    group.push(row);
    groups.set(row.shapeId, group);
  }
  const constructions: PairedAntiUnifiedConstruction[] = [];
  const rejections: PairedAntiUnificationCompilation["rejections"] =
    ineligible.map(construction => ({
      shapeId: stableId(hasher, "anti_unify_ineligible", construction.id),
      constructionIds: [construction.id],
      reasons: ["source_construction_not_promoted"]
    }));

  for (const [shapeId, rawGroup] of [...groups.entries()].sort()) {
    const allRows = [...rawGroup].sort((left, right) =>
      left.construction.id.localeCompare(right.construction.id));
    const group = onePerFamily(allRows);
    const reasons: string[] = [];
    if (group.length < minimumFamilies) {
      reasons.push("independent_source_families_low");
    }
    const slotCount = group[0]?.slots.length ?? 0;
    const variableSlotIndexes: number[] = [];
    for (let index = 0; index < slotCount; index++) {
      const familyPairs = pairedSlotValuesByFamily(allRows, index);
      if ([...familyPairs.values()].some(values => values.length !== 1)) {
        reasons.push("within_family_pair_ambiguous");
        continue;
      }
      const surfaces = uniqueStrings(group.map(row =>
        row.slots[index]!.observedSurface));
      if (surfaces.length <= 1) continue;
      const graphBindings = uniqueStrings(group.map(row =>
        canonicalStringify(row.slots[index]!.structuralPortKeys.map(key =>
          row.portByStructuralKey.get(key)!.graphTargetId))));
      if (graphBindings.length <= 1) {
        reasons.push("surface_variation_without_graph_delta");
      } else {
        variableSlotIndexes.push(index);
      }
    }
    if (!variableSlotIndexes.length) reasons.push("localized_variable_missing");
    if (reasons.length || !group[0]) {
      rejections.push({
        shapeId,
        constructionIds: allRows.map(row => row.construction.id).sort(),
        reasons: uniqueStrings(reasons)
      });
      continue;
    }

    const graphVariables = group[0].orderedPorts.map(port => {
      const examples = allRows.map(row => {
        const source = row.portByStructuralKey.get(port.structuralPortKey)!;
        return {
          constructionId: row.construction.id,
          graphTargetId: source.graphTargetId,
          participantNodeId: source.participantNodeId ?? null
        };
      });
      return {
        id: stableId(hasher, "anti_unify_graph_variable", [
          shapeId,
          port.structuralPortKey
        ]),
        structuralPortKey: port.structuralPortKey,
        kind: port.kind,
        relationId: port.relationId,
        ...(port.portId ? { portId: port.portId } : {}),
        ...(port.roleId ? { roleId: port.roleId } : {}),
        ...(port.valueKind ? { valueKind: port.valueKind } : {}),
        ...(port.realization ? { realization: port.realization } : {}),
        examples
      };
    });
    const variableIdByKey = new Map(graphVariables.map(row => [
      row.structuralPortKey,
      row.id
    ]));
    const parts: AntiUnifiedSurfacePart[] = [];
    for (let index = 0; index < group[0].slots.length; index++) {
      const literal = group[0].literals[index]!;
      if (literal) parts.push({ kind: "literal", surface: literal });
      const source = group[0].slots[index]!;
      const observedSurfaces = uniqueStrings(group.map(row =>
        row.slots[index]!.observedSurface));
      const variable = variableSlotIndexes.includes(index);
      parts.push({
        kind: "slot",
        id: stableId(hasher, "anti_unify_surface_slot", [shapeId, index]),
        mode: variable ? "variable" : "fixed",
        fixedSurface: variable ? null : observedSurfaces[0]!,
        graphVariableIds: source.structuralPortKeys.map(key =>
          variableIdByKey.get(key)!),
        observedSurfaces
      });
    }
    const tail = group[0].literals[group[0].literals.length - 1]!;
    if (tail) parts.push({ kind: "literal", surface: tail });
    if (ambiguousAdjacentVariables(parts)) {
      rejections.push({
        shapeId,
        constructionIds: allRows.map(row => row.construction.id).sort(),
        reasons: ["adjacent_variable_boundary_unresolved"]
      });
      continue;
    }
    const profileIds = uniqueStrings(allRows.map(row =>
      row.construction.profileId));
    const canonical = {
      schema: PAIRED_ANTI_UNIFIED_CONSTRUCTION_SCHEMA,
      profileId: profileIds[0]!,
      profileIds,
      sourceConstructionIds: allRows.map(row => row.construction.id).sort(),
      sourceFamilyIds: uniqueStrings(allRows.map(row =>
        row.construction.surface.sourceFamilyId)),
      graphVariables,
      surfaceProgram: {
        parts,
        variableSlotIds: parts.flatMap(part =>
          part.kind === "slot" && part.mode === "variable" ? [part.id] : [])
      },
      discourseConditions: group[0].construction.discourseConditions,
      populationPosteriors: allRows.map(row => ({
        constructionId: row.construction.id,
        posterior: row.construction.populationPosterior
      })).sort((left, right) =>
        left.constructionId.localeCompare(right.constructionId)),
      support: {
        independentSourceFamilies: group.length,
        sourceConstructions: allRows.length,
        variableSurfaceSlots: variableSlotIndexes.length,
        minimumHeldoutCoverage: Math.min(...group.map(row =>
          row.construction.support.heldoutCoverage)),
        minimumCycleRecall: Math.min(...group.map(row =>
          row.construction.support.cycleRecall)),
        unsupportedAdditionCount: 0 as const
      },
      provenance: {
        evidenceIds: uniqueStrings(allRows.flatMap(row =>
          row.construction.provenance.evidenceIds)),
        promotionModelIds: uniqueStrings(allRows.map(row =>
          row.construction.promotionModelId)),
        creationSnapshotIds: uniqueStrings(allRows.map(row =>
          row.construction.creationSnapshot.id))
      },
      creationSnapshot: {
        id: input.creationSnapshotId,
        createdAt: input.createdAt
      },
      executableDirections: ["interpretation", "realization"] as
        ["interpretation", "realization"]
    };
    constructions.push({
      ...canonical,
      id: stableId(hasher, "paired_anti_unified_construction", canonical),
      audit: toJsonValue({
        compiler: "kernel.paired_anti_unification.lgg.v1",
        leastGeneralGeneralization: true,
        fixedCommonMaterialRetained: true,
        localizedGraphCorrelatedVariablesOnly: true,
        shuffledControlGateDeferredToItem28: true
      })
    });
  }
  return {
    constructions: constructions.sort((left, right) =>
      left.id.localeCompare(right.id)),
    rejections: rejections.sort((left, right) =>
      left.shapeId.localeCompare(right.shapeId))
  };
}

export function realizeAntiUnifiedConstruction(input: {
  construction: PairedAntiUnifiedConstruction;
  bindings: readonly AntiUnifiedBinding[];
}): AntiUnifiedRealization {
  const indexed = bindingMap(input.construction, input.bindings);
  if ("reasons" in indexed) {
    return {
      status: "rejected",
      constructionId: input.construction.id,
      reasons: indexed.reasons
    };
  }
  const output: string[] = [];
  for (const part of input.construction.surfaceProgram.parts) {
    if (part.kind === "literal") {
      output.push(part.surface);
      continue;
    }
    if (part.mode === "fixed") {
      if (part.graphVariableIds.some(id =>
        indexed.bindings.get(id)!.surface !== part.fixedSurface)) {
        return rejectedRealization(input.construction.id, [
          "fixed_surface_binding_mismatch"
        ]);
      }
      output.push(part.fixedSurface!);
      continue;
    }
    const surfaces = uniqueStrings(part.graphVariableIds.map(id =>
      indexed.bindings.get(id)!.surface));
    if (surfaces.length !== 1 || !surfaces[0]) {
      return rejectedRealization(input.construction.id, [
        "variable_surface_binding_ambiguous"
      ]);
    }
    output.push(surfaces[0]);
  }
  return {
    status: "realized",
    constructionId: input.construction.id,
    text: output.join(""),
    graphTargetIds: [...indexed.bindings.values()].map(row =>
      row.graphTargetId).sort(),
    bindings: [...indexed.bindings.values()].sort((left, right) =>
      left.graphVariableId.localeCompare(right.graphVariableId))
  };
}

export function interpretAntiUnifiedConstruction(input: {
  construction: PairedAntiUnifiedConstruction;
  surface: string;
  bindingCandidates: readonly AntiUnifiedBinding[];
}): AntiUnifiedInterpretation {
  const extracted = parseSurfaceProgram(
    input.construction.surfaceProgram.parts,
    input.surface
  );
  if ("reasons" in extracted) {
    return {
      status: "rejected",
      constructionId: input.construction.id,
      reasons: extracted.reasons
    };
  }
  const candidatesByVariable = new Map<string, AntiUnifiedBinding[]>();
  for (const candidate of input.bindingCandidates) {
    const rows = candidatesByVariable.get(candidate.graphVariableId) ?? [];
    rows.push({ ...candidate, evidenceIds: candidate.evidenceIds ?? [] });
    candidatesByVariable.set(candidate.graphVariableId, rows);
  }
  const selected: AntiUnifiedBinding[] = [];
  for (const variable of input.construction.graphVariables) {
    const slotSurfaces = input.construction.surfaceProgram.parts.flatMap(part =>
      part.kind === "slot" && part.graphVariableIds.includes(variable.id)
        ? [part.mode === "fixed"
          ? part.fixedSurface!
          : extracted.surfaces.get(part.id)!]
        : []);
    const expectedSurfaces = uniqueStrings(slotSurfaces);
    if (expectedSurfaces.length !== 1) {
      return rejectedInterpretation(input.construction.id, [
        "graph_variable_surface_ambiguous"
      ]);
    }
    const matches = (candidatesByVariable.get(variable.id) ?? []).filter(row =>
      row.surface === expectedSurfaces[0]
      && row.relationId === variable.relationId
      && (!variable.valueKind || row.valueKind === variable.valueKind));
    if (matches.length !== 1) {
      return rejectedInterpretation(input.construction.id, [
        matches.length ? "binding_candidate_ambiguous" : "binding_candidate_missing"
      ]);
    }
    selected.push(matches[0]!);
  }
  return {
    status: "interpreted",
    constructionId: input.construction.id,
    graphTargetIds: selected.map(row => row.graphTargetId).sort(),
    bindings: selected.sort((left, right) =>
      left.graphVariableId.localeCompare(right.graphVariableId))
  };
}

export function compilePairedAntiUnifiedPattern(
  construction: PairedAntiUnifiedConstruction
): LanguagePatternRecord {
  return compilePairedAntiUnifiedPatterns(construction)[0]!;
}

export function compilePairedAntiUnifiedPatterns(
  construction: PairedAntiUnifiedConstruction
): LanguagePatternRecord[] {
  return construction.profileIds.map(profileId => ({
    id: stableId(createHasher(), "paired_anti_unified_pattern", [
      construction.id,
      profileId
    ]),
    profileId,
    patternKind: "semantic_role",
    support: construction.support.independentSourceFamilies,
    entropy: 0,
    patternJson: toJsonValue({
      schema: PAIRED_ANTI_UNIFIED_PATTERN_SCHEMA,
      construction
    }),
    evidenceIds: construction.provenance.evidenceIds as
      LanguagePatternRecord["evidenceIds"],
    updatedAt: construction.creationSnapshot.createdAt
  }));
}

export function isPairedAntiUnifiedPattern(
  pattern: LanguagePatternRecord
): boolean {
  return recordOf(pattern.patternJson).schema ===
    PAIRED_ANTI_UNIFIED_PATTERN_SCHEMA;
}

export function pairedAntiUnifiedConstructionsFromPatterns(
  patterns: readonly LanguagePatternRecord[]
): PairedAntiUnifiedConstruction[] {
  const byId = new Map<string, PairedAntiUnifiedConstruction>();
  for (const pattern of patterns) {
    if (!isPairedAntiUnifiedPattern(pattern)) continue;
    const value = recordOf(pattern.patternJson).construction;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const parsed = value as unknown as PairedAntiUnifiedConstruction;
    const { id, audit: _audit, ...identityMaterial } = parsed;
    const expectedConstructionId = stableId(
      createHasher(),
      "paired_anti_unified_construction",
      identityMaterial
    );
    const expectedPatternId = stableId(
      createHasher(),
      "paired_anti_unified_pattern",
      [parsed.id, pattern.profileId]
    );
    if (parsed.schema !== PAIRED_ANTI_UNIFIED_CONSTRUCTION_SCHEMA
      || !parsed.profileIds?.includes(pattern.profileId)
      || parsed.profileId !== parsed.profileIds[0]
      || id !== expectedConstructionId
      || pattern.id !== expectedPatternId
      || canonicalStringify(uniqueStrings(parsed.provenance?.evidenceIds ?? []))
        !== canonicalStringify(uniqueStrings(pattern.evidenceIds.map(String)))) continue;
    byId.set(parsed.id, parsed);
  }
  return [...byId.values()].sort((left, right) =>
    left.id.localeCompare(right.id));
}

interface PreparedPort {
  structuralPortKey: string;
  graphTargetId: string;
  kind: "relation" | "incidence";
  relationId: string;
  participantNodeId?: string;
  portId?: string;
  roleId?: string;
  valueKind?: string;
  realization?: "observed" | "omitted";
}

interface PreparedSlot {
  observedSurface: string;
  structuralPortKeys: string[];
}

interface PreparedConstruction {
  construction: ReversibleConstruction;
  shapeId: string;
  orderedPorts: PreparedPort[];
  portByStructuralKey: Map<string, PreparedPort>;
  slots: PreparedSlot[];
  literals: string[];
}

function prepareConstruction(
  construction: ReversibleConstruction,
  hasher: Hasher
): PreparedConstruction | null {
  const slots = [...construction.surface.slots].sort((left, right) =>
    left.relativeUtf16Start - right.relativeUtf16Start
    || left.relativeUtf16End - right.relativeUtf16End
    || left.id.localeCompare(right.id));
  if (slots.some((slot, index) =>
    index > 0
    && slot.relativeUtf16Start < slots[index - 1]!.relativeUtf16End)) {
    return null;
  }
  const slotById = new Map(slots.map((slot, index) => [slot.id, index]));
  const basePorts = construction.graph.ports.map(port => ({
    port,
    signature: canonicalStringify({
      kind: port.kind,
      relationId: port.relationId,
      portId: port.portId ?? null,
      roleId: port.roleId ?? null,
      valueKind: port.valueKind ?? null,
      realization: port.realization ?? null,
      surfaceSlotIndexes: port.surfaceSlotIds.map(id => slotById.get(id) ?? -1)
        .sort((left, right) => left - right)
    })
  })).sort((left, right) =>
    left.signature.localeCompare(right.signature)
    || left.port.id.localeCompare(right.port.id));
  const signatureCount = new Map<string, number>();
  const orderedPorts: PreparedPort[] = basePorts.map(row => {
    const ordinal = signatureCount.get(row.signature) ?? 0;
    signatureCount.set(row.signature, ordinal + 1);
    return {
      structuralPortKey: `${row.signature}\u001f${ordinal}`,
      graphTargetId: row.port.graphTargetId,
      kind: row.port.kind,
      relationId: row.port.relationId,
      ...(row.port.participantNodeId
        ? { participantNodeId: row.port.participantNodeId }
        : {}),
      ...(row.port.portId ? { portId: row.port.portId } : {}),
      ...(row.port.roleId ? { roleId: row.port.roleId } : {}),
      ...(row.port.valueKind ? { valueKind: row.port.valueKind } : {}),
      ...(row.port.realization ? { realization: row.port.realization } : {})
    };
  });
  const keyByPortId = new Map(basePorts.map((row, index) => [
    row.port.id,
    orderedPorts[index]!.structuralPortKey
  ]));
  const preparedSlots = slots.map(slot => ({
    observedSurface: slot.observedSurface,
    structuralPortKeys: slot.graphPortIds.map(id => keyByPortId.get(id)!)
      .filter(Boolean)
      .sort()
  }));
  if (preparedSlots.some(slot => !slot.structuralPortKeys.length)) return null;
  const literals: string[] = [];
  let cursor = 0;
  for (const slot of slots) {
    literals.push(construction.surface.sourceSurface.slice(
      cursor,
      slot.relativeUtf16Start
    ));
    cursor = slot.relativeUtf16End;
  }
  literals.push(construction.surface.sourceSurface.slice(cursor));
  const shape = {
    discourseConditions: construction.discourseConditions,
    portKeys: orderedPorts.map(port => port.structuralPortKey),
    slotPortKeys: preparedSlots.map(slot => slot.structuralPortKeys),
    literals
  };
  return {
    construction,
    shapeId: stableId(hasher, "anti_unify_shape", shape),
    orderedPorts,
    portByStructuralKey: new Map(orderedPorts.map(port => [
      port.structuralPortKey,
      port
    ])),
    slots: preparedSlots,
    literals
  };
}

function onePerFamily(
  rows: readonly PreparedConstruction[]
): PreparedConstruction[] {
  const byFamily = new Map<string, PreparedConstruction>();
  for (const row of [...rows].sort((left, right) =>
    left.construction.id.localeCompare(right.construction.id))) {
    if (!byFamily.has(row.construction.surface.sourceFamilyId)) {
      byFamily.set(row.construction.surface.sourceFamilyId, row);
    }
  }
  return [...byFamily.values()].sort((left, right) =>
    left.construction.surface.sourceFamilyId.localeCompare(
      right.construction.surface.sourceFamilyId
    ));
}

function promotedExactConstruction(
  construction: ReversibleConstruction
): boolean {
  return construction.schema === "scce.reversible_construction.v1"
    && construction.executableDirections[0] === "interpretation"
    && construction.executableDirections[1] === "realization"
    && construction.support.inductionSourceFamilyIds.length >= 1
    && construction.support.independentHeldoutSourceFamilyIds.length >= 2
    && construction.support.heldoutCoverage === 1
    && construction.support.cycleRecall >= 0.98
    && construction.support.exactAnchorsPreserved
    && construction.support.unsupportedAdditionCount === 0
    && construction.provenance.evidenceIds.length > 0;
}

function pairedSlotValuesByFamily(
  rows: readonly PreparedConstruction[],
  slotIndex: number
): Map<string, string[]> {
  const values = new Map<string, string[]>();
  for (const row of rows) {
    const slot = row.slots[slotIndex];
    if (!slot) continue;
    const familyId = row.construction.surface.sourceFamilyId;
    const portTargets = slot.structuralPortKeys.map(key =>
      row.portByStructuralKey.get(key)!.graphTargetId);
    const signature = canonicalStringify([
      slot.observedSurface,
      portTargets
    ]);
    values.set(
      familyId,
      uniqueStrings([...(values.get(familyId) ?? []), signature])
    );
  }
  return values;
}

function bindingMap(
  construction: PairedAntiUnifiedConstruction,
  bindings: readonly AntiUnifiedBinding[]
): { bindings: Map<string, AntiUnifiedBinding> } | { reasons: string[] } {
  const expected = new Map(construction.graphVariables.map(variable => [
    variable.id,
    variable
  ]));
  const indexed = new Map<string, AntiUnifiedBinding>();
  const reasons: string[] = [];
  for (const binding of bindings) {
    const variable = expected.get(binding.graphVariableId);
    if (!variable) {
      reasons.push("unknown_graph_variable");
      continue;
    }
    if (indexed.has(binding.graphVariableId)) {
      reasons.push("duplicate_graph_variable_binding");
      continue;
    }
    if (!binding.graphTargetId || !binding.surface
      || binding.relationId !== variable.relationId
      || (variable.valueKind && binding.valueKind !== variable.valueKind)) {
      reasons.push("incompatible_graph_variable_binding");
      continue;
    }
    indexed.set(binding.graphVariableId, {
      ...binding,
      evidenceIds: binding.evidenceIds ?? []
    });
  }
  if ([...expected.keys()].some(id => !indexed.has(id))) {
    reasons.push("graph_variable_binding_missing");
  }
  return reasons.length ? { reasons: uniqueStrings(reasons) } : { bindings: indexed };
}

function parseSurfaceProgram(
  parts: readonly AntiUnifiedSurfacePart[],
  surface: string
): { surfaces: Map<string, string> } | { reasons: string[] } {
  const surfaces = new Map<string, string>();
  let cursor = 0;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (part.kind === "literal") {
      if (!surface.startsWith(part.surface, cursor)) {
        return { reasons: ["literal_surface_mismatch"] };
      }
      cursor += part.surface.length;
      continue;
    }
    if (part.mode === "fixed") {
      if (!surface.startsWith(part.fixedSurface!, cursor)) {
        return { reasons: ["fixed_surface_mismatch"] };
      }
      surfaces.set(part.id, part.fixedSurface!);
      cursor += part.fixedSurface!.length;
      continue;
    }
    const delimiter = parts.slice(index + 1).find(row =>
      row.kind === "literal" && row.surface.length
      || row.kind === "slot" && row.mode === "fixed"
        && Boolean(row.fixedSurface)) as AntiUnifiedSurfacePart | undefined;
    const delimiterSurface = delimiter?.kind === "literal"
      ? delimiter.surface
      : delimiter?.kind === "slot"
        ? delimiter.fixedSurface!
        : null;
    const end = delimiterSurface === null
      ? surface.length
      : surface.indexOf(delimiterSurface, cursor);
    if (end < cursor) return { reasons: ["variable_boundary_missing"] };
    const value = surface.slice(cursor, end);
    if (!value) return { reasons: ["variable_surface_empty"] };
    surfaces.set(part.id, value);
    cursor = end;
  }
  return cursor === surface.length
    ? { surfaces }
    : { reasons: ["surface_suffix_unconsumed"] };
}

function ambiguousAdjacentVariables(parts: readonly AntiUnifiedSurfacePart[]): boolean {
  return parts.some((part, index) =>
    part.kind === "slot"
    && part.mode === "variable"
    && parts[index + 1]?.kind === "slot"
    && (parts[index + 1] as Extract<AntiUnifiedSurfacePart, { kind: "slot" }>).mode
      === "variable");
}

function rejectedRealization(
  constructionId: string,
  reasons: string[]
): AntiUnifiedRealization {
  return { status: "rejected", constructionId, reasons: uniqueStrings(reasons) };
}

function rejectedInterpretation(
  constructionId: string,
  reasons: string[]
): AntiUnifiedInterpretation {
  return { status: "rejected", constructionId, reasons: uniqueStrings(reasons) };
}

function bounded(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  return Math.max(minimum, Math.min(maximum, Math.floor(value ?? fallback)));
}

function stableId(hasher: Hasher, namespace: string, value: unknown): string {
  return `${namespace}.${hasher.digestHex(canonicalStringify(value)).slice(0, 40)}`;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map(String))].sort();
}

function recordOf(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}
