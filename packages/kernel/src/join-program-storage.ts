// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { toJsonValue } from "./primitives.js";
import {
  JOIN_PROGRAM_MIXTURE_SCHEMA,
  JOIN_PROGRAM_SCHEMA,
  isJoinProgramMixture,
  type JoinEvidenceCoordinate,
  type JoinProgramChoice,
  type JoinProgramMixture,
  type JoinProgramModel
} from "./join-program.js";

export const JOIN_PROGRAM_MIXTURE_STORAGE_SCHEMA = "scce.join_program_mixture.storage.v1" as const;

const INDEXES = ["conditionedIndex", "exactIndex", "structuralIndex", "classIndex", "localShapeIndex", "constructionIndex"] as const;
type ProgramIndex = typeof INDEXES[number];
type ProgramIndexes = Pick<JoinProgramModel, ProgramIndex>;
type StoredChoice = { surface: string; count: number; probability: number; evidenceIdRefs: number[]; evidenceCoordinateRefs: number[] };
type StoredProgram = { header: Omit<JoinProgramModel, ProgramIndex>; evidenceIdDictionary: string[]; evidenceCoordinateDictionary: JoinEvidenceCoordinate[];
  indexes: Record<ProgramIndex, Array<[string, StoredChoice[]]>> };

export interface StoredJoinProgramMixture {
  schema: typeof JOIN_PROGRAM_MIXTURE_STORAGE_SCHEMA;
  mixture: Omit<JoinProgramMixture, "components"> & { components: Array<{ populationId: string; weight: number; program: StoredProgram }> };
}

export type JoinProgramMixtureInput = JoinProgramMixture | StoredJoinProgramMixture;

/** Store shared evidence references once per model; runtime consumers receive the expanded public shape. */
export function joinProgramMixtureStorageForm(mixture: JoinProgramMixtureInput): StoredJoinProgramMixture {
  if (isStoredJoinProgramMixture(mixture)) return mixture;
  const components = mixture.components.map(component => {
    const evidenceIds = new Set<string>();
    const coordinates = new Map<string, JoinEvidenceCoordinate>();
    for (const indexName of INDEXES) {
      for (const choices of Object.values(component.program[indexName])) {
        for (const choice of choices) {
          for (const evidenceId of choice.evidenceIds) evidenceIds.add(evidenceId);
          for (const coordinate of choice.evidenceCoordinates) coordinates.set(coordinateKey(coordinate), coordinate);
        }
      }
    }
    const evidenceIdDictionary = [...evidenceIds].sort();
    const evidenceCoordinateDictionary = [...coordinates.values()].sort(compareCoordinates);
    const evidenceIdIndex = new Map(evidenceIdDictionary.map((id, index) => [id, index]));
    const coordinateIndex = new Map(evidenceCoordinateDictionary.map((coordinate, index) => [coordinateKey(coordinate), index]));
    const indexes = Object.fromEntries(INDEXES.map(indexName => [indexName,
      Object.entries(component.program[indexName]).map(([key, choices]) => [key, choices.map(choice => ({
        surface: choice.surface,
        count: choice.count,
        probability: choice.probability,
        evidenceIdRefs: choice.evidenceIds.map(id => evidenceIdIndex.get(id)!),
        evidenceCoordinateRefs: choice.evidenceCoordinates.map(coordinate => coordinateIndex.get(coordinateKey(coordinate))!)
      }))])
    ])) as Record<ProgramIndex, Array<[string, StoredChoice[]]>>;
    const { conditionedIndex: _conditioned, exactIndex: _exact, structuralIndex: _structural, classIndex: _class,
      localShapeIndex: _localShape, constructionIndex: _construction, ...header } = component.program;
    return { populationId: component.populationId, weight: component.weight,
      program: { header, evidenceIdDictionary, evidenceCoordinateDictionary, indexes } };
  });
  return toJsonValue({ schema: JOIN_PROGRAM_MIXTURE_STORAGE_SCHEMA, mixture: {
    schema: mixture.schema, id: mixture.id, populationModelId: mixture.populationModelId,
    minimumConfidence: mixture.minimumConfidence, components
  } }) as unknown as StoredJoinProgramMixture;
}

