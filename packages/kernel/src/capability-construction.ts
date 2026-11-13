// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { induceLearnedConstructions, type AlignedSurfaceExample, type LearnedConstruction } from "./language-construction.js";
import { createLearnedSurfaceInterpreter } from "./learned-surface-interpretation.js";
import { canonicalStringify, createHasher, toJsonValue } from "./primitives.js";
import { codePointUtf16Offsets } from "./unicode-segmentation.js";
import type { LanguagePatternRecord, ScceStorage } from "./storage.js";
import type { ContentHash, EvidenceId, EvidenceSpan, Hasher, JsonValue, SourceId, SourceVersionId } from "./types.js";
import type { RuntimeCapabilityPlanStep } from "./capability-runtime.js";
import { validateExecutiveResultBindings, type ExecutiveResultBinding } from "./executive-goal-runtime.js";
import { solveTaskSchedule } from "./task-schedule-solver.js";
import { SOURCE_CONSTRUCTION_READ_BUDGET } from "./request-language-hydration.js";
import { canonicalJsonByteLength } from "./canonical-json-digest.js";

export const CAPABILITY_DEMONSTRATION_SCHEMA = "scce.capability_demonstration_corpus.v1";
export const CAPABILITY_CONSTRUCTION_SCHEMA = "scce.capability_construction.v1";
export const CAPABILITY_CONSTRUCTION_PUBLICATION = { patternSchema: CAPABILITY_CONSTRUCTION_SCHEMA, componentRecipe: "kernel.capability_construction.v1" } as const;

type ParameterPath = Array<string | number>;
export interface CapabilityDemonstration {
  request: string;
  capabilityId: string;
  payload: JsonValue;
  bindings: Array<{ path: ParameterPath; startCodePoint: number; endCodePoint: number }>;
}
export interface CapabilityPlanDemonstration {
  request: string;
  steps: RuntimeCapabilityPlanStep[];
  bindings: CapabilityDemonstration["bindings"];
}
type Demonstration = CapabilityDemonstration & { plan?: true };
export interface CapabilityDemonstrationCorpus {
  schema: typeof CAPABILITY_DEMONSTRATION_SCHEMA;
  examples: Array<CapabilityDemonstration | CapabilityPlanDemonstration>;
}
interface ConstructionOwner {
  sourceId: SourceId;
  sourceVersionId: SourceVersionId;
  contentHash: ContentHash;
  profileId: string;
}
interface Family {
  pattern: LanguagePatternRecord;
  constructions: readonly LearnedConstruction[];
  template: Demonstration;
  roleIds: string[];
}
export interface VerifiedCapabilityBinding {
  requestHash: string;
  capabilityId: string;
  payload: JsonValue;
  steps?: RuntimeCapabilityPlanStep[];
  patternIds: string[];
  evidenceIds: EvidenceId[];
}
const verifiedBindings = new WeakMap<VerifiedCapabilityBinding, string>();

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function pathValue(value: JsonValue, path: ParameterPath): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string | number, JsonValue>)[key];
  }
  return current;
}

function setPath(value: JsonValue, path: ParameterPath, replacement: JsonValue): void {
  if (!path.length) throw new Error("capability parameter path must name an input field");
  const parent = pathValue(value, path.slice(0, -1));
  const key = path.at(-1)!;
  if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, key)) throw new Error("capability parameter path is absent");
  Object.defineProperty(parent, key, { value: replacement, enumerable: true, writable: true, configurable: true });
}

function roleId(path: ParameterPath, hasher: Hasher): string {
  return `capability.parameter.${hasher.digestHex(canonicalStringify(path))}`;
}

