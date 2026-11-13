// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createDurableExecutiveEpisode } from "../../executive-journal.js";
import { createExecutiveEpisodeMachine, type ExecutiveEpisodeId, type ExecutiveEvent } from "../../executive-episode.js";
import { createHasher } from "../../primitives.js";
import type { ExecutiveEventJournal } from "../../executive-journal.js";
import type { BlobStore } from "../../storage.js";
import type { ContentHash } from "../../types.js";
import { createScceKernel } from "../../kernel.js";
import { createRuntimeCapabilities } from "../../capability-runtime.js";
import { createConnectorCapabilityOperations } from "../../connector-capabilities.js";
import { createCapabilityRegistry, createProgramLocalValidationCapability } from "../../safety.js";
import type { ScceKernelDeps, ScceStorage } from "../../storage.js";

export function capabilityRuntimeFixture() {
  const hasher = createHasher();
  const values = new Map<string, Uint8Array>();
  const blobs: Pick<BlobStore, "put" | "get" | "putRanges" | "exists"> = {
    async put(bytes) { const hash = `sha256_${hasher.digestHex(bytes)}` as ContentHash; values.set(hash, bytes.slice()); return hash; },
    async get(hash) { const value = values.get(hash); if (!value) throw new Error(`missing blob: ${hash}`); return value.slice(); },
    async exists(hash) { return values.has(hash); },
    async putRanges(ranges, parent) {
      if (`sha256_${hasher.digestHex(parent.bytes)}` !== parent.contentHash) throw new Error("range parent hash differs");
      for (const range of ranges) {
        const bytes = parent.bytes.slice(range.byteStart, range.byteEnd);
        if (range.parentHash !== parent.contentHash || `sha256_${hasher.digestHex(bytes)}` !== range.contentHash) throw new Error("range hash differs");
        values.set(range.contentHash, bytes);
      }
    }
  };
  const events = new Map<ExecutiveEpisodeId, ExecutiveEvent[]>();
  const commands = new Map<ExecutiveEpisodeId, Set<string>>();
  const journal: ExecutiveEventJournal = {
    async read(episodeId) { const rows = events.get(episodeId) ?? []; return { episodeId, revision: rows.length, events: structuredClone(rows) }; },
    async append(input) {
      const rows = events.get(input.episodeId) ?? [];
      const ids = commands.get(input.episodeId) ?? new Set<string>();
      if (ids.has(input.commandId)) return { status: "duplicate", revision: rows.length };
      if (rows.length !== input.expectedRevision) return { status: "conflict", revision: rows.length };
      events.set(input.episodeId, [...rows, ...structuredClone(input.events)]);
      ids.add(input.commandId); commands.set(input.episodeId, ids);
      return { status: "appended", revision: rows.length + input.events.length };
    }
  };
  return { blobs, values, journal,
    executive: () => createDurableExecutiveEpisode({ machine: createExecutiveEpisodeMachine(hasher), journal, maxConflictRetries: 1 }) };
}

const kernelStates = new WeakMap<ScceStorage, ReturnType<typeof capabilityRuntimeFixture>>();

export function createCapabilityTestKernel(deps: ScceKernelDeps) {
  if (deps.capabilities) return createScceKernel(deps);
  let state = kernelStates.get(deps.storage);
  if (!state) { state = capabilityRuntimeFixture(); kernelStates.set(deps.storage, state); }
  const executive = deps.executive ?? state.executive();
  const capabilities = createRuntimeCapabilities({ executive, blobs: deps.storage.blobs,
    operations: createConnectorCapabilityOperations({ connectors: deps.connectors, buildTest: deps.buildTest, blobs: deps.storage.blobs,
      capabilities: [...createCapabilityRegistry({ process: true, network: Boolean(deps.connectors), outlook: Boolean(deps.connectors),
        youtube: Boolean(deps.connectors), telephone: Boolean(deps.connectors) }).all(), createProgramLocalValidationCapability(true)] }),
    now: () => deps.clock?.now() ?? Date.now(), dialogueMemory: deps.storage.dialogueMemory });
  return createScceKernel({ ...deps, executive, capabilities });
}
