import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  assertValidRelationPotentialModel,
  createCorpusRegistry,
  type CorpusRegistryEntry,
  type CorpusRegistryOverride,
  type RelationPotentialModel
} from "@scce/kernel";

import type { PolicyProfile, JsonValue } from "@scce/kernel";
import { normalizeSpreadsheetExtractionLimits, type SpreadsheetExtractionLimitOverrides } from "./spreadsheet-contract.js";

export interface CorpusNgramRuntimeConfig {
  ngramMaxOrder?: number;
  ngramMaxCountersPerOrder?: number;
  ngramVocabularyLimit?: number;
}

export interface WikipediaCorpusConfig extends CorpusNgramRuntimeConfig {
  enabled: boolean;
  dumpPath: string;
  indexPath?: string;
  namespace?: string;
  python?: string;
  decompressor?: string;
  decompressorArgs?: string[];
  maxPagesPerRun?: number;
  maxBlocksPerRun?: number;
  maxArticleChars?: number;
  maxBlockBytes?: number;
  memorySafetyBoundMb?: number;
  checkpointEveryPages?: number;
  skipRedirects?: boolean;
  allowedNamespaces?: number[];
}

export interface GutenbergCorpusConfig extends CorpusNgramRuntimeConfig {
  enabled: boolean;
  rootPath: string;
  maxFilesPerRun?: number;
  maxFileBytes?: number;
}

export interface OssCorpusConfig extends CorpusNgramRuntimeConfig {
  enabled: boolean;
  rootPath: string;
  repos?: string[];
  maxFilesPerRepo?: number;
  maxFileBytes?: number;
  includeDocs?: boolean;
  includeSource?: boolean;
}

export interface CorpusRegistryRuntimeConfig extends CorpusNgramRuntimeConfig {
  enabled?: boolean;
  languageMemoryEligible?: boolean;
  graphEvidenceEligible?: boolean;
  priority?: number;
  weight?: number;
  localPath?: string;
  downloadPath?: string;
  limits?: Partial<CorpusRegistryEntry["hydration"]["limits"]>;
  metadata?: JsonValue;
}

export interface DockerPatchValidationRuntimeConfig {
  image?: string;
  dockerExecutable?: string;
  materializationNetwork?: "bridge" | "none";
  rootPackagePath: string;
  lockfilePath: string;
  dependencyInputPaths: string[];
  memoryBytes?: number;
  cpus?: number;
  pidsLimit?: number;
  tmpfsBytes?: number;
  workspaceTmpfsBytes?: number;
  maxHostSnapshotBytes?: number;
  maxMaterializedFiles?: number;
  maxMaterializedBytes?: number;
  user?: string;
}

export interface PatchValidationRuntimeConfig {
  provider?: "trusted-host" | "docker";
  docker?: DockerPatchValidationRuntimeConfig;
}

export interface ScceRuntimeConfig {
  server: { url: string; host?: string; port?: number };
  database: { url: string; schema: string; ssl?: boolean | { rejectUnauthorized?: boolean } };
  runtime: {
    workspaceRoot: string;
    tempRoot: string;
    maxFileBytes: number;
    maxChunkBytes: number;
    spreadsheet?: SpreadsheetExtractionLimitOverrides;
    allowedRoots: string[];
    excludedPaths: string[];
    /** Serialized offline-trained model. Runtime only performs frozen inference. */
    relationPotentialModel?: RelationPotentialModel;
    tools: { pdftotext?: string; tesseract?: string; node?: string; pnpm?: string };
    patchValidation?: PatchValidationRuntimeConfig;
    corpora?: {
      wikipedia?: WikipediaCorpusConfig;
      gutenberg?: GutenbergCorpusConfig;
      oss?: OssCorpusConfig;
      registry?: Record<string, CorpusRegistryRuntimeConfig>;
    };
  };
  connectors: {
    web?: {
      enabled: boolean;
      allowedHosts: string[];
      maxBytes: number;
      search?: {
        provider: "duckduckgo" | "bing" | "brave" | "serpapi" | "tavily";
        apiKey?: string;
        endpoint?: string;
      };
    };
    outlook?: { enabled: boolean; tenantId: string; clientId: string; accessToken: string };
    youtube?: { enabled: boolean; apiKey: string };
    telephone?: { enabled: boolean; provider: "twilio"; accountSid: string; authToken: string; fromNumber: string };
  };
  security?: {
    localMasterKey?: string;
    apiBearerToken?: string;
    mentalHealthRails?: boolean;
    redactPublicConfig?: boolean;
  };
  policy: PolicyProfile;
  metadata?: JsonValue;
}

