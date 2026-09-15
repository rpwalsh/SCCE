// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createCapabilityExecutorRegistry, dispatchCapabilityTask, type CapabilityExecutor, type CapabilityDispatchDisposition } from "./capability-dispatcher.js";
import { createEventFactory } from "./events.js";
import { uniqueKernelStrings } from "./kernel-answer-primitives.js";
import { assertSearchLeadIsNotEvidence, searchLeadToFetchPlan, type SearchResultLead } from "./ingestion-lanes.js";
import { canonicalStringify, createHasher, redactSecrets, sourceTextSurface, toJsonValue } from "./primitives.js";
import { POLICY_OBJECTIVE_SCHEMA_ID, policyFingerprint, policyObjectiveVector, type PolicyEvaluation } from "./policy-evolution.js";
import { type RuntimeDeadlineDecision } from "./runtime-deadline.js";
import type {
  PriorRejectedHypothesis,
  RuntimeAcquisitionProgress,
  RuntimeAdversarialSearchRequest,
  RuntimeAdversarialSearchResult,
  RuntimeReplanMotion,
  RuntimeReplanTrigger
} from "./runtime-motion.js";
import {
  runtimeMotionFailure
} from "./runtime-motion.js";
import { DEFAULT_POLICY } from "./safety.js";
import type { ScceKernelDeps } from "./storage.js";
import type {
  EpisodeId,
  IngestInput,
  IngestResult,
  JsonValue,
  OwnerInput,
  RequestedAuthority,
  ScceEvent
} from "./types.js";

const WEB_SEARCH_CAPABILITY_ID = "connector.web_search";
const RUNTIME_ACQUISITION_SEARCH_LIMIT = 12;
const RUNTIME_ACQUISITION_MAX_LINEAGES = 4;

function canonicalAcquisitionUri(uri: string): string {
  const trimmed = uri.trim();
  if (!trimmed) return trimmed;
  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLocaleLowerCase();
    if ((parsed.protocol === "https:" && parsed.port === "443") || (parsed.protocol === "http:" && parsed.port === "80")) {
      parsed.port = "";
    }
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

function jsonObjectValue(value: JsonValue | undefined, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

/**
 * The adapter's bounded document extractors return typed structure alongside
 * the text derivative. Keep that structure at the metadata level consumed by
 * typed-ingest while retaining the complete connector response under the
 * acquisition audit record. Do not promote arbitrary fetched metadata into
 * cognition: only extractor-owned fields cross this boundary.
 */
function fetchedExtractorMetadata(value: JsonValue | undefined): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, JsonValue>;
  const keys = ["title", "identity", "extractor", "structure", "typedExtraction", "sourceCode", "visual", "diagnostics"] as const;
  const out: Record<string, JsonValue> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) out[key] = record[key]!;
  }
  return out;
}

/**
 * Routes the read-only web-search connector call through the executive
 * dispatcher (Part A finding 9's dispatcher work, plan item 43: one
 * real, low-risk connector capability end to end). Deliberately
 * fail-open on the ledger, never on execution -- matching
 * dispatchBuildTestThroughExecutive's pattern: if deps.executive is
 * absent or dispatch itself throws, the caller falls back to calling
 * deps.connectors.search directly, so durable attestation can never
 * prevent a real search from happening.
 */
