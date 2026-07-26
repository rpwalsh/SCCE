import type { SurfaceLattice, SurfaceLatticeUnit } from "./surface-lattice.js";
import { createHasher, toJsonValue } from "./primitives.js";
import type { Hasher, JsonValue } from "./types.js";

export const JOIN_PROGRAM_SCHEMA = "scce.join_program.v1" as const;
export const JOIN_PROGRAM_MIXTURE_SCHEMA = "scce.join_program_mixture.v1" as const;

export interface JoinProgramChoice {
  surface: string;
  count: number;
  probability: number;
  evidenceIds: string[];
}

export interface JoinProgramModel {
  schema: typeof JOIN_PROGRAM_SCHEMA;
  id: string;
  populationId: string;
  observations: number;
  exactIndex: Record<string, JoinProgramChoice[]>;
  shapeIndex: Record<string, JoinProgramChoice[]>;
  globalChoices: JoinProgramChoice[];
  sourceDocumentIds: string[];
  audit: JsonValue;
}

export interface JoinProgramMixture {
  schema: typeof JOIN_PROGRAM_MIXTURE_SCHEMA;
  id: string;
  populationModelId: string;
  components: Array<{
    populationId: string;
    weight: number;
    program: JoinProgramModel;
  }>;
}

export interface JoinProgramTraceStep {
  left: string;
  right: string;
  join: string;
  source: "exact" | "shape" | "population" | "unresolved";
  support: number;
  evidenceIds: string[];
}

export interface JoinedSurface {
  text: string;
  trace: JoinProgramTraceStep[];
  unresolvedBoundaries: number;
}

interface JoinCount {
  surface: string;
  count: number;
  evidenceIds: Set<string>;
}

export function compileJoinProgram(input: {
  populationId: string;
  documents: readonly {
    documentId: string;
    text: string;
    lattice: SurfaceLattice;
  }[];
  hasher?: Hasher;
}): JoinProgramModel {
  const hasher = input.hasher ?? createHasher();
  const exact = new Map<string, Map<string, JoinCount>>();
  const shape = new Map<string, Map<string, JoinCount>>();
  const global = new Map<string, JoinCount>();
  let observations = 0;
  for (const document of [...input.documents].sort((left, right) =>
    left.documentId.localeCompare(right.documentId))) {
    const unitsById = new Map(document.lattice.units.map(unit => [unit.id, unit]));
    for (const path of document.lattice.segmentationForest.paths) {
      const units = path.unitIds
        .map(unitId => requiredUnit(unitsById, unitId))
        .filter(isSurfaceBearingUnit);
      const pathWeight = Math.max(0, path.posterior);
      for (let index = 1; index < units.length; index += 1) {
        const left = units[index - 1]!;
        const right = units[index]!;
        const join = document.text.slice(left.utf16End, right.utf16Start);
        const evidenceIds = [...new Set([...left.evidenceIds, ...right.evidenceIds])].sort();
        addCount(exact, exactJoinKey(left.normalized, right.normalized), join, evidenceIds, pathWeight);
        addCount(shape, shapeJoinKey(left.surface, right.surface), join, evidenceIds, pathWeight);
        addJoinCount(global, join, evidenceIds, pathWeight);
        observations += pathWeight;
      }
    }
  }
  const exactIndex = compileIndex(exact);
  const shapeIndex = compileIndex(shape);
  const globalChoices = choices(global);
  const sourceDocumentIds = [...new Set(input.documents.map(document => document.documentId))].sort();
  const canonical = {
    schema: JOIN_PROGRAM_SCHEMA,
    populationId: input.populationId,
    observations: quantize(observations),
    exactIndex,
    shapeIndex,
    globalChoices,
    sourceDocumentIds
  };
  return {
    ...canonical,
    id: `join_program.${hasher.digestHex(JSON.stringify(canonical)).slice(0, 40)}`,
    audit: toJsonValue({
      compiler: "kernel.join_program.v1",
      exactContextCount: Object.keys(exactIndex).length,
      shapeContextCount: Object.keys(shapeIndex).length,
      sourceExactJoins: true,
      languageShapedFallback: false
    })
  };
}

export function compileJoinProgramMixture(input: {
  populationModelId: string;
  components: readonly {
    populationId: string;
    weight: number;
    program: JoinProgramModel;
  }[];
  hasher?: Hasher;
}): JoinProgramMixture {
  const hasher = input.hasher ?? createHasher();
  const components = [...input.components]
    .filter(component => component.weight > 0)
    .sort((left, right) => left.populationId.localeCompare(right.populationId))
    .map(component => ({ ...component, weight: quantize(component.weight) }));
  const canonical = {
    schema: JOIN_PROGRAM_MIXTURE_SCHEMA,
    populationModelId: input.populationModelId,
    components: components.map(component => ({
      populationId: component.populationId,
      weight: component.weight,
      programId: component.program.id
    }))
  };
  return {
    ...canonical,
    id: `join_program_mixture.${hasher.digestHex(JSON.stringify(canonical)).slice(0, 40)}`,
    components
  };
}

export function renderJoinedSurface(
  units: readonly string[],
  mixture: JoinProgramMixture | undefined
): JoinedSurface {
  if (!units.length) return { text: "", trace: [], unresolvedBoundaries: 0 };
  let text = units[0] ?? "";
  const trace: JoinProgramTraceStep[] = [];
  let unresolvedBoundaries = 0;
  for (let index = 1; index < units.length; index += 1) {
    const left = units[index - 1] ?? "";
    const right = units[index] ?? "";
    const selected = mixture ? selectJoin(mixture, left, right) : undefined;
    if (!selected) unresolvedBoundaries += 1;
    const join = selected?.surface ?? "";
    text += join + right;
    trace.push({
      left,
      right,
      join,
      source: selected?.source ?? "unresolved",
      support: selected?.support ?? 0,
      evidenceIds: selected?.evidenceIds ?? []
    });
  }
  return { text, trace, unresolvedBoundaries };
}

