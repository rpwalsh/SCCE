import type { JsonValue } from "./types.js";
import { createIdFactory } from "./ids.js";
import { createClock, createHasher } from "./primitives.js";

const CORPUS_ID_FACTORY = createIdFactory({
  clock: createClock({ fixedTime: 0, stepMs: 1 }),
  hasher: createHasher(),
  deterministicReplay: true,
  namespace: "corpus-registry"
});

export type CorpusSourceSystemId = string & { readonly __corpusSourceSystemId?: never };
export type CorpusSourceSystemLabel = string;
export type CorpusRoleId = string & { readonly __corpusRoleId?: never };

function corpusSourceId(namespace: string, canonicalUri: string): CorpusSourceSystemId {
  return String(CORPUS_ID_FACTORY.sourceId(namespace, canonicalUri)) as CorpusSourceSystemId;
}

function corpusRoleId(canonicalUri: string): CorpusRoleId {
  return CORPUS_ID_FACTORY.semanticId("corpus_role", { canonicalUri }) as CorpusRoleId;
}

export const CORPUS_SOURCE_SYSTEM_IDS = {
  legacyScce2: corpusSourceId("legacy-import", "scce://scce2-imported-priors"),
  wikipedia: corpusSourceId("corpus", "https://www.wikimedia.org/"),
  gutenberg: corpusSourceId("corpus", "https://www.gutenberg.org/"),
  ossDocs: corpusSourceId("corpus", "repo://software-documentation"),
  ossCode: corpusSourceId("corpus", "repo://software-symbols"),
  workspace: corpusSourceId("corpus", "workspace://local"),
  corrections: corpusSourceId("corpus", "conversation://corrections")
} as const;

export const DEFAULT_CORPUS_SOURCE_SYSTEMS = [
  CORPUS_SOURCE_SYSTEM_IDS.corrections,
  CORPUS_SOURCE_SYSTEM_IDS.workspace,
  CORPUS_SOURCE_SYSTEM_IDS.wikipedia,
  CORPUS_SOURCE_SYSTEM_IDS.gutenberg,
  CORPUS_SOURCE_SYSTEM_IDS.ossDocs,
  CORPUS_SOURCE_SYSTEM_IDS.ossCode
] as const;

export type DefaultCorpusSourceSystem = (typeof DEFAULT_CORPUS_SOURCE_SYSTEMS)[number];

export const CORPUS_SOURCE_ALIASES: Record<string, CorpusSourceSystemId> = {
  scce2: CORPUS_SOURCE_SYSTEM_IDS.legacyScce2,
  wikimedia: CORPUS_SOURCE_SYSTEM_IDS.wikipedia,
  wikipedia: CORPUS_SOURCE_SYSTEM_IDS.wikipedia,
  gutenberg: CORPUS_SOURCE_SYSTEM_IDS.gutenberg,
  oss_docs: CORPUS_SOURCE_SYSTEM_IDS.ossDocs,
  oss_code: CORPUS_SOURCE_SYSTEM_IDS.ossCode,
  workspace: CORPUS_SOURCE_SYSTEM_IDS.workspace,
  corrections: CORPUS_SOURCE_SYSTEM_IDS.corrections
};

const CORPUS_SOURCE_LABELS = new Map<CorpusSourceSystemId, CorpusSourceSystemLabel>([
  [CORPUS_SOURCE_SYSTEM_IDS.legacyScce2, "scce2"],
  [CORPUS_SOURCE_SYSTEM_IDS.wikipedia, "wikipedia"],
  [CORPUS_SOURCE_SYSTEM_IDS.gutenberg, "gutenberg"],
  [CORPUS_SOURCE_SYSTEM_IDS.ossDocs, "oss_docs"],
  [CORPUS_SOURCE_SYSTEM_IDS.ossCode, "oss_code"],
  [CORPUS_SOURCE_SYSTEM_IDS.workspace, "workspace"],
  [CORPUS_SOURCE_SYSTEM_IDS.corrections, "corrections"]
]);