export async function readScceRuntimeConfig(configPath = "scce.config.json"): Promise<ScceRuntimeConfig> {
  const absolute = path.resolve(configPath);
  const parsed = JSON.parse(await readFile(absolute, "utf8")) as ScceRuntimeConfig;
  validateConfig(parsed, absolute);
  parsed.runtime.workspaceRoot = path.resolve(path.dirname(absolute), parsed.runtime.workspaceRoot);
  parsed.runtime.tempRoot = path.resolve(path.dirname(absolute), parsed.runtime.tempRoot);
  parsed.runtime.allowedRoots = parsed.runtime.allowedRoots.map(root => path.resolve(path.dirname(absolute), root));
  parsed.runtime.excludedPaths = parsed.runtime.excludedPaths.map(root => path.resolve(path.dirname(absolute), root));
  if (parsed.runtime.corpora?.wikipedia?.dumpPath) parsed.runtime.corpora.wikipedia.dumpPath = path.resolve(path.dirname(absolute), parsed.runtime.corpora.wikipedia.dumpPath);
  if (parsed.runtime.corpora?.wikipedia?.indexPath) parsed.runtime.corpora.wikipedia.indexPath = path.resolve(path.dirname(absolute), parsed.runtime.corpora.wikipedia.indexPath);
  if (parsed.runtime.corpora?.gutenberg?.rootPath) parsed.runtime.corpora.gutenberg.rootPath = path.resolve(path.dirname(absolute), parsed.runtime.corpora.gutenberg.rootPath);
  if (parsed.runtime.corpora?.oss?.rootPath) parsed.runtime.corpora.oss.rootPath = path.resolve(path.dirname(absolute), parsed.runtime.corpora.oss.rootPath);
  if (parsed.runtime.corpora?.registry) {
    for (const item of Object.values(parsed.runtime.corpora.registry)) {
      if (item.localPath) item.localPath = path.resolve(path.dirname(absolute), item.localPath);
      if (item.downloadPath) item.downloadPath = path.resolve(path.dirname(absolute), item.downloadPath);
    }
  }
  return parsed;
}

