import { createEventFactory } from "./events.js";
import { uniqueKernelStrings } from "./kernel-answer-primitives.js";
import { createHasher, redactSecrets, sourceTextSurface, toJsonValue } from "./primitives.js";
import { type RuntimeDeadlineDecision } from "./runtime-deadline.js";
import type { RuntimeReplanMotion, RuntimeReplanTrigger } from "./runtime-motion.js";
import {
  runtimeMotionFailure
} from "./runtime-motion.js";
import type { ScceKernelDeps } from "./storage.js";
import type {
  EpisodeId,
  IngestInput,
  IngestResult,
  OwnerInput,
  RequestedAuthority,
  ScceEvent
} from "./types.js";

export function createRuntimeAcquisition(options: {
  deps: ScceKernelDeps;
  eventFactory: ReturnType<typeof createEventFactory>;
  hasher: ReturnType<typeof createHasher>;
  failures: string[];
  append(event: ScceEvent): Promise<ScceEvent>;
  ingest(input: IngestInput): Promise<IngestResult>;
}) {
  const { deps, eventFactory, hasher, failures, append, ingest: ingestSource } = options;


  async function learnHydrateReplan(input: {
    ownerInput: OwnerInput;
    episodeId: EpisodeId;
    requestedAuthority: RequestedAuthority;
    trigger: RuntimeReplanTrigger;
    events: ScceEvent[];
  }): Promise<RuntimeReplanMotion> {
    const queryHash = hasher.digestHex(input.ownerInput.text);
    const guardId = `runtime-motion:${hasher.digestHex(`${String(input.episodeId)}\u001f${queryHash}\u001f${input.trigger}`).slice(0, 32)}`;
    const motionFailures: string[] = [];
    let searchResultCount = 0;
    let fetchedSourceCount = 0;
    let ingestedSourceCount = 0;
    let ingestedEvidenceCount = 0;
    const sourceUris: string[] = [];
    const sourceSurfaces: string[] = [];
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
        readOnlyOperations: ["search", "fetch"]
      })
    })));

    if (deps.connectors) {
      let searchRows: Awaited<ReturnType<typeof deps.connectors.search>> = [];
      try {
        searchRows = await deps.connectors.search(input.ownerInput.text, 3);
        searchResultCount = searchRows.length;
        sourceSurfaces.push(...searchRows.flatMap(row => [row.title, row.snippet])
          .map(surface => sourceTextSurface(surface, 320))
          .filter(Boolean));
      } catch (error) {
        motionFailures.push(runtimeMotionFailure("search", error));
      }
      const seenUris = new Set<string>();
      for (const searchRow of searchRows.slice(0, 3)) {
        const searchUri = searchRow.uri.trim();
        if (!searchUri || seenUris.has(searchUri)) continue;
        seenUris.add(searchUri);
        try {
          const fetched = await deps.connectors.fetch(searchUri);
          if (fetched.bytes.byteLength === 0) {
            motionFailures.push(`fetch returned zero bytes: ${redactSecrets(searchUri)}`);
            continue;
          }
          fetchedSourceCount++;
          const canonicalUri = fetched.uri.trim() || searchUri;
          const ingest = await ingestSource({
            uri: canonicalUri,
            namespace: "runtime-acquisition",
            sourceAdmission: {
              sourceClass: "runtime_web",
              intendedUse: "direct_evidence",
              promotionAuthority: "automatic"
            },
            sourceTrust: {
              identity: 0.68,
              integrity: 1,
              parserReliability: 0.78,
              directness: 0.72,
              authority: 0.52,
              freshness: 0.9,
              independenceGroup: runtimeWebIndependenceGroup(canonicalUri),
              accessScope: "public",
              licenseStatus: "unknown"
            },
            content: fetched.bytes,
            mediaType: fetched.mediaType || "application/octet-stream",
            metadata: toJsonValue({
              schema: "scce.runtime_acquired_source.v1",
              canonicalUri,
              sourceUri: canonicalUri,
              uri: canonicalUri,
              title: searchRow.title,
              snippet: searchRow.snippet,
              acquisition: {
                motionId: "motion.learn_hydrate_replan",
                guardId,
                trigger: input.trigger,
                requestedAuthority: input.requestedAuthority,
                parentEpisodeId: String(input.episodeId),
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
          if (ingest.events.some(event => event.typeId === "SourcePromoted")) ingestedEvidenceCount += ingest.evidence;
          if (ingest.sources > 0) sourceUris.push(canonicalUri);
        } catch (error) {
          motionFailures.push(runtimeMotionFailure(`fetch_ingest:${searchUri}`, error));
        }
      }
    }

    const status: RuntimeReplanMotion["status"] = !deps.connectors
      ? "unavailable"
      : ingestedEvidenceCount > 0
        ? "hydrated"
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
      searchResultCount,
      fetchedSourceCount,
      ingestedSourceCount,
      ingestedEvidenceCount,
      sourceUris: uniqueKernelStrings(sourceUris).slice(0, 3),
      sourceSurfaces: uniqueKernelStrings(sourceSurfaces).slice(0, 6),
      failures: motionFailures.slice(0, 6)
    };
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


  function runtimeMotionDeferredByDeadline(input: {
    episodeId: EpisodeId;
    requestedAuthority: RequestedAuthority;
    trigger: RuntimeReplanTrigger;
    requestText: string;
    connectorConfigured: boolean;
    decision?: RuntimeDeadlineDecision;
  }): RuntimeReplanMotion {
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
      status: "unavailable",
      searchResultCount: 0,
      fetchedSourceCount: 0,
      ingestedSourceCount: 0,
      ingestedEvidenceCount: 0,
      sourceUris: [],
      sourceSurfaces: [],
      failures: [reason]
    };
  }

  return { learnHydrateReplan, runtimeMotionDeferredByDeadline };
}