export const CORPUS_ROLE_IDS = {
  importedPrior: corpusRoleId("scce://role/imported-prior"),
  interactionCorrection: corpusRoleId("scce://role/interaction-correction"),
  workspace: corpusRoleId("scce://role/workspace"),
  encyclopedic: corpusRoleId("scce://role/encyclopedic"),
  publicDomainProse: corpusRoleId("scce://role/public-domain-prose"),
  softwareDocumentation: corpusRoleId("scce://role/software-documentation"),
  softwareSymbolic: corpusRoleId("scce://role/software-symbolic"),
  custom: corpusRoleId("scce://role/custom")
} as const;

export interface CorpusNgramSettings {
  maxOrder: number;
  maxCountersPerOrder: number;
  vocabularyLimit: number;
}

export interface CorpusHydrationLimits {
  ngramModels: number;
  ngramObservations: number;
  languageUnits: number;
  languagePatterns: number;
  semanticFrames: number;
}

export interface CorpusRegistryEntry {
  /** Source-derived label used by storage queries, reports, and provenance. */
  sourceSystem: CorpusSourceSystemLabel;
  /** Opaque deterministic identity used for cognition and registry joins. */
  sourceSystemId: CorpusSourceSystemId;
  sourceAlias?: string;
  enabled: boolean;
  corpusKindId: CorpusRoleId;
  corpusRoleId: CorpusRoleId;
  languageMemoryEligible: boolean;
  graphEvidenceEligible: boolean;
  hydration: {
    priority: number;
    weight: number;
    limits: CorpusHydrationLimits;
  };
  ngram: CorpusNgramSettings;
  localPath?: string;
  downloadPath?: string;
  metadata?: JsonValue;
}

export type CorpusRegistryOverride = Partial<Omit<CorpusRegistryEntry, "sourceSystem" | "hydration" | "ngram">> & {
  sourceSystem: CorpusSourceSystemLabel | CorpusSourceSystemId;
  hydration?: {
    priority?: number;
    weight?: number;
    limits?: Partial<CorpusHydrationLimits>;
  };
  ngram?: Partial<CorpusNgramSettings>;
};

export interface CorpusHydrationPlanEntry {
  sourceSystem: CorpusSourceSystemLabel;
  sourceSystemId: CorpusSourceSystemId;
  querySourceSystems: string[];
  priority: number;
  weight: number;
  limits: CorpusHydrationLimits;
}

const DEFAULT_HYDRATION_LIMITS: CorpusHydrationLimits = {
  ngramModels: 24,
  ngramObservations: 8000,
  languageUnits: 1536,
  languagePatterns: 384,
  semanticFrames: 768
};

const DEFAULT_NGRAM_SETTINGS: CorpusNgramSettings = {
  maxOrder: 4,
  maxCountersPerOrder: 128,
  vocabularyLimit: 8192
};

const DEFAULT_REGISTRY: CorpusRegistryEntry[] = [
  entry(CORPUS_SOURCE_SYSTEM_IDS.corrections, "corrections", CORPUS_ROLE_IDS.interactionCorrection, 95, 1, false, {
    ngramModels: 12,
    ngramObservations: 12000,
    languageUnits: 2048,
    languagePatterns: 512,
    semanticFrames: 512
  }),
  entry(CORPUS_SOURCE_SYSTEM_IDS.workspace, "workspace", CORPUS_ROLE_IDS.workspace, 90, 0.92, true),
  entry(CORPUS_SOURCE_SYSTEM_IDS.wikipedia, "wikipedia", CORPUS_ROLE_IDS.encyclopedic, 80, 0.9, true),
  entry(CORPUS_SOURCE_SYSTEM_IDS.gutenberg, "gutenberg", CORPUS_ROLE_IDS.publicDomainProse, 70, 0.78, true),
  entry(CORPUS_SOURCE_SYSTEM_IDS.ossDocs, "oss_docs", CORPUS_ROLE_IDS.softwareDocumentation, 64, 0.72, true),
  entry(CORPUS_SOURCE_SYSTEM_IDS.ossCode, "oss_code", CORPUS_ROLE_IDS.softwareSymbolic, 58, 0.62, true, {
    ngramModels: 16,
    ngramObservations: 6000,
    languageUnits: 1024,
    languagePatterns: 256,
    semanticFrames: 512
  })
];

