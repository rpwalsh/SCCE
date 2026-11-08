// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { JOIN_PROGRAM_MIXTURE_SCHEMA, JOIN_PROGRAM_SCHEMA, isJoinProgramMixture, type JoinEvidenceCoordinate, type JoinProgramChoice, type JoinProgramMixture, type JoinProgramModel } from "./join-program.js";

export const JOIN_PROGRAM_MIXTURE_STORAGE_V1_SCHEMA = "scce.join_program_mixture.storage.v1" as const;
export const JOIN_PROGRAM_MIXTURE_STORAGE_SCHEMA = "scce.join_program_mixture.storage.v2" as const;
const INDEXES = ["conditionedIndex", "exactIndex", "structuralIndex", "classIndex", "localShapeIndex", "constructionIndex"] as const;
type ProgramIndex = typeof INDEXES[number];
type Atom = string | number | boolean | null;
type StoredKey = string | number[];
type StoredChoice = [number, number, number, number[], number[]];
type StoredProgram = { header: Omit<JoinProgramModel, ProgramIndex>; evidenceIdDictionary: string[]; evidenceCoordinateDictionary: JoinEvidenceCoordinate[];
  keyAtomDictionary: Atom[]; choiceDictionary: StoredChoice[]; indexes: Record<ProgramIndex, Array<[StoredKey, number[]]>> };
export interface StoredJoinProgramMixture {
  schema: typeof JOIN_PROGRAM_MIXTURE_STORAGE_SCHEMA;
  mixture: Omit<JoinProgramMixture, "components"> & { components: Array<{ populationId: string; weight: number; program: StoredProgram }> };
}
export interface LegacyStoredJoinProgramMixture { schema: typeof JOIN_PROGRAM_MIXTURE_STORAGE_V1_SCHEMA; mixture: unknown }
export type JoinProgramMixtureInput = JoinProgramMixture | StoredJoinProgramMixture | LegacyStoredJoinProgramMixture;

/** Intern repeated key atoms and complete choices without changing the public runtime indexes. */
export function joinProgramMixtureStorageForm(input: JoinProgramMixtureInput): StoredJoinProgramMixture {
  const mixture = joinProgramMixtureFromStorage(input);
  if (!mixture) throw new Error("invalid join-program mixture storage");
  const components = mixture.components.map(component => {
    const evidenceIds = new Set<string>();
    const coordinates = new Map<string, JoinEvidenceCoordinate>();
    const atoms = new Map<string, Atom>();
    const entries = new Map<ProgramIndex, Array<[string, JoinProgramChoice[]]>>();
    for (const indexName of INDEXES) {
      const rows = Object.entries(component.program[indexName]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      entries.set(indexName, rows);
      for (const [key, choices] of rows) {
        for (const atom of keyAtoms(key) ?? []) atoms.set(JSON.stringify(atom), atom);
        for (const choice of choices) {
          atoms.set(JSON.stringify(choice.surface), choice.surface);
          for (const id of choice.evidenceIds) evidenceIds.add(id);
          for (const coordinate of choice.evidenceCoordinates) coordinates.set(coordinateKey(coordinate), coordinate);
        }
      }
    }
    const evidenceIdDictionary = [...evidenceIds].sort();
    const evidenceCoordinateDictionary = [...coordinates].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value);
    const keyAtomDictionary = [...atoms].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value);
    const evidenceIndex = new Map(evidenceIdDictionary.map((id, index) => [id, index]));
    const coordinateIndex = new Map(evidenceCoordinateDictionary.map((value, index) => [coordinateKey(value), index]));
    const atomIndex = new Map(keyAtomDictionary.map((value, index) => [JSON.stringify(value), index]));
    const compactChoice = (choice: JoinProgramChoice): StoredChoice => [atomIndex.get(JSON.stringify(choice.surface))!, choice.count, choice.probability,
      choice.evidenceIds.map(id => evidenceIndex.get(id)!), choice.evidenceCoordinates.map(value => coordinateIndex.get(coordinateKey(value))!)];
    const choices = new Map<string, StoredChoice>();
    for (const rows of entries.values()) for (const [, values] of rows) for (const choice of values) {
      const compact = compactChoice(choice);
      choices.set(JSON.stringify(compact), compact);
    }
    const sortedChoices = [...choices].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const choiceDictionary = sortedChoices.map(([, value]) => value);
    const choiceIndex = new Map(sortedChoices.map(([key], index) => [key, index]));
    const indexes = Object.fromEntries(INDEXES.map(indexName => [indexName, entries.get(indexName)!.map(([key, values]) => {
      const parsed = keyAtoms(key);
      return [parsed ? parsed.map(atom => atomIndex.get(JSON.stringify(atom))!) : key, values.map(choice => choiceIndex.get(JSON.stringify(compactChoice(choice)))!)];
    })])) as StoredProgram["indexes"];
    const { conditionedIndex: _conditioned, exactIndex: _exact, structuralIndex: _structural, classIndex: _class, localShapeIndex: _local, constructionIndex: _construction, ...header } = component.program;
    return { ...component, program: { header, evidenceIdDictionary, evidenceCoordinateDictionary, keyAtomDictionary, choiceDictionary, indexes } };
  });
  return losslessSorted<StoredJoinProgramMixture>({ schema: JOIN_PROGRAM_MIXTURE_STORAGE_SCHEMA, mixture: { ...mixture, components } });
}