async function dispatchWebSearchThroughExecutive(input: {
  deps: ScceKernelDeps;
  episodeId: EpisodeId;
  queryHash: string;
  query: string;
  limit: number;
  hasher: ReturnType<typeof createHasher>;
}): Promise<Awaited<ReturnType<NonNullable<ScceKernelDeps["connectors"]>["search"]>> | undefined> {
  const executive = input.deps.executive;
  const connectors = input.deps.connectors;
  if (!executive || !connectors) return undefined;

  let capturedRows: Awaited<ReturnType<typeof connectors.search>> | undefined;
  const executor: CapabilityExecutor = {
    // A read query has no durable effect to duplicate, so retrying it
    // is inherently as safe as if the provider deduplicated by key --
    // the closest fit among the three declared contracts.
    descriptor: { capabilityId: WEB_SEARCH_CAPABILITY_ID, idempotency: "provider-enforced", rollback: "unavailable" },
    execute: async request => {
      const payload = request.payload as unknown as { query: string; limit: number };
      const rows = await connectors.search(payload.query, payload.limit);
      capturedRows = rows;
      return {
        status: "succeeded",
        outputRefs: rows.map(row => row.uri),
        evidenceRefs: [`web_search.results.${rows.length}`],
        attestationRef: `web_search.${request.invocation.idempotencyKey}`
      };
    }
  };

  const ownerId = input.deps.informationAccess?.principalId ?? "scce-runtime";
  const policyVersionId = `policy_${input.hasher.digestHex(JSON.stringify(input.deps.policy ?? {})).slice(0, 32)}`;
  const goalId = `goal_web_search_${input.queryHash}`;
  const taskId = `task_web_search_${input.queryHash}`;

  try {
    const dispatched = await dispatchCapabilityTask(
      { executive, executors: createCapabilityExecutorRegistry([executor]), hasher: input.hasher, now: () => Date.now() },
      {
        episodeId: input.episodeId,
        ownerId,
        policyVersionId,
        goal: { id: goalId, goalClassId: "goal.class.web_search", objectiveRef: input.queryHash, requirementIds: [], ownerId },
        task: {
          id: taskId,
          goalId,
          taskClassId: "task.class.web_search",
          requirementIds: [],
          dependencyTaskIds: [],
          capabilityId: WEB_SEARCH_CAPABILITY_ID,
          inputRef: input.queryHash,
          policyVersionId,
          controls: {
            authority: {
              authorityClassId: "authority.class.web_search",
              subjectId: ownerId,
              requiredScopeIds: [],
              state: "not_required",
              justificationRef: input.queryHash
            },
            approval: {
              policyId: "approval.policy.web_search",
              state: "not_required",
              approverClassIds: [],
              justificationRef: input.queryHash
            }
          },
          rollback: {
            mode: "not_required",
            justificationRef: "read-only web search has no durable effect to roll back"
          }
        },
        payload: { query: input.query, limit: input.limit } as unknown as JsonValue,
        outcomeEvidenceRefs: []
      }
    );
    if (input.deps.storage.policyEvolution) {
      await recordConnectorDispatchPolicyEvaluation({
        deps: input.deps,
        hasher: input.hasher,
        disposition: dispatched.disposition,
        windowRef: dispatched.receipt?.id ?? dispatched.attemptId ?? input.queryHash,
        createdAt: Date.now()
      });
    }
  } catch {
    // Fail-open: an executive/journal error must never block the real
    // search. If the executor already ran and captured rows, those are
    // still used below; if not, the caller's own try/catch around this
    // whole helper falls back to calling connectors.search directly.
  }
  return capturedRows;
}

/**
 * Records one real PolicyEvaluation from a real, in-production dispatch
 * decision (plan item 53 -- the first thing that actually writes to
 * `policyEvolution.putEvaluation`; the store and aggregation logic
 * already existed with nothing feeding it). Deliberately narrow: a
 * connector dispatch has no evidence/contradiction concept at all, so
 * `evidenceCoverage`/`contradictionRate` are set to their vacuous
 * best-case values (1 and 0) rather than fabricated -- this evaluation
 * genuinely only measures governance/task success for this one
 * dispatch, not proof quality. `governanceSuccessRate` and
 * `taskSuccessRate` collapse to the same real signal at this scope:
 * there is no separate "task" concept apart from whether the dispatch
 * itself succeeded.
 */
export async function recordConnectorDispatchPolicyEvaluation(input: {
  deps: ScceKernelDeps;
  hasher: ReturnType<typeof createHasher>;
  disposition: CapabilityDispatchDisposition;
  windowRef: string;
  createdAt: number;
}): Promise<void> {
  const policyEvolution = input.deps.storage.policyEvolution;
  if (!policyEvolution) return;
  const successRate = input.disposition === "succeeded" ? 1 : input.disposition === "indeterminate" ? 0.5 : 0;
  const rates = {
    evidenceCoverage: 1,
    governanceSuccessRate: successRate,
    contradictionRate: 0,
    rollbackRate: 0,
    taskSuccessRate: successRate
  };
  const resolvedPolicy = { ...DEFAULT_POLICY, ...(input.deps.policy ?? {}) };
  const fingerprint = policyFingerprint(resolvedPolicy);
  const evaluation: PolicyEvaluation = {
    id: `policy_eval_${input.hasher.digestHex(canonicalStringify({ fingerprint, windowRef: input.windowRef, createdAt: input.createdAt })).slice(0, 40)}`,
    policyFingerprint: fingerprint,
    objectiveSchemaId: POLICY_OBJECTIVE_SCHEMA_ID,
    vector: rates,
    objectives: policyObjectiveVector(rates),
    evaluationWindow: { firstEventId: input.windowRef, lastEventId: input.windowRef },
    observations: 1,
    createdAt: input.createdAt,
    informationLabel: {
      tenantId: input.deps.informationAccess?.tenantId ?? "scce.local",
      principals: input.deps.informationAccess?.principalId ? [input.deps.informationAccess.principalId] : [],
      compartments: [],
      // A non-public label requires at least one principal (see
      // information-flow.ts's normalizeInformationLabel) -- without a
      // configured principalId there is no real access boundary to scope
      // this telemetry to, so it degrades to public rather than writing a
      // label that fails its own validation on every later read.
      exportClass: input.deps.informationAccess?.principalId ? "internal" : "public",
      mergePolicy: "isolated"
    }
  };
  await policyEvolution.putEvaluation(evaluation);
}

import type { CapabilityPlan } from "./types.js";
import { learningConsentInput } from "./learning-review.js";

/**
 * The subject a source URI names. A fetched page titles itself for a reader
 * ("Antikythera mechanism - Wikipedia") while a corpus titles itself by subject,
 * and source-identity admission compares against the subject. Taking the URI's
 * last path segment when the document title contains it keeps acquired sources
 * addressable the same way ingested ones are, with no site or language rules. Pure.
 */