export function createCorpusRegistry(overrides: readonly CorpusRegistryOverride[] = []): CorpusRegistryEntry[] {
  const bySource = new Map<string, CorpusRegistryEntry>();
  for (const item of DEFAULT_REGISTRY) bySource.set(item.sourceSystemId, cloneEntry(item));
  for (const override of overrides) {
    const sourceSystemId = canonicalCorpusSourceSystemId(override.sourceSystemId ?? override.sourceSystem);
    const sourceSystem = override.sourceAlias ?? corpusSourceAlias(override.sourceSystem);
    const current = bySource.get(sourceSystemId) ?? entry(sourceSystemId, sourceSystem, roleIdForSource(sourceSystemId), 0, 0.5, false);
    bySource.set(sourceSystemId, mergeEntry(current, { ...override, sourceSystem, sourceSystemId, sourceAlias: sourceSystem }));
  }
  return [...bySource.values()]
    .filter(item => item.sourceSystem.trim().length > 0)
    .sort((a, b) => b.hydration.priority - a.hydration.priority || a.sourceSystem.localeCompare(b.sourceSystem));
}

export function languageMemoryEligibleCorpora(registry: readonly CorpusRegistryEntry[]): CorpusRegistryEntry[] {
  return registry
    .filter(item => item.enabled && item.languageMemoryEligible)
    .sort((a, b) => b.hydration.priority - a.hydration.priority || b.hydration.weight - a.hydration.weight || a.sourceSystem.localeCompare(b.sourceSystem));
}

export function languageMemoryHydrationPlan(
  registry: readonly CorpusRegistryEntry[],
  totals: Partial<CorpusHydrationLimits> = {}
): CorpusHydrationPlanEntry[] {
  const eligible = languageMemoryEligibleCorpora(registry);
  const totalLimits = {
    ngramModels: totals.ngramModels ?? 144,
    ngramObservations: totals.ngramObservations ?? 24000,
    languageUnits: totals.languageUnits ?? 8192,
    languagePatterns: totals.languagePatterns ?? 2048,
    semanticFrames: totals.semanticFrames ?? 4096
  };
  return eligible.map(item => ({
    sourceSystem: item.sourceSystem,
    sourceSystemId: item.sourceSystemId,
    querySourceSystems: corpusQuerySourceSystems(item),
    priority: item.hydration.priority,
    weight: item.hydration.weight,
    limits: {
      ngramModels: boundedLimit(item.hydration.limits.ngramModels, totalLimits.ngramModels),
      ngramObservations: boundedLimit(item.hydration.limits.ngramObservations, totalLimits.ngramObservations),
      languageUnits: boundedLimit(item.hydration.limits.languageUnits, totalLimits.languageUnits),
      languagePatterns: boundedLimit(item.hydration.limits.languagePatterns, totalLimits.languagePatterns),
      semanticFrames: boundedLimit(item.hydration.limits.semanticFrames, totalLimits.semanticFrames)
    }
  }));
}

export function corpusNgramSettings(registry: readonly CorpusRegistryEntry[], sourceSystem: CorpusSourceSystemId): CorpusNgramSettings {
  const canonical = canonicalCorpusSourceSystemId(sourceSystem);
  return registry.find(item => item.sourceSystemId === canonical)?.ngram ?? DEFAULT_NGRAM_SETTINGS;
}