function parseCorpus(sourceText: string): Demonstration[] | undefined {
  let body: Record<string, unknown> | undefined;
  try { body = record(JSON.parse(sourceText)); } catch { return undefined; }
  if (body?.schema !== CAPABILITY_DEMONSTRATION_SCHEMA) return undefined;
  if (!Array.isArray(body.examples) || !body.examples.length) throw new Error("capability demonstrations require examples");
  return body.examples.map(value => {
    const row = record(value);
    if (row && Array.isArray(row.steps)) {
      validateDemonstrationSteps(row.steps);
      value = { request: row.request, capabilityId: row.steps[0]!.capabilityId, payload: { steps: row.steps }, bindings: row.bindings, plan: true };
    }
    const normalized = record(value);
    if (!normalized || typeof normalized.request !== "string" || !normalized.request.trim() || typeof normalized.capabilityId !== "string"
      || !normalized.capabilityId || !record(normalized.payload) || !Array.isArray(normalized.bindings)) throw new Error("invalid capability demonstration");
    const demonstration = normalized as unknown as Demonstration;
    const points = [...demonstration.request];
    const seen = new Set<string>();
    for (const binding of demonstration.bindings) {
      if (!binding || !Array.isArray(binding.path) || !binding.path.length
        || binding.path.some(key => typeof key !== "string" && !(typeof key === "number" && Number.isSafeInteger(key) && key >= 0))
        || !Number.isSafeInteger(binding.startCodePoint) || !Number.isSafeInteger(binding.endCodePoint)
        || binding.startCodePoint < 0 || binding.endCodePoint <= binding.startCodePoint || binding.endCodePoint > points.length
        || pathValue(demonstration.payload, binding.path) !== points.slice(binding.startCodePoint, binding.endCodePoint).join("")) throw new Error("capability parameter differs from its request span");
      const key = canonicalStringify(binding.path);
      if (seen.has(key)) throw new Error("duplicate capability parameter binding");
      seen.add(key);
      if (demonstration.plan && (binding.path[0] !== "steps" || typeof binding.path[1] !== "number" || binding.path[2] !== "payload" || binding.path.length < 4)) throw new Error("plan request parameters must bind operation payload fields");
      if (demonstration.plan) {
        const step = (demonstration.payload as unknown as { steps: RuntimeCapabilityPlanStep[] }).steps[binding.path[1] as number]!;
        const path = binding.path.slice(3).map(String);
        if (step.resultBindings?.some(result => result.path.slice(0, Math.min(result.path.length, path.length)).every((key, index) => String(key) === path[index]))) throw new Error("request and predecessor bindings overlap");
      }
    }
    const ordered = [...demonstration.bindings].sort((a, b) => a.startCodePoint - b.startCodePoint);
    if (ordered.some((row, index) => index > 0 && row.startCodePoint < ordered[index - 1]!.endCodePoint)) throw new Error("overlapping capability parameter spans");
    return demonstration;
  });
}

function validateDemonstrationSteps(value: unknown[]): asserts value is RuntimeCapabilityPlanStep[] {
  if (!value.length) throw new Error("capability plan requires steps");
  const ids = new Set<string>();
  for (const candidate of value) {
    const step = record(candidate);
    if (!step || typeof step.id !== "string" || !step.id || Object.hasOwn(Object.prototype, step.id) || ids.has(step.id) || typeof step.capabilityId !== "string" || !step.capabilityId
      || !record(step.payload) || !Array.isArray(step.dependencyStepIds) || step.dependencyStepIds.some(id => typeof id !== "string")
      || step.resultBindings !== undefined && !Array.isArray(step.resultBindings)) throw new Error("invalid capability plan step");
    ids.add(step.id);
    validateExecutiveResultBindings(step.payload as JsonValue, (step.resultBindings ?? []) as ExecutiveResultBinding[], step.dependencyStepIds as string[]);
  }
  const schedule = solveTaskSchedule((value as RuntimeCapabilityPlanStep[]).map(step => ({ id: step.id, dependencyIds: step.dependencyStepIds })));
  if (schedule.status !== "scheduled") throw new Error("capability demonstration dependency cycle");
}