/** Decode both storage versions into the single existing runtime representation. */
export function joinProgramMixtureFromStorage(value: unknown): JoinProgramMixture | undefined {
  if (isJoinProgramMixture(value)) return value;
  const root = record(value);
  const version = root?.schema;
  if (version !== JOIN_PROGRAM_MIXTURE_STORAGE_SCHEMA && version !== JOIN_PROGRAM_MIXTURE_STORAGE_V1_SCHEMA) return undefined;
  const mixture = record(root?.mixture);
  if (!mixture || mixture.schema !== JOIN_PROGRAM_MIXTURE_SCHEMA || typeof mixture.id !== "string" || typeof mixture.populationModelId !== "string"
    || !finite(mixture.minimumConfidence) || !Array.isArray(mixture.components)) return undefined;
  const components: JoinProgramMixture["components"] = [];
  for (const rawComponent of mixture.components) {
    const component = record(rawComponent);
    const program = record(component?.program);
    const header = record(program?.header);
    if (!component || typeof component.populationId !== "string" || !finite(component.weight)
      || !program || !header || header.schema !== JOIN_PROGRAM_SCHEMA || !strings(program.evidenceIdDictionary)
      || !coordinateArray(program.evidenceCoordinateDictionary) || !record(program.indexes)) return undefined;
    const ids = program.evidenceIdDictionary;
    const coordinates = program.evidenceCoordinateDictionary;
    if (!unique(ids) || !unique(coordinates.map(coordinateKey))) return undefined;
    const indexes = program.indexes as Record<string, unknown>;
    let atoms: Atom[] = [];
    const choices: JoinProgramChoice[] = [];
    if (version === JOIN_PROGRAM_MIXTURE_STORAGE_SCHEMA) {
      if (!Array.isArray(program.keyAtomDictionary) || !program.keyAtomDictionary.every(atom)
        || !unique(program.keyAtomDictionary.map(value => JSON.stringify(value))) || !Array.isArray(program.choiceDictionary)) return undefined;
      atoms = program.keyAtomDictionary;
      const choiceKeys = new Set<string>();
      for (const raw of program.choiceDictionary) {
        if (!Array.isArray(raw) || raw.length !== 5 || !ref(raw[0], atoms.length) || typeof atoms[raw[0]] !== "string"
          || !finite(raw[1]) || !finite(raw[2]) || !refs(raw[3], ids.length) || !refs(raw[4], coordinates.length)) return undefined;
        const key = JSON.stringify(raw);
        if (choiceKeys.has(key)) return undefined;
        choiceKeys.add(key);
        choices.push(expandChoice(atoms[raw[0]] as string, raw[1], raw[2], raw[3], raw[4], ids, coordinates));
      }
    }
    const expandedIndexes: Partial<Pick<JoinProgramModel, ProgramIndex>> = {};
    for (const name of INDEXES) {
      const rows = indexes[name];
      if (!Array.isArray(rows)) return undefined;
      const expanded: Array<[string, JoinProgramChoice[]]> = [];
      const keys = new Set<string>();
      for (const entry of rows) {
        if (!Array.isArray(entry) || entry.length !== 2 || !Array.isArray(entry[1])) return undefined;
        let key: string;
        let values: JoinProgramChoice[];
        if (version === JOIN_PROGRAM_MIXTURE_STORAGE_SCHEMA) {
          if (typeof entry[0] === "string") key = entry[0];
          else if (refs(entry[0], atoms.length)) key = JSON.stringify(entry[0].map(index => atoms[index]));
          else return undefined;
          if (!refs(entry[1], choices.length)) return undefined;
          values = entry[1].map(index => { const choice = choices[index]!; return { ...choice, evidenceIds: [...choice.evidenceIds], evidenceCoordinates: [...choice.evidenceCoordinates] }; });
        } else {
          if (typeof entry[0] !== "string") return undefined;
          key = entry[0];
          values = [];
          for (const raw of entry[1]) {
            const choice = record(raw);
            if (!choice || typeof choice.surface !== "string" || !finite(choice.count) || !finite(choice.probability)
              || !refs(choice.evidenceIdRefs, ids.length) || !refs(choice.evidenceCoordinateRefs, coordinates.length)) return undefined;
            values.push(expandChoice(choice.surface, choice.count, choice.probability, choice.evidenceIdRefs, choice.evidenceCoordinateRefs, ids, coordinates));
          }
        }
        if (keys.has(key)) return undefined;
        keys.add(key);
        expanded.push([key, values]);
      }
      expandedIndexes[name] = Object.fromEntries(expanded);
    }
    components.push({ ...component, populationId: component.populationId, weight: component.weight, program: { ...header, ...expandedIndexes } as unknown as JoinProgramModel });
  }
  return { ...mixture, schema: JOIN_PROGRAM_MIXTURE_SCHEMA, id: mixture.id, populationModelId: mixture.populationModelId, minimumConfidence: mixture.minimumConfidence, components } as JoinProgramMixture;
}