/** Validate and expand persisted provenance before it enters the existing join-program runtime. */
export function joinProgramMixtureFromStorage(value: unknown): JoinProgramMixture | undefined {
  if (isJoinProgramMixture(value)) return value;
  if (!isStoredJoinProgramMixture(value)) return undefined;
  const components: JoinProgramMixture["components"] = [];
  for (const component of value.mixture.components) {
    const { header, evidenceIdDictionary, evidenceCoordinateDictionary, indexes } = component.program;
    const expandedIndexes: Partial<ProgramIndexes> = {};
    for (const indexName of INDEXES) {
      const expanded: Array<[string, JoinProgramChoice[]]> = [];
      for (const [key, rawChoices] of indexes[indexName]) {
        const choices: JoinProgramChoice[] = [];
        for (const choice of rawChoices) {
          if (!validRefs(choice.evidenceIdRefs, evidenceIdDictionary.length)
            || !validRefs(choice.evidenceCoordinateRefs, evidenceCoordinateDictionary.length)) return undefined;
          choices.push({ surface: choice.surface, count: choice.count, probability: choice.probability,
            evidenceIds: choice.evidenceIdRefs.map(index => evidenceIdDictionary[index]!),
            evidenceCoordinates: choice.evidenceCoordinateRefs.map(index => evidenceCoordinateDictionary[index]!) });
        }
        expanded.push([key, choices]);
      }
      expandedIndexes[indexName] = Object.fromEntries(expanded);
    }
    components.push({ populationId: component.populationId, weight: component.weight,
      program: { ...header, ...expandedIndexes } as JoinProgramModel });
  }
  const expanded = { ...value.mixture, components };
  return isJoinProgramMixture(expanded) ? expanded : undefined;
}

function isStoredJoinProgramMixture(value: unknown): value is StoredJoinProgramMixture {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const root = value as Record<string, unknown>;
  if (root.schema !== JOIN_PROGRAM_MIXTURE_STORAGE_SCHEMA || !root.mixture || typeof root.mixture !== "object" || Array.isArray(root.mixture)) return false;
  const mixture = root.mixture as Record<string, unknown>;
  if (mixture.schema !== JOIN_PROGRAM_MIXTURE_SCHEMA || typeof mixture.id !== "string" || typeof mixture.populationModelId !== "string"
    || typeof mixture.minimumConfidence !== "number" || !Array.isArray(mixture.components)) return false;
  return mixture.components.every(component => {
    if (!component || typeof component !== "object" || Array.isArray(component)) return false;
    const row = component as Record<string, unknown>;
    if (typeof row.populationId !== "string" || typeof row.weight !== "number" || !row.program || typeof row.program !== "object" || Array.isArray(row.program)) return false;
    const program = row.program as Record<string, unknown>;
    const header = program.header as Record<string, unknown> | undefined;
    if (!header || typeof header !== "object" || Array.isArray(header) || header.schema !== JOIN_PROGRAM_SCHEMA
      || !stringArray(program.evidenceIdDictionary) || !coordinateArray(program.evidenceCoordinateDictionary)
      || !program.indexes || typeof program.indexes !== "object" || Array.isArray(program.indexes)) return false;
    const indexes = program.indexes as Record<string, unknown>;
    return INDEXES.every(indexName => {
      const index = indexes[indexName];
      if (!Array.isArray(index)) return false;
      return index.every(entry => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string"
        && Array.isArray(entry[1]) && entry[1].every(choice => {
        if (!choice || typeof choice !== "object" || Array.isArray(choice)) return false;
        const item = choice as Record<string, unknown>;
        return typeof item.surface === "string" && typeof item.count === "number" && typeof item.probability === "number"
          && Array.isArray(item.evidenceIdRefs) && Array.isArray(item.evidenceCoordinateRefs);
      }));
    });
  });
}

function validRefs(values: readonly number[], dictionaryLength: number): boolean {
  return values.every(index => Number.isSafeInteger(index) && index >= 0 && index < dictionaryLength);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function coordinateArray(value: unknown): value is JoinEvidenceCoordinate[] {
  return Array.isArray(value) && value.every(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const row = raw as Record<string, unknown>;
    return typeof row.evidenceId === "string" && (row.sourceVersionId === undefined || typeof row.sourceVersionId === "string")
      && typeof row.documentId === "string" && typeof row.byteStart === "number" && typeof row.byteEnd === "number"
      && typeof row.utf16Start === "number" && typeof row.utf16End === "number" && typeof row.exactSurfaceHash === "string";
  });
}

function coordinateKey(value: JoinEvidenceCoordinate): string {
  return JSON.stringify([value.evidenceId, value.sourceVersionId ?? null, value.documentId,
    value.byteStart, value.byteEnd, value.utf16Start, value.utf16End, value.exactSurfaceHash]);
}

function compareCoordinates(left: JoinEvidenceCoordinate, right: JoinEvidenceCoordinate): number {
  return coordinateKey(left).localeCompare(coordinateKey(right));
}