export function isJoinProgramMixture(value: unknown): value is JoinProgramMixture {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.schema === JOIN_PROGRAM_MIXTURE_SCHEMA
    && typeof row.id === "string"
    && typeof row.populationModelId === "string"
    && Array.isArray(row.components);
}

function selectJoin(
  mixture: JoinProgramMixture,
  left: string,
  right: string
): (JoinProgramChoice & { source: "exact" | "shape" | "population"; support: number }) | undefined {
  const exactKey = exactJoinKey(normalize(left), normalize(right));
  const shapeKey = shapeJoinKey(left, right);
  for (const [key, source] of [[exactKey, "exact"], [shapeKey, "shape"]] as const) {
    const candidates = aggregateChoices(mixture, key, source);
    if (candidates.length) return { ...candidates[0]!, source, support: candidates[0]!.probability };
  }
  const population = aggregateGlobalChoices(mixture);
  return population[0]
    ? { ...population[0], source: "population", support: population[0].probability }
    : undefined;
}

function aggregateChoices(
  mixture: JoinProgramMixture,
  key: string,
  source: "exact" | "shape"
): JoinProgramChoice[] {
  const counts = new Map<string, JoinCount>();
  for (const component of mixture.components) {
    const rows = source === "exact"
      ? component.program.exactIndex[key] ?? []
      : component.program.shapeIndex[key] ?? [];
    for (const row of rows) {
      const weighted = row.count * component.weight;
      const current = counts.get(row.surface) ?? {
        surface: row.surface,
        count: 0,
        evidenceIds: new Set<string>()
      };
      current.count += weighted;
      for (const id of row.evidenceIds) current.evidenceIds.add(id);
      counts.set(row.surface, current);
    }
  }
  return choices(counts);
}

function aggregateGlobalChoices(mixture: JoinProgramMixture): JoinProgramChoice[] {
  const counts = new Map<string, JoinCount>();
  for (const component of mixture.components) {
    for (const row of component.program.globalChoices) {
      const current = counts.get(row.surface) ?? {
        surface: row.surface,
        count: 0,
        evidenceIds: new Set<string>()
      };
      current.count += row.count * component.weight;
      for (const id of row.evidenceIds) current.evidenceIds.add(id);
      counts.set(row.surface, current);
    }
  }
  return choices(counts);
}

function addCount(
  index: Map<string, Map<string, JoinCount>>,
  key: string,
  surface: string,
  evidenceIds: readonly string[],
  weight: number
): void {
  const bucket = index.get(key) ?? new Map<string, JoinCount>();
  addJoinCount(bucket, surface, evidenceIds, weight);
  index.set(key, bucket);
}

function addJoinCount(
  bucket: Map<string, JoinCount>,
  surface: string,
  evidenceIds: readonly string[],
  weight: number
): void {
  const row = bucket.get(surface) ?? {
    surface,
    count: 0,
    evidenceIds: new Set<string>()
  };
  row.count += weight;
  for (const id of evidenceIds) row.evidenceIds.add(id);
  bucket.set(surface, row);
}

function requiredUnit(
  unitsById: ReadonlyMap<string, SurfaceLatticeUnit>,
  unitId: string
): SurfaceLatticeUnit {
  const unit = unitsById.get(unitId);
  if (!unit) throw new Error(`segmentation forest references missing unit ${unitId}`);
  return unit;
}

function isSurfaceBearingUnit(unit: SurfaceLatticeUnit): boolean {
  return unit.surface.length > 0
    && !/^\s+$/u.test(unit.surface)
    && !/^\p{Control}+$/u.test(unit.surface);
}

function compileIndex(index: ReadonlyMap<string, ReadonlyMap<string, JoinCount>>): Record<string, JoinProgramChoice[]> {
  return Object.fromEntries([...index.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, rows]) => [key, choices(rows)]));
}

function choices(rows: ReadonlyMap<string, JoinCount>): JoinProgramChoice[] {
  const total = [...rows.values()].reduce((sum, row) => sum + row.count, 0);
  return [...rows.values()]
    .map(row => ({
      surface: row.surface,
      count: quantize(row.count),
      probability: quantize(total > 0 ? row.count / total : 0),
      evidenceIds: [...row.evidenceIds].sort()
    }))
    .sort((left, right) =>
      right.count - left.count
      || left.surface.localeCompare(right.surface));
}

function exactJoinKey(left: string, right: string): string {
  return JSON.stringify([left, right]);
}

function shapeJoinKey(left: string, right: string): string {
  return JSON.stringify([boundaryShape([...left].at(-1) ?? ""), boundaryShape([...right][0] ?? "")]);
}

function boundaryShape(char: string): string {
  if (!char) return "empty";
  if (/\p{Letter}/u.test(char)) return "letter";
  if (/\p{Number}/u.test(char)) return "number";
  if (/\p{Mark}/u.test(char)) return "mark";
  if (/\p{Punctuation}/u.test(char)) return "punctuation";
  if (/\p{Symbol}/u.test(char)) return "symbol";
  if (/\p{Separator}/u.test(char)) return "separator";
  return "other";
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

function quantize(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}