export function canonicalCorpusSourceSystemId(value: string): CorpusSourceSystemId {
  const clean = value.trim();
  const alias = CORPUS_SOURCE_ALIASES[clean];
  if (alias) return alias;
  if (CORPUS_SOURCE_LABELS.has(clean as CorpusSourceSystemId)) return clean as CorpusSourceSystemId;
  return corpusSourceId("corpus-custom", clean);
}

export function corpusSourceAlias(value: string): string {
  const clean = value.trim();
  if (CORPUS_SOURCE_ALIASES[clean]) return clean;
  const canonical = canonicalCorpusSourceSystemId(clean);
  return CORPUS_SOURCE_LABELS.get(canonical) ?? clean;
}

function corpusQuerySourceSystems(item: CorpusRegistryEntry): string[] {
  const compatibleLabels = Object.entries(CORPUS_SOURCE_ALIASES)
    .filter(([, sourceSystemId]) => sourceSystemId === item.sourceSystemId)
    .map(([label]) => label);
  return [...new Set([item.sourceSystem, item.sourceSystemId, item.sourceAlias, ...compatibleLabels].filter((value): value is string => Boolean(value)))];
}

function entry(
  sourceSystemId: CorpusSourceSystemId,
  sourceSystem: string,
  corpusRoleId: CorpusRoleId,
  priority: number,
  weight: number,
  graphEvidenceEligible: boolean,
  limits: CorpusHydrationLimits = DEFAULT_HYDRATION_LIMITS
): CorpusRegistryEntry {
  return {
    sourceSystem,
    sourceSystemId,
    sourceAlias: sourceSystem,
    enabled: true,
    corpusKindId: corpusRoleId,
    corpusRoleId,
    languageMemoryEligible: true,
    graphEvidenceEligible,
    hydration: { priority, weight, limits: { ...limits } },
    ngram: { ...DEFAULT_NGRAM_SETTINGS }
  };
}

function roleIdForSource(sourceSystem: CorpusSourceSystemId): CorpusRoleId {
  if (sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.legacyScce2) return CORPUS_ROLE_IDS.importedPrior;
  if (sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.corrections) return CORPUS_ROLE_IDS.interactionCorrection;
  if (sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.workspace) return CORPUS_ROLE_IDS.workspace;
  if (sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.wikipedia) return CORPUS_ROLE_IDS.encyclopedic;
  if (sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.gutenberg) return CORPUS_ROLE_IDS.publicDomainProse;
  if (sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.ossDocs) return CORPUS_ROLE_IDS.softwareDocumentation;
  if (sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.ossCode) return CORPUS_ROLE_IDS.softwareSymbolic;
  return CORPUS_ROLE_IDS.custom;
}

function cloneEntry(input: CorpusRegistryEntry): CorpusRegistryEntry {
  return {
    ...input,
    hydration: { ...input.hydration, limits: { ...input.hydration.limits } },
    ngram: { ...input.ngram }
  };
}

function mergeEntry(base: CorpusRegistryEntry, override: CorpusRegistryOverride): CorpusRegistryEntry {
  const hydrationOverride = definedRecord(override.hydration ?? {});
  const ngramOverride = definedRecord(override.ngram ?? {});
  return {
    ...base,
    ...withoutNested(override),
    hydration: {
      ...base.hydration,
      ...hydrationOverride,
      limits: { ...base.hydration.limits, ...(override.hydration?.limits ?? {}) }
    },
    ngram: { ...base.ngram, ...ngramOverride }
  };
}

function withoutNested(input: CorpusRegistryOverride): Partial<CorpusRegistryEntry> {
  const { hydration: _hydration, ngram: _ngram, ...rest } = input;
  return rest;
}

function boundedLimit(value: number, max: number): number {
  return Math.max(0, Math.min(Math.floor(value), Math.max(0, Math.floor(max))));
}

function definedRecord<T extends Record<string, unknown>>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) (out as Record<string, unknown>)[key] = item;
  }
  return out;
}