function compileFamilies(input: { sourceText: string; owner: ConstructionOwner; evidence: readonly EvidenceSpan[]; hasher: Hasher; updatedAt: number }): Family[] {
  const examples = parseCorpus(input.sourceText);
  if (!examples) return [];
  if (`sha256_${input.hasher.digestHex(input.sourceText)}` !== input.owner.contentHash) throw new Error("capability corpus content differs from its source");
  const evidence = input.evidence.filter(span => span.status === "promoted" && span.sourceId === input.owner.sourceId && span.sourceVersionId === input.owner.sourceVersionId);
  if (!evidence.length) return [];
  const groups = new Map<string, Array<{ demonstration: Demonstration; index: number; aligned: AlignedSurfaceExample }>>();
  for (const [index, demonstration] of examples.entries()) {
    const offsets = codePointUtf16Offsets(demonstration.request);
    const payload = structuredClone(demonstration.payload);
    const bindings = [...demonstration.bindings].sort((a, b) => canonicalStringify(a.path).localeCompare(canonicalStringify(b.path)));
    for (const binding of bindings) setPath(payload, binding.path, { parameterRoleId: roleId(binding.path, input.hasher) });
    const key = input.hasher.digestHex(canonicalStringify({ capabilityId: demonstration.capabilityId, payload, ...(demonstration.plan ? { plan: true } : {}) }));
    const group = groups.get(key) ?? [];
    group.push({ demonstration: { ...demonstration, bindings }, index, aligned: {
      id: `capability.example.${input.owner.contentHash}.${index}`, profileKey: input.owner.profileId, surface: demonstration.request,
      evidenceIds: evidence.map(span => String(span.id)), roleSpans: bindings.map(binding => ({ roleId: roleId(binding.path, input.hasher),
        start: offsets[binding.startCodePoint]!, end: offsets[binding.endCodePoint]!, surface: pathValue(demonstration.payload, binding.path) as string,
        evidenceIds: evidence.map(span => String(span.id)) }))
    } });
    groups.set(key, group);
  }
  return [...groups].flatMap(([groupId, group]) => {
    const induced = induceLearnedConstructions({ examples: group.map(row => row.aligned), hasher: input.hasher });
    if (!induced.constructions.length || induced.rejected.length) return [];
    const artifact = { schema: CAPABILITY_CONSTRUCTION_SCHEMA, componentRecipe: CAPABILITY_CONSTRUCTION_PUBLICATION.componentRecipe,
      ...input.owner, groupId, exampleIndices: group.map(row => row.index) };
    return [{ template: group[0]!.demonstration, roleIds: group[0]!.demonstration.bindings.map(binding => roleId(binding.path, input.hasher)),
      constructions: induced.constructions, pattern: { id: `capability.construction.${input.hasher.digestHex(canonicalStringify(artifact))}`,
        profileId: input.owner.profileId, patternKind: "semantic_role" as const, support: group.length, entropy: 0,
        evidenceIds: evidence.map(span => span.id), updatedAt: input.updatedAt, patternJson: toJsonValue(artifact) } }];
  });
}

export function compileCapabilityDemonstrations(input: { sourceText: string; owner: ConstructionOwner; evidence: readonly EvidenceSpan[]; hasher: Hasher; updatedAt: number }): LanguagePatternRecord[] {
  return compileFamilies(input).map(row => row.pattern);
}

export function capabilityBindingVerified(binding: VerifiedCapabilityBinding | undefined, requestText: string): boolean {
  return Boolean(binding && binding.requestHash === createHasher().digestHex(requestText)
    && verifiedBindings.get(binding) === canonicalStringify(binding));
}