function keyAtoms(key: string): Atom[] | undefined {
  try { const value: unknown = JSON.parse(key); return Array.isArray(value) && value.every(atom) && JSON.stringify(value) === key ? value : undefined; }
  catch { return undefined; }
}
function expandChoice(surface: string, count: number, probability: number, idRefs: number[], coordinateRefs: number[], ids: string[], coordinates: JoinEvidenceCoordinate[]): JoinProgramChoice {
  return { surface, count, probability, evidenceIds: idRefs.map(index => ids[index]!), evidenceCoordinates: coordinateRefs.map(index => coordinates[index]!) };
}
function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function atom(value: unknown): value is Atom { return value === null || typeof value === "string" || typeof value === "boolean" || finite(value); }
function ref(value: unknown, length: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < length; }
function refs(value: unknown, length: number): value is number[] { return Array.isArray(value) && value.every(index => ref(index, length)); }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === "string"); }
function unique(values: readonly string[]): boolean { return new Set(values).size === values.length; }
function losslessSorted<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => losslessSorted(item)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, losslessSorted(item)])) as T;
  return value;
}
function coordinateArray(value: unknown): value is JoinEvidenceCoordinate[] {
  return Array.isArray(value) && value.every(raw => { const row = record(raw); return row && typeof row.evidenceId === "string" && (row.sourceVersionId === undefined || typeof row.sourceVersionId === "string")
    && typeof row.documentId === "string" && finite(row.byteStart) && finite(row.byteEnd) && finite(row.utf16Start) && finite(row.utf16End) && typeof row.exactSurfaceHash === "string"; });
}
function coordinateKey(value: JoinEvidenceCoordinate): string { return JSON.stringify([value.evidenceId, value.sourceVersionId ?? null, value.documentId, value.byteStart, value.byteEnd, value.utf16Start, value.utf16End, value.exactSurfaceHash]); }