export function validateConfig(config: ScceRuntimeConfig, source = "config"): void {
  if (!config.server?.url) throw new Error(`${source}: missing server.url`);
  if (!config.database?.url) throw new Error(`${source}: missing database.url; SCCE v3 requires PostgreSQL`);
  if (!/^postgres(?:ql)?:\/\//i.test(config.database.url)) throw new Error(`${source}: database.url must be postgres:// or postgresql://; no embedded/local/in-memory alternate storage path exists`);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.database.schema)) throw new Error(`${source}: database.schema must be a safe PostgreSQL identifier`);
  if (!config.runtime?.workspaceRoot) throw new Error(`${source}: missing runtime.workspaceRoot`);
  if (!config.runtime?.tempRoot) throw new Error(`${source}: missing runtime.tempRoot`);
  if (!Array.isArray(config.runtime.allowedRoots) || config.runtime.allowedRoots.length === 0) throw new Error(`${source}: runtime.allowedRoots must be non-empty`);
  try {
    normalizeSpreadsheetExtractionLimits(config.runtime.spreadsheet);
  } catch (error) {
    throw new Error(`${source}: invalid runtime.spreadsheet: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (config.runtime.relationPotentialModel !== undefined) {
    try {
      assertValidRelationPotentialModel(config.runtime.relationPotentialModel);
    } catch (error) {
      throw new Error(`${source}: invalid runtime.relationPotentialModel: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  validatePatchValidationConfig(config.runtime.patchValidation, source);
  if (config.runtime.corpora?.wikipedia?.enabled && !config.runtime.corpora.wikipedia.dumpPath) throw new Error(`${source}: runtime.corpora.wikipedia.dumpPath is required when wikipedia corpus is enabled`);
  if (config.runtime.corpora?.wikipedia?.allowedNamespaces && !config.runtime.corpora.wikipedia.allowedNamespaces.every(Number.isInteger)) throw new Error(`${source}: runtime.corpora.wikipedia.allowedNamespaces must contain integer namespace ids`);
  if (config.runtime.corpora?.wikipedia?.memorySafetyBoundMb !== undefined && config.runtime.corpora.wikipedia.memorySafetyBoundMb < 512) throw new Error(`${source}: runtime.corpora.wikipedia.memorySafetyBoundMb must be at least 512`);
  validateNgramConfig(config.runtime.corpora?.wikipedia, `${source}: runtime.corpora.wikipedia`);
  if (config.runtime.corpora?.gutenberg?.enabled && !config.runtime.corpora.gutenberg.rootPath) throw new Error(`${source}: runtime.corpora.gutenberg.rootPath is required when gutenberg corpus is enabled`);
  validatePositiveInt(config.runtime.corpora?.gutenberg?.maxFilesPerRun, `${source}: runtime.corpora.gutenberg.maxFilesPerRun`);
  validatePositiveInt(config.runtime.corpora?.gutenberg?.maxFileBytes, `${source}: runtime.corpora.gutenberg.maxFileBytes`);
  validateNgramConfig(config.runtime.corpora?.gutenberg, `${source}: runtime.corpora.gutenberg`);
  if (config.runtime.corpora?.oss?.enabled && !config.runtime.corpora.oss.rootPath) throw new Error(`${source}: runtime.corpora.oss.rootPath is required when oss corpus is enabled`);
  validatePositiveInt(config.runtime.corpora?.oss?.maxFilesPerRepo, `${source}: runtime.corpora.oss.maxFilesPerRepo`);
  validatePositiveInt(config.runtime.corpora?.oss?.maxFileBytes, `${source}: runtime.corpora.oss.maxFileBytes`);
  if (config.runtime.corpora?.oss?.repos && !config.runtime.corpora.oss.repos.every(repo => typeof repo === "string" && repo.trim().length > 0)) throw new Error(`${source}: runtime.corpora.oss.repos must contain non-empty strings`);
  validateNgramConfig(config.runtime.corpora?.oss, `${source}: runtime.corpora.oss`);
  for (const [sourceSystem, item] of Object.entries(config.runtime.corpora?.registry ?? {})) {
    if (!sourceSystem.trim()) throw new Error(`${source}: runtime.corpora.registry keys must be non-empty source-system ids`);
    validateNgramConfig(item, `${source}: runtime.corpora.registry.${sourceSystem}`);
    validatePositiveInt(item.priority, `${source}: runtime.corpora.registry.${sourceSystem}.priority`);
    if (item.weight !== undefined && (!Number.isFinite(item.weight) || item.weight < 0)) throw new Error(`${source}: runtime.corpora.registry.${sourceSystem}.weight must be a non-negative number`);
  }
  if (config.connectors.web?.search && !["duckduckgo", "bing", "brave", "serpapi", "tavily"].includes(config.connectors.web.search.provider)) throw new Error(`${source}: connectors.web.search.provider is not supported`);
  if (config.connectors.web?.enabled && config.connectors.web.allowedHosts.includes("*") && process.env.SCCE_ALLOW_WILDCARD_WEB !== "1") throw new Error(`${source}: connectors.web.allowedHosts must not contain "*" unless SCCE_ALLOW_WILDCARD_WEB=1`);
  if (publiclyBound(config) && !configuredApiBearer(config)) throw new Error(`${source}: non-loopback server binds require security.apiBearerToken or SCCE_API_BEARER_TOKEN`);
  validateSecretPolicy(config, source);
  if (!config.policy) throw new Error(`${source}: missing policy`);
}

function validatePatchValidationConfig(config: PatchValidationRuntimeConfig | undefined, source: string): void {
  const provider = config?.provider ?? "trusted-host";
  if (provider !== "trusted-host" && provider !== "docker") throw new Error(`${source}: runtime.patchValidation.provider must be trusted-host or docker`);
  if (provider === "trusted-host") return;
  const docker = config?.docker;
  if (!docker) throw new Error(`${source}: runtime.patchValidation.docker is required for the docker provider`);
  const image = docker.image?.trim() || process.env.SCCE_PATCH_VALIDATION_DOCKER_IMAGE?.trim();
  if (!image || !/^[^\s@]+@sha256:[0-9a-f]{64}$/u.test(image)) throw new Error(`${source}: runtime.patchValidation.docker.image must use a lowercase sha256 digest`);
  if (docker.materializationNetwork !== undefined && docker.materializationNetwork !== "bridge" && docker.materializationNetwork !== "none") throw new Error(`${source}: runtime.patchValidation.docker.materializationNetwork must be bridge or none`);
  if (docker.maxHostSnapshotBytes !== undefined && (!Number.isSafeInteger(docker.maxHostSnapshotBytes) || docker.maxHostSnapshotBytes < 1 || docker.maxHostSnapshotBytes > 1024 * 1024 * 1024)) throw new Error(`${source}: runtime.patchValidation.docker.maxHostSnapshotBytes must be an integer from 1 through 1073741824`);
  const paths = [docker.rootPackagePath, docker.lockfilePath, ...(docker.dependencyInputPaths ?? [])];
  if (!Array.isArray(docker.dependencyInputPaths) || docker.dependencyInputPaths.length < 2 || docker.dependencyInputPaths.length > 512) throw new Error(`${source}: runtime.patchValidation.docker.dependencyInputPaths must contain 2 through 512 paths`);
  if (new Set(docker.dependencyInputPaths).size !== docker.dependencyInputPaths.length) throw new Error(`${source}: runtime.patchValidation.docker.dependencyInputPaths must be unique`);
  for (const value of paths) {
    if (typeof value !== "string" || !value || path.isAbsolute(value) || value.includes("\u0000") || value.replace(/\\/gu, "/").split("/").some(part => !part || part === "." || part === "..")) {
      throw new Error(`${source}: runtime.patchValidation.docker dependency paths must be normalized workspace-relative paths`);
    }
  }
  if (!docker.dependencyInputPaths.includes(docker.rootPackagePath) || !docker.dependencyInputPaths.includes(docker.lockfilePath)) throw new Error(`${source}: runtime.patchValidation.docker.dependencyInputPaths must include rootPackagePath and lockfilePath`);
  if (docker.rootPackagePath !== "package.json" || docker.lockfilePath !== "pnpm-lock.yaml") throw new Error(`${source}: runtime.patchValidation.docker requires rootPackagePath=package.json and lockfilePath=pnpm-lock.yaml`);
  for (const value of docker.dependencyInputPaths) {
    if (value === docker.rootPackagePath || value === docker.lockfilePath || value === "pnpm-workspace.yaml" || value.endsWith("/package.json") || /\.(?:tgz|tar|tar\.gz|zip)$/iu.test(value)) continue;
    throw new Error(`${source}: runtime.patchValidation.docker.dependencyInputPaths may contain only manifests, the workspace declaration, the lockfile, and lock-referenced archives`);
  }
}

export function corpusRegistryEntriesFromConfig(config: ScceRuntimeConfig): CorpusRegistryEntry[] {
  const overrides: CorpusRegistryOverride[] = [];
  const wikipedia = config.runtime.corpora?.wikipedia;
  if (wikipedia) {
    overrides.push({
      sourceSystem: "wikipedia",
      enabled: wikipedia.enabled,
      localPath: wikipedia.dumpPath,
      ngram: ngramOverride(wikipedia),
      metadata: { namespace: wikipedia.namespace ?? null, indexPath: wikipedia.indexPath ?? null }
    });
  }
  const gutenberg = config.runtime.corpora?.gutenberg;
  if (gutenberg) {
    overrides.push({
      sourceSystem: "gutenberg",
      enabled: gutenberg.enabled,
      localPath: gutenberg.rootPath,
      ngram: ngramOverride(gutenberg),
      metadata: { maxFilesPerRun: gutenberg.maxFilesPerRun ?? null, maxFileBytes: gutenberg.maxFileBytes ?? null }
    });
  }
  const oss = config.runtime.corpora?.oss;
  if (oss) {
    const docsEnabled = oss.enabled && oss.includeDocs !== false;
    const sourceEnabled = oss.enabled && oss.includeSource !== false;
    overrides.push({
      sourceSystem: "oss_docs",
      enabled: docsEnabled,
      localPath: oss.rootPath,
      ngram: ngramOverride(oss),
      metadata: { repos: oss.repos ?? [], maxFilesPerRepo: oss.maxFilesPerRepo ?? null, maxFileBytes: oss.maxFileBytes ?? null }
    });
    overrides.push({
      sourceSystem: "oss_code",
      enabled: sourceEnabled,
      localPath: oss.rootPath,
      ngram: ngramOverride(oss),
      metadata: { repos: oss.repos ?? [], maxFilesPerRepo: oss.maxFilesPerRepo ?? null, maxFileBytes: oss.maxFileBytes ?? null }
    });
  }
  for (const [sourceSystem, item] of Object.entries(config.runtime.corpora?.registry ?? {})) {
    overrides.push({
      sourceSystem,
      enabled: item.enabled,
      languageMemoryEligible: item.languageMemoryEligible,
      graphEvidenceEligible: item.graphEvidenceEligible,
      localPath: item.localPath,
      downloadPath: item.downloadPath,
      metadata: item.metadata,
      ngram: ngramOverride(item),
      hydration: {
        priority: item.priority,
        weight: item.weight,
        limits: item.limits
      }
    });
  }
  return createCorpusRegistry(overrides);
}

function ngramOverride(config: CorpusNgramRuntimeConfig | undefined): CorpusRegistryOverride["ngram"] {
  if (!config) return undefined;
  return {
    maxOrder: config.ngramMaxOrder,
    maxCountersPerOrder: config.ngramMaxCountersPerOrder,
    vocabularyLimit: config.ngramVocabularyLimit
  };
}

function validateNgramConfig(config: CorpusNgramRuntimeConfig | undefined, prefix: string): void {
  if (!config) return;
  if (config.ngramMaxOrder !== undefined && (!Number.isInteger(config.ngramMaxOrder) || config.ngramMaxOrder < 1 || config.ngramMaxOrder > 6)) throw new Error(`${prefix}.ngramMaxOrder must be an integer from 1 through 6`);
  validatePositiveInt(config.ngramMaxCountersPerOrder, `${prefix}.ngramMaxCountersPerOrder`);
  validatePositiveInt(config.ngramVocabularyLimit, `${prefix}.ngramVocabularyLimit`);
}

function validatePositiveInt(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 1)) throw new Error(`${label} must be a positive integer`);
}

function publiclyBound(config: ScceRuntimeConfig): boolean {
  const host = config.server.host ?? safeUrlHost(config.server.url);
  return Boolean(host) && !isLoopbackHost(host);
}

function safeUrlHost(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
}

function isLoopbackHost(host: string): boolean {
  const clean = host.trim().toLocaleLowerCase().replace(/^\[|\]$/g, "");
  return clean === "localhost" || clean === "127.0.0.1" || clean === "::1";
}

function configuredApiBearer(config: ScceRuntimeConfig): boolean {
  return Boolean(config.security?.apiBearerToken || process.env.SCCE_API_BEARER_TOKEN);
}

function validateSecretPolicy(config: ScceRuntimeConfig, source: string): void {
  const secrets = secretFields(config).filter(item => item.value.trim().length > 0);
  const encrypted = secrets.filter(item => item.value.startsWith("enc:v1:"));
  if (encrypted.length && !config.security?.localMasterKey) throw new Error(`${source}: encrypted secret fields require security.localMasterKey`);
  if (!config.policy?.encryptSecretsAtRest) return;
  const plain = secrets.filter(item => !item.value.startsWith("enc:v1:"));
  if (plain.length) throw new Error(`${source}: ${plain.map(item => item.label).join(", ")} must use enc:v1 envelopes when policy.encryptSecretsAtRest is true`);
}

function secretFields(config: ScceRuntimeConfig): Array<{ label: string; value: string }> {
  return [
    { label: "connectors.web.search.apiKey", value: config.connectors.web?.search?.apiKey ?? "" },
    { label: "connectors.outlook.accessToken", value: config.connectors.outlook?.accessToken ?? "" },
    { label: "connectors.youtube.apiKey", value: config.connectors.youtube?.apiKey ?? "" },
    { label: "connectors.telephone.accountSid", value: config.connectors.telephone?.accountSid ?? "" },
    { label: "connectors.telephone.authToken", value: config.connectors.telephone?.authToken ?? "" },
    { label: "security.apiBearerToken", value: config.security?.apiBearerToken ?? "" }
  ];
}