export async function capabilityBindingForRequest(input: { storage: ScceStorage; requestText: string; sourceVersionAllowlist?: readonly string[] }): Promise<VerifiedCapabilityBinding | undefined> {
  const hasher = createHasher();
  const patterns = await input.storage.languageMemory.listLanguagePatterns({ patternSchemas: [CAPABILITY_CONSTRUCTION_SCHEMA],
    ...SOURCE_CONSTRUCTION_READ_BUDGET, requireComplete: true });
  if (patterns.length > SOURCE_CONSTRUCTION_READ_BUDGET.limit
    || canonicalJsonByteLength(patterns.map(pattern => pattern.patternJson), SOURCE_CONSTRUCTION_READ_BUDGET.maxTotalJsonBytes) > SOURCE_CONSTRUCTION_READ_BUDGET.maxTotalJsonBytes) throw new Error("capability construction read exceeds its complete artifact allowance");
  const interpreter = createLearnedSurfaceInterpreter(input.requestText, true);
  const sourceFamilies = new Map<string, Family[]>();
  const candidates = new Map<string, VerifiedCapabilityBinding>();
  for (const pattern of patterns) {
    const metadata = record(pattern.patternJson);
    if (metadata?.schema !== CAPABILITY_CONSTRUCTION_SCHEMA) continue;
    const owner = metadata as unknown as ConstructionOwner;
    if (![owner.sourceId, owner.sourceVersionId, owner.contentHash, owner.profileId].every(value => typeof value === "string" && value)
      || input.sourceVersionAllowlist && !input.sourceVersionAllowlist.includes(String(owner.sourceVersionId))) continue;
    const key = canonicalStringify([owner.sourceId, owner.sourceVersionId, owner.contentHash, owner.profileId]);
    let families = sourceFamilies.get(key);
    if (!families) {
      const evidence = await input.storage.evidence.getEvidenceBatch(pattern.evidenceIds);
      if (evidence.length !== pattern.evidenceIds.length || evidence.some(span => span.status !== "promoted" || span.sourceId !== owner.sourceId || span.sourceVersionId !== owner.sourceVersionId)) continue;
      const bytes = await input.storage.blobs.get(owner.contentHash);
      if (`sha256_${hasher.digestHex(bytes)}` !== owner.contentHash) throw new Error("capability corpus failed hash verification");
      families = compileFamilies({ sourceText: new TextDecoder("utf-8", { fatal: true }).decode(bytes), owner: {
        sourceId: owner.sourceId, sourceVersionId: owner.sourceVersionId, contentHash: owner.contentHash, profileId: owner.profileId
      }, evidence, hasher, updatedAt: pattern.updatedAt });
      sourceFamilies.set(key, families);
    }
    const family = families.find(row => row.pattern.id === pattern.id);
    if (!family) continue;
    for (const construction of family.constructions) {
      const roles = interpreter.interpret(construction);
      if (!roles || family.roleIds.some(id => roles.filter(role => role.roleId === id).length !== 1)) continue;
      const payload = structuredClone(family.template.payload);
      for (const [index, parameter] of family.template.bindings.entries()) setPath(payload, parameter.path, roles.find(role => role.roleId === family.roleIds[index])!.surface);
      const steps = family.template.plan ? (payload as unknown as { steps: RuntimeCapabilityPlanStep[] }).steps : undefined;
      const capabilityId = steps?.[0]?.capabilityId ?? family.template.capabilityId;
      const operationPayload = steps?.[0]?.payload ?? payload;
      const material = canonicalStringify({ capabilityId, payload: operationPayload, ...(steps ? { steps } : {}) });
      const existing = candidates.get(material);
      candidates.set(material, { requestHash: hasher.digestHex(input.requestText), capabilityId, payload: operationPayload, ...(steps ? { steps } : {}),
        patternIds: [...new Set([...(existing?.patternIds ?? []), pattern.id])], evidenceIds: [...new Set([...(existing?.evidenceIds ?? []), ...pattern.evidenceIds])] });
    }
  }
  if (candidates.size !== 1) return undefined;
  const binding = candidates.values().next().value!;
  verifiedBindings.set(binding, canonicalStringify(binding));
  return binding;
}