export function sourceSubjectTitle(canonicalUri: string, documentTitle: string): string {
  const withoutQuery = canonicalUri.split(/[?#]/u)[0] ?? "";
  const segment = withoutQuery.split("/").filter(Boolean).pop() ?? "";
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    decoded = segment;
  }
  const subject = decoded.replace(/\.[\p{L}\p{N}]{1,5}$/u, "").replace(/[_+]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!subject) return documentTitle;
  const normalize = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const normalizedSubject = normalize(subject);
  if (!normalizedSubject) return documentTitle;
  return normalize(documentTitle).includes(normalizedSubject) ? subject : documentTitle;
}

export function createRuntimeAcquisition(options: {
  now?: () => number;
  deps: ScceKernelDeps;
  eventFactory: ReturnType<typeof createEventFactory>;
  hasher: ReturnType<typeof createHasher>;
  failures: string[];
  append(event: ScceEvent): Promise<ScceEvent>;
  ingest(input: IngestInput): Promise<IngestResult>;
}) {
  const { deps, eventFactory, hasher, failures, append, ingest: ingestSource } = options;
  const now = options.now ?? (() => Date.now());
  // The composition root is responsible for requiring both public-internet
  // scope and standing read-only search consent before setting this flag.
  // Keeping the decision here as a source-admission mode preserves the
  // distinction between a fetched source saying P and SCCE believing P.
  const runtimeWebPromotionAuthority = deps.runtimeWebAutomaticAdmission ? "automatic" as const : "review" as const;


  // Runtime-acquired pages are bounded at the fetch, before any parser sees them.
  const MAX_ACQUIRED_SOURCE_BYTES = 2 * 1024 * 1024;
  async function learnHydrateReplan(input: {
    ownerInput: OwnerInput;
    episodeId: EpisodeId;
    requestedAuthority: RequestedAuthority;
    trigger: RuntimeReplanTrigger;
    events: ScceEvent[];
    priorRejectedHypotheses?: PriorRejectedHypothesis[];
    /** Optional stream hook; production wiring may adapt this to OwnerInput.runtimeControl. */
    onProgress?: (progress: RuntimeAcquisitionProgress) => void;
    /** Optional caller-derived competing-claim search surface. */
    adversarialSearch?: RuntimeAdversarialSearchRequest;
  }): Promise<RuntimeReplanMotion> {
    const queryHash = hasher.digestHex(input.ownerInput.text);
    const guardId = `runtime-motion:${hasher.digestHex(`${String(input.episodeId)}\u001f${queryHash}\u001f${input.trigger}`).slice(0, 32)}`;
    const motionFailures: string[] = [];
    const fetchPlans: JsonValue[] = [];
    let searchResultCount = 0;
    let fetchedSourceCount = 0;
    let ingestedSourceCount = 0;
    let ingestedEvidenceCount = 0;
    const ingestedEvidenceGroups: string[][] = [];
    const sourceUris: string[] = [];
    const sourceSurfaces: string[] = [];
    const heldCandidates = new Map<string, { title: string; snippet: string }>();
    const sourceLineageIds: string[] = [];
    const acceptedLineageGroups = new Set<string>();
    const seenCanonicalUris = new Set<string>();
    const seenContentHashes = new Set<string>();
    let duplicateSourceCount = 0;
    let duplicateContentCount = 0;
    let searchLeadsExamined = 0;
    let adversarialSearchResult: RuntimeAdversarialSearchResult | undefined;
    const emitProgress = (phase: string, cognition?: JsonValue): void => {
      try {
        input.onProgress?.({
          phase,
          observedAtMonotonicMs: performance.now(),
          ...(cognition === undefined ? {} : { cognition })
        });
      } catch {
        // A UI/stream observer cannot make acquisition fail or alter its proof path.
      }
    };
    const consentInput = learningConsentInput(input.ownerInput.text, hasher);
    const consentGranted = deps.approvals?.isApproved({ capabilityId: "network.search", input: consentInput }) === true;
    let consent: RuntimeReplanMotion["consent"];
    if (deps.connectors && !consentGranted) {
      // Unknown topics ask before touching the network: the plan waits in the approval session until the owner says yes.
      const planId = `capability_network.search_${hasher.digestHex(`${queryHash}\u001fconsent`).slice(0, 32)}`;
      const plan: CapabilityPlan = {
        id: planId as CapabilityPlan["id"],
        episodeId: input.episodeId,
        capabilityId: "network.search",
        phase: "prepare",
        status: "planned",
        input: consentInput,
        riskVector: { risk: 0.32, mutates: false },
        permission: { allowed: false, dryRun: true, requiresExplicitApproval: true, reason: "owner-consent-required" },
        createdAt: now()
      };
      await deps.storage.capabilities.putPlan(plan);
      await deps.approvals?.observePending(plan);
      consent = { capabilityId: "network.search", planId, granted: false };
    }
    input.events.push(await append(eventFactory.create({
      episodeId: input.episodeId,
      typeId: "RuntimeMotionPlanned",
      payload: toJsonValue({
        schema: "scce.runtime_motion.learn_hydrate_replan.v1",
        motionId: "motion.learn_hydrate_replan",
        guardId,
        attempt: 1,
        trigger: input.trigger,
        requestedAuthority: input.requestedAuthority,
        queryHash,
        connectorConfigured: Boolean(deps.connectors),
        consentGranted,
        searchLimit: RUNTIME_ACQUISITION_SEARCH_LIMIT,
        requestedSourceLineages: RUNTIME_ACQUISITION_MAX_LINEAGES,
        adversarialSearchRequested: Boolean(input.adversarialSearch),
        readOnlyOperations: ["search", "fetch"]
      })
    })));

    if (deps.connectors && consentGranted) {
      let searchRows: Awaited<ReturnType<typeof deps.connectors.search>> = [];
      try {
        const dispatched = deps.executive
          ? await dispatchWebSearchThroughExecutive({ deps, episodeId: input.episodeId, queryHash, query: input.ownerInput.text, limit: RUNTIME_ACQUISITION_SEARCH_LIMIT, hasher })
          : undefined;
        searchRows = dispatched ?? await deps.connectors.search(input.ownerInput.text, RUNTIME_ACQUISITION_SEARCH_LIMIT);
        searchResultCount = searchRows.length;
        sourceSurfaces.push(...searchRows.flatMap(row => [row.title, row.snippet])
          .map(surface => sourceTextSurface(surface, 320))
          .filter(Boolean));
      } catch (error) {
        motionFailures.push(runtimeMotionFailure("search", error));
      }
      emitProgress("runtime.acquisition.primary.search", toJsonValue({ searchResultCount: searchRows.length, requestedSourceLineages: RUNTIME_ACQUISITION_MAX_LINEAGES }));
      for (const searchRow of searchRows.slice(0, RUNTIME_ACQUISITION_SEARCH_LIMIT)) {
        if (acceptedLineageGroups.size >= RUNTIME_ACQUISITION_MAX_LINEAGES) break;
        searchLeadsExamined++;
        const searchUri = searchRow.uri.trim();
        const canonicalSearchUri = canonicalAcquisitionUri(searchUri);
        if (!searchUri || seenCanonicalUris.has(canonicalSearchUri)) {
          duplicateSourceCount++;
          continue;
        }
        const candidateLineageGroup = acquisitionLineageGroup(canonicalSearchUri, searchRow.metadata);
        if (acceptedLineageGroups.has(candidateLineageGroup)) {
          duplicateSourceCount++;
          continue;
        }
        seenCanonicalUris.add(canonicalSearchUri);
        // A result row is a lead, never evidence. Its explicit plan requires a
        // source snapshot and canonical admission before use. A snippet can
        // never shortcut into the corpus.
        const lead: SearchResultLead = {
          id: `search_lead.${hasher.digestHex(canonicalSearchUri).slice(0, 32)}`,
          provider: "local_index",
          title: searchRow.title,
          uri: searchUri,
          snippet: searchRow.snippet,
          rank: searchLeadsExamined,
          evidenceStatus: "lead_only",
          fetched: false,
          metadata: toJsonValue({ queryHash, phase: "primary" })
        };
        try {
          assertSearchLeadIsNotEvidence(lead);
        } catch (error) {
          motionFailures.push(runtimeMotionFailure("search-lead", error));
          continue;
        }
        fetchPlans.push(searchLeadToFetchPlan(lead, {
          id: `learning_need.${queryHash}`,
          gapKind: "source_discovery",
          objective: input.ownerInput.text.slice(0, 200),
          constraints: toJsonValue({ readOnly: true, admissionBeforeUse: runtimeWebPromotionAuthority === "automatic" ? "canonical-source-qualified" : "quarantine-before-use" }),
          createdAt: Date.now()
        }));
        emitProgress("runtime.acquisition.primary.fetch", toJsonValue({ uriHash: hasher.digestHex(canonicalSearchUri).slice(0, 24), leadRank: searchLeadsExamined }));
        try {
          const fetched = await deps.connectors.fetch(searchUri);
          if (fetched.bytes.byteLength === 0) {
            motionFailures.push(`fetch returned zero bytes: ${redactSecrets(searchUri)}`);
            continue;
          }
          if (fetched.bytes.byteLength > MAX_ACQUIRED_SOURCE_BYTES) {
            motionFailures.push(`fetch exceeded acquisition byte cap (${fetched.bytes.byteLength} > ${MAX_ACQUIRED_SOURCE_BYTES}): ${redactSecrets(searchUri)}`);
            continue;
          }
          fetchedSourceCount++;
          const canonicalUri = canonicalAcquisitionUri(fetched.uri.trim() || searchUri);
          if (seenCanonicalUris.has(canonicalUri) && canonicalUri !== canonicalSearchUri) {
            duplicateSourceCount++;
            continue;
          }
          seenCanonicalUris.add(canonicalUri);
          const contentHash = hasher.digestHex(fetched.bytes);
          if (seenContentHashes.has(contentHash)) {
            duplicateContentCount++;
            continue;
          }
          seenContentHashes.add(contentHash);
          const lineageGroup = acquisitionLineageGroup(canonicalUri, searchRow.metadata, fetched.metadata);
          if (acceptedLineageGroups.has(lineageGroup)) {
            duplicateSourceCount++;
            continue;
          }
          const ingest = await ingestSource({
            uri: canonicalUri,
            namespace: "runtime-acquisition",
            sourceAdmission: {
              sourceClass: "runtime_web",
              intendedUse: "direct_evidence",
              promotionAuthority: runtimeWebPromotionAuthority
            },
            sourceTrust: {
              identity: 0.68,
              integrity: 1,
              parserReliability: 0.78,
              directness: 0.72,
              authority: 0.52,
              freshness: 0.9,
              independenceGroup: lineageGroup,
              accessScope: "public",
              licenseStatus: "unknown"
            },
            content: fetched.bytes,
            ...(fetched.evidenceDerivative ? { evidenceDerivative: fetched.evidenceDerivative } : {}),
            mediaType: fetched.mediaType || "application/octet-stream",
            metadata: toJsonValue({
              ...fetchedExtractorMetadata(fetched.metadata),
              schema: "scce.runtime_acquired_source.v1",
              canonicalUri,
              sourceUri: canonicalUri,
              uri: canonicalUri,
              title: sourceSubjectTitle(canonicalUri, searchRow.title),
              snippet: searchRow.snippet,
              acquisition: {
                motionId: "motion.learn_hydrate_replan",
                guardId,
                trigger: input.trigger,
                requestedAuthority: input.requestedAuthority,
                parentEpisodeId: String(input.episodeId),
                phase: "primary",
                lineageGroup,
                contentHash,
                search: {
                  uri: searchUri,
                  title: searchRow.title,
                  snippet: searchRow.snippet,
                  metadata: searchRow.metadata
                },
                fetch: {
                  uri: canonicalUri,
                  mediaType: fetched.mediaType,
                  metadata: fetched.metadata
                }
              }
            })
          });
          ingestedSourceCount += ingest.sources;
          if (ingest.events.some(event => event.typeId === "SourcePromoted")) {
            ingestedEvidenceCount += ingest.evidence;
            ingestedEvidenceGroups.push((ingest.promotedEvidenceIds ?? []).map(String).slice(0, 80));
          }
          // A downloaded document is only a useful lineage when the canonical
          // ingestor extracted addressable evidence from it. Counting an empty
          // or unsupported payload would let four URLs masquerade as four
          // sources capable of informing the replan.
          if (ingest.sources > 0 && ingest.evidence > 0) {
            acceptedLineageGroups.add(lineageGroup);
            sourceLineageIds.push(lineageGroup);
            sourceUris.push(canonicalUri);
            heldCandidates.set(canonicalUri, { title: searchRow.title, snippet: searchRow.snippet });
            emitProgress("runtime.acquisition.primary.ingest", toJsonValue({ uriHash: hasher.digestHex(canonicalUri).slice(0, 24), lineageHash: hasher.digestHex(lineageGroup).slice(0, 24), acceptedLineageCount: acceptedLineageGroups.size }));
          } else {
            motionFailures.push(`canonical ingest extracted no evidence: ${redactSecrets(canonicalUri)}`);
          }
        } catch (error) {
          motionFailures.push(runtimeMotionFailure(`fetch_ingest:${searchUri}`, error));
        }
      }
      if (input.adversarialSearch?.querySurface.trim()) {
        const adversarialQuery = input.adversarialSearch.querySurface.trim();
        const adversarialQueryHash = hasher.digestHex(adversarialQuery);
        const adversarialFailures: string[] = [];
        let adversarialRows: Awaited<ReturnType<typeof deps.connectors.search>> = [];
        const normalizedQuery = (query: string) => query.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
        const distinctQuery = normalizedQuery(adversarialQuery) !== normalizedQuery(input.ownerInput.text);
        if (!distinctQuery) adversarialFailures.push("counterclaim.query_echo");
        if (distinctQuery) {
          emitProgress("runtime.acquisition.adversarial.search", toJsonValue({ querySurfaceHash: adversarialQueryHash.slice(0, 24), originalQueryHash: queryHash.slice(0, 24), intentId: input.adversarialSearch.intentId ?? null }));
          try {
            const dispatched = deps.executive
              ? await dispatchWebSearchThroughExecutive({ deps, episodeId: input.episodeId, queryHash: adversarialQueryHash, query: adversarialQuery, limit: RUNTIME_ACQUISITION_SEARCH_LIMIT, hasher })
              : undefined;
            adversarialRows = dispatched ?? await deps.connectors.search(adversarialQuery, RUNTIME_ACQUISITION_SEARCH_LIMIT);
          } catch (error) {
            adversarialFailures.push(runtimeMotionFailure("adversarial_search", error));
          }
        }
        const adversarialUris: string[] = [];
        const adversarialLineages: string[] = [];
        let adversarialFetched = 0;
        let adversarialSources = 0;
        let adversarialEvidence = 0;
        for (const searchRow of adversarialRows.slice(0, RUNTIME_ACQUISITION_SEARCH_LIMIT)) {
          if (adversarialLineages.length >= 1) break;
          searchLeadsExamined++;
          const searchUri = searchRow.uri.trim();
          const canonicalSearchUri = canonicalAcquisitionUri(searchUri);
          if (!searchUri || seenCanonicalUris.has(canonicalSearchUri)) {
            duplicateSourceCount++;
            continue;
          }
          const candidateLineageGroup = acquisitionLineageGroup(canonicalSearchUri, searchRow.metadata);
          if (acceptedLineageGroups.has(candidateLineageGroup)) {
            duplicateSourceCount++;
            continue;
          }
          seenCanonicalUris.add(canonicalSearchUri);
          emitProgress("runtime.acquisition.adversarial.fetch", toJsonValue({ uriHash: hasher.digestHex(canonicalSearchUri).slice(0, 24), leadRank: searchLeadsExamined }));
          try {
            const fetched = await deps.connectors.fetch(searchUri);
            if (fetched.bytes.byteLength === 0) {
              adversarialFailures.push(`adversarial fetch returned zero bytes: ${redactSecrets(searchUri)}`);
              continue;
            }
            if (fetched.bytes.byteLength > MAX_ACQUIRED_SOURCE_BYTES) {
              adversarialFailures.push(`adversarial fetch exceeded acquisition byte cap (${fetched.bytes.byteLength} > ${MAX_ACQUIRED_SOURCE_BYTES}): ${redactSecrets(searchUri)}`);
              continue;
            }
            fetchedSourceCount++;
            adversarialFetched++;
            const canonicalUri = canonicalAcquisitionUri(fetched.uri.trim() || searchUri);
            if (seenCanonicalUris.has(canonicalUri) && canonicalUri !== canonicalSearchUri) {
              duplicateSourceCount++;
              continue;
            }
            seenCanonicalUris.add(canonicalUri);
            const contentHash = hasher.digestHex(fetched.bytes);
            if (seenContentHashes.has(contentHash)) {
              duplicateContentCount++;
              continue;
            }
            seenContentHashes.add(contentHash);
            const lineageGroup = acquisitionLineageGroup(canonicalUri, searchRow.metadata, fetched.metadata);
            if (acceptedLineageGroups.has(lineageGroup)) {
              duplicateSourceCount++;
              continue;
            }
            const ingest = await ingestSource({
              uri: canonicalUri,
              namespace: "runtime-acquisition",
              sourceAdmission: { sourceClass: "runtime_web", intendedUse: "direct_evidence", promotionAuthority: runtimeWebPromotionAuthority },
              sourceTrust: { identity: 0.68, integrity: 1, parserReliability: 0.78, directness: 0.72, authority: 0.52, freshness: 0.9, independenceGroup: lineageGroup, accessScope: "public", licenseStatus: "unknown" },
              content: fetched.bytes,
              ...(fetched.evidenceDerivative ? { evidenceDerivative: fetched.evidenceDerivative } : {}),
              mediaType: fetched.mediaType || "application/octet-stream",
              metadata: toJsonValue({
                ...fetchedExtractorMetadata(fetched.metadata),
                schema: "scce.runtime_acquired_source.v1",
                canonicalUri,
                sourceUri: canonicalUri,
                uri: canonicalUri,
                title: sourceSubjectTitle(canonicalUri, searchRow.title),
                snippet: searchRow.snippet,
                acquisition: { motionId: "motion.learn_hydrate_replan", guardId, trigger: input.trigger, requestedAuthority: input.requestedAuthority, parentEpisodeId: String(input.episodeId), phase: "adversarial", lineageGroup, contentHash, search: { uri: searchUri, title: searchRow.title, snippet: searchRow.snippet, metadata: searchRow.metadata }, fetch: { uri: canonicalUri, mediaType: fetched.mediaType, metadata: fetched.metadata } }
              })
            });
            ingestedSourceCount += ingest.sources;
            adversarialSources += ingest.sources;
            if (ingest.events.some(event => event.typeId === "SourcePromoted")) {
              ingestedEvidenceCount += ingest.evidence;
              adversarialEvidence += ingest.evidence;
              ingestedEvidenceGroups.push((ingest.promotedEvidenceIds ?? []).map(String).slice(0, 80));
            }
            if (ingest.sources > 0 && ingest.evidence > 0) {
              acceptedLineageGroups.add(lineageGroup);
              sourceLineageIds.push(lineageGroup);
              adversarialLineages.push(lineageGroup);
              sourceUris.push(canonicalUri);
              adversarialUris.push(canonicalUri);
              heldCandidates.set(canonicalUri, { title: searchRow.title, snippet: searchRow.snippet });
              emitProgress("runtime.acquisition.adversarial.ingest", toJsonValue({ uriHash: hasher.digestHex(canonicalUri).slice(0, 24), lineageHash: hasher.digestHex(lineageGroup).slice(0, 24) }));
            } else {
              adversarialFailures.push(`canonical adversarial ingest extracted no evidence: ${redactSecrets(canonicalUri)}`);
            }
          } catch (error) {
            adversarialFailures.push(runtimeMotionFailure(`adversarial_fetch_ingest:${searchUri}`, error));
          }
        }
        adversarialSearchResult = {
          searchKind: "counterclaim",
          attempted: distinctQuery,
          querySurfaceHash: adversarialQueryHash,
          ...(input.adversarialSearch.targetLanguageId ? { targetLanguageId: input.adversarialSearch.targetLanguageId } : {}),
          ...(input.adversarialSearch.intentId ? { intentId: input.adversarialSearch.intentId } : {}),
          ...(input.adversarialSearch.claimHash ? { claimHash: input.adversarialSearch.claimHash } : {}),
          ...(input.adversarialSearch.originalQueryHash ? { originalQueryHash: input.adversarialSearch.originalQueryHash } : {}),
          ...(input.adversarialSearch.realizationAudit ? { realizationAudit: input.adversarialSearch.realizationAudit } : {}),
          searchResultCount: adversarialRows.length,
          fetchedSourceCount: adversarialFetched,
          ingestedSourceCount: adversarialSources,
          ingestedEvidenceCount: adversarialEvidence,
          sourceUris: uniqueKernelStrings(adversarialUris),
          sourceLineageIds: uniqueKernelStrings(adversarialLineages),
          failures: adversarialFailures.slice(0, 6)
        };
        motionFailures.push(...adversarialFailures);
      }
    }

    let heldSources: NonNullable<RuntimeReplanMotion["heldSources"]> = [];
    if (fetchedSourceCount > 0 && ingestedEvidenceCount === 0) {
      try {
        const pending = await deps.storage.quarantine.listPending({ limit: 24 });
        heldSources = pending
          .filter(item => heldCandidates.has(item.uri))
          .map(item => ({ id: item.id, uri: item.uri, title: sourceTextSurface(heldCandidates.get(item.uri)?.title ?? "", 160), snippet: sourceTextSurface(heldCandidates.get(item.uri)?.snippet ?? "", 320) }))
          .slice(0, 3);
      } catch (error) {
        motionFailures.push(runtimeMotionFailure("held_sources", error));
      }
    }
    const status: RuntimeReplanMotion["status"] = !deps.connectors
      ? "unavailable"
      : !consentGranted
        ? "awaiting_consent"
        : ingestedEvidenceCount > 0
          ? "hydrated"
          : heldSources.length > 0
            ? "held_for_review"
            : motionFailures.length > 0 && searchResultCount === 0
              ? "failed"
              : "empty";
    const motion: RuntimeReplanMotion = {
      schema: "scce.runtime_motion.learn_hydrate_replan.v1",
      motionId: "motion.learn_hydrate_replan",
      guardId,
      attempt: 1,
      trigger: input.trigger,
      requestedAuthority: input.requestedAuthority,
      parentEpisodeId: String(input.episodeId),
      queryHash,
      connectorConfigured: Boolean(deps.connectors),
      status,
      ...(consent ? { consent } : {}),
      ...(heldSources.length ? { heldSources } : {}),
      searchResultCount,
      // Each lead's explicit plan retains whether canonical source-qualified
      // admission or review quarantine governs the fetched snapshot.
      ...(fetchPlans.length ? { searchLeadFetchPlans: fetchPlans.slice(0, RUNTIME_ACQUISITION_SEARCH_LIMIT) } : {}),
      fetchedSourceCount,
      ingestedSourceCount,
      ingestedEvidenceCount,
      // Interleave sources so a long primary document cannot occupy the
      // entire bounded frontier before the counterclaim source is visited.
      ingestedEvidenceIds: uniqueKernelStrings(Array.from({ length: 80 }, (_, index) =>
        ingestedEvidenceGroups.flatMap(group => group[index] ? [group[index]!] : [])
      ).flat()).slice(0, 80),
      sourceUris: uniqueKernelStrings(sourceUris).slice(0, RUNTIME_ACQUISITION_SEARCH_LIMIT),
      sourceSurfaces: uniqueKernelStrings(sourceSurfaces).slice(0, 6),
      failures: motionFailures.slice(0, 6),
      priorRejectedHypotheses: input.priorRejectedHypotheses ?? [],
      sourceLineageIds: uniqueKernelStrings(sourceLineageIds).slice(0, RUNTIME_ACQUISITION_SEARCH_LIMIT),
      acceptedSourceLineageCount: acceptedLineageGroups.size,
      duplicateSourceCount,
      duplicateContentCount,
      sourceCoverage: { requestedLineages: RUNTIME_ACQUISITION_MAX_LINEAGES, acceptedLineages: acceptedLineageGroups.size, searchLeadsExamined },
      ...(adversarialSearchResult ? { adversarialSearch: adversarialSearchResult } : {})
    };
    emitProgress("runtime.acquisition.complete", toJsonValue({ status, acceptedLineageCount: acceptedLineageGroups.size, fetchedSourceCount, ingestedEvidenceCount }));
    input.events.push(await append(eventFactory.create({
      episodeId: input.episodeId,
      typeId: "RuntimeMotionCompleted",
      payload: toJsonValue(motion)
    })));
    return motion;
  }

  function runtimeWebIndependenceGroup(uri: string): string {
    try {
      return `runtime-web:${new URL(uri).hostname.toLocaleLowerCase()}`;
    } catch {
      return `runtime-web:${hasher.digestHex(uri).slice(0, 24)}`;
    }
  }

  /** Prefer source-declared dependency/family lineage; host grouping is only the fallback. */
  function acquisitionLineageGroup(uri: string, ...metadata: JsonValue[]): string {
    for (const value of metadata) {
      for (const key of ["sourceFamilyId", "dependencyFamilyId", "independenceGroup", "lineageId", "dependencyGroupId"]) {
        const declared = jsonObjectValue(value, key);
        if (declared) return `declared:${declared}`;
      }
    }
    return runtimeWebIndependenceGroup(uri);
  }


  /**
   * Registers the owner-consent request for a search, without performing one.
   *
   * Asking costs one bounded plan write and touches no network -- the search itself only runs once consent exists --
   * so it is affordable on a turn that cannot afford the search. Same plan id as the acquisition path derives, so an
   * owner approving this request satisfies the later attempt rather than being asked twice.
   */
  async function proposeSearchConsent(episodeId: EpisodeId, requestText: string): Promise<RuntimeReplanMotion["consent"]> {
    if (!deps.connectors) return undefined;
    const consentInput = learningConsentInput(requestText, hasher);
    if (deps.approvals?.isApproved({ capabilityId: "network.search", input: consentInput }) === true) return undefined;
    const queryHash = hasher.digestHex(requestText);
    const planId = `capability_network.search_${hasher.digestHex(`${queryHash}consent`).slice(0, 32)}`;
    const plan: CapabilityPlan = {
      id: planId as CapabilityPlan["id"],
      episodeId,
      capabilityId: "network.search",
      phase: "prepare",
      status: "planned",
      input: consentInput,
      riskVector: { risk: 0.32, mutates: false },
      permission: { allowed: false, dryRun: true, requiresExplicitApproval: true, reason: "owner-consent-required" },
      createdAt: now()
    };
    await deps.storage.capabilities.putPlan(plan);
    await deps.approvals?.observePending(plan);
    return { capabilityId: "network.search", planId, granted: false };
  }

  /**
   * The turn could not afford to go and look, so it asks instead of going quiet.
   *
   * Every API turn runs under the fast budget, so the acquisition checkpoint's five-second reservation is refused
   * and this deferred path is what a served request actually takes. It reported status "unavailable" and registered
   * nothing, so a question the engine had no evidence for returned an empty answer and no request to go find any --
   * measured on "What is DNA?" against a configured, enabled web connector. The reservation protects the SEARCH,
   * which needs consent this turn does not have; recording the request needs neither the network nor the budget.
   */
  async function runtimeMotionDeferredByDeadline(input: {
    episodeId: EpisodeId;
    requestedAuthority: RequestedAuthority;
    trigger: RuntimeReplanTrigger;
    requestText: string;
    connectorConfigured: boolean;
    decision?: RuntimeDeadlineDecision;
  }): Promise<RuntimeReplanMotion> {
    const consent = await proposeSearchConsent(input.episodeId, input.requestText).catch(() => undefined);
    const queryHash = hasher.digestHex(input.requestText);
    const guardId = `runtime-motion:${hasher.digestHex(`${String(input.episodeId)}\u001f${queryHash}\u001f${input.trigger}\u001fdeadline`).slice(0, 32)}`;
    const reason = input.decision
      ? `deadline_guard:not_started:${input.decision.phase}:${input.decision.reason}`
      : "deadline_guard:not_started";
    return {
      schema: "scce.runtime_motion.learn_hydrate_replan.v1",
      motionId: "motion.learn_hydrate_replan",
      guardId,
      attempt: 1,
      trigger: input.trigger,
      requestedAuthority: input.requestedAuthority,
      parentEpisodeId: String(input.episodeId),
      queryHash,
      connectorConfigured: input.connectorConfigured,
      status: consent ? "awaiting_consent" : "unavailable",
      ...(consent ? { consent } : {}),
      searchResultCount: 0,
      fetchedSourceCount: 0,
      ingestedSourceCount: 0,
      ingestedEvidenceCount: 0,
      sourceUris: [],
      sourceSurfaces: [],
      failures: [reason],
      priorRejectedHypotheses: []
    };
  }

  /** Whether the owner has already consented to searching for this request, so the turn need not ask again. */
  function searchConsentGranted(requestText: string): boolean {
    return deps.approvals?.isApproved({
      capabilityId: "network.search",
      input: learningConsentInput(requestText, hasher)
    }) === true;
  }

  return { learnHydrateReplan, runtimeMotionDeferredByDeadline, searchConsentGranted };
}
