import type { EventLedger } from "./storage.js";
import type { ConsolidatedEpisode } from "./episodic-memory-consolidation.js";
import type { EpisodeId, Hasher } from "./types.js";
import { createHasher } from "./primitives.js";
import {
  induceOperatorCandidate,
  evaluateOperatorPromotion,
  type EpisodeTrace,
  type OperatorPromotionResult
} from "./induced-reasoning-operator.js";

/**
 * Plan item 161 live wiring: mines the real, durable, cross-episode event
 * ledger for `EpisodeConsolidated` history (the same real records
 * `episodic-memory-consolidation.ts` writes at every turn's real exit
 * paths, `production-turn-runtime.ts`) into real `EpisodeTrace`s, splits
 * them into disjoint fit/held-out sets, and induces + evaluates one
 * operator candidate -- the same real, already-tested
 * `induced-reasoning-operator.ts` logic this module never reimplements.
 * Mirrors `procedural-skill-runtime.ts`'s ledger-mining pattern (items
 * 215-216) rather than inventing a new one.
 */

/**
 * One real trace per consolidated episode whose real action events (read
 * back from the ledger by id, never re-derived from prose) contain at
 * least 2 steps -- the minimum an induced operator can be. Episodes with
 * fewer real action events are honestly excluded, not padded.
 */

/**
 * One batched, payload-free read for every episode's event skeletons,
 * replacing a readEpisode call per episode: measured at 242 queries and
 * 6.9s of a single warm turn's database time across the two history-
 * induction runtimes that share this. Falls back to per-episode reads for
 * stores that do not implement the batched reader.
 */
async function episodeEventSkeletonsByEpisode(
  events: EventLedger,
  episodeIds: readonly string[]
): Promise<Map<string, Array<{ id: string; typeId: string }>>> {
  const byEpisode = new Map<string, Array<{ id: string; typeId: string }>>();
  if (!episodeIds.length) return byEpisode;
  if (events.readEpisodeEventSkeletons) {
    for (const row of await events.readEpisodeEventSkeletons(episodeIds as EpisodeId[])) {
      const bucket = byEpisode.get(row.episodeId) ?? [];
      bucket.push({ id: row.id, typeId: row.typeId });
      byEpisode.set(row.episodeId, bucket);
    }
    return byEpisode;
  }
  for (const episodeId of episodeIds) {
    const rows = await events.readEpisode(episodeId as EpisodeId);
    byEpisode.set(episodeId, rows.map(event => ({ id: String(event.id), typeId: String(event.typeId) })));
  }
  return byEpisode;
}

export async function episodeActionTypeTraces(events: EventLedger, limit = 256): Promise<EpisodeTrace[]> {
  const consolidatedRows = await events.readRange({ typeId: "EpisodeConsolidated", limit });
  const consolidatedByEpisode = new Map<string, ConsolidatedEpisode>();
  for (const row of consolidatedRows) {
    const consolidated = row.payload as unknown as ConsolidatedEpisode;
    const episodeId = consolidated?.episodeId;
    if (episodeId && !consolidatedByEpisode.has(String(episodeId))) consolidatedByEpisode.set(String(episodeId), consolidated);
  }
  const skeletons = await episodeEventSkeletonsByEpisode(events, [...consolidatedByEpisode.keys()]);
  const traces: EpisodeTrace[] = [];
  for (const [episodeId, consolidated] of consolidatedByEpisode) {
    const episodeEvents = skeletons.get(episodeId) ?? [];
    const eventsById = new Map(episodeEvents.map(event => [event.id, event]));
    const actionTypeSequence = (consolidated.actionEventIds ?? [])
      .map(id => eventsById.get(String(id))?.typeId)
      .filter((typeId): typeId is NonNullable<typeof typeId> => Boolean(typeId))
      .map(typeId => String(typeId));
    if (actionTypeSequence.length < 2) continue;
    const succeeded = episodeEvents.some(event => event.typeId === "CapabilitySucceeded")
      && !episodeEvents.some(event => event.typeId === "CapabilityFailed");
    traces.push({ episodeId, actionTypeSequence, succeeded });
  }
  return traces;
}

/**
 * Deterministic, hash-based fit/held-out split -- not random, so the same
 * real ledger content always produces the same split (reproducible, and
 * immune to whatever order `readRange` happens to return rows in). An
 * episode's bucket depends only on its own id, so growing the ledger
 * over time never reshuffles which past episodes were held out.
 */
export function splitFitHeldOut(
  traces: readonly EpisodeTrace[],
  heldOutFraction: number,
  hasher: Hasher = createHasher()
): { fit: EpisodeTrace[]; heldOut: EpisodeTrace[] } {
  if (heldOutFraction <= 0 || heldOutFraction >= 1) throw new Error("heldOutFraction must be within (0,1)");
  const fit: EpisodeTrace[] = [];
  const heldOut: EpisodeTrace[] = [];
  for (const trace of traces) {
    const digest = hasher.digestHex(trace.episodeId);
    const bucket = parseInt(digest.slice(0, 8), 16) / 0xffffffff;
    (bucket < heldOutFraction ? heldOut : fit).push(trace);
  }
  return { fit, heldOut };
}

export interface InducedOperatorFromLedgerResult {
  candidate: ReturnType<typeof induceOperatorCandidate>;
  promotion: OperatorPromotionResult;
  fitCount: number;
  heldOutCount: number;
}

/**
 * The real end-to-end pass (item 161): mine the ledger, split fit/held-out,
 * induce a candidate from the fit set, and evaluate it against the
 * disjoint held-out set. Returns undefined honestly -- never a fabricated
 * candidate -- when there isn't enough real history yet, either because
 * too few episodes exist at all or because nothing in the fit set clears
 * `minimumSupport`.
 */
export async function induceOperatorFromLedger(
  events: EventLedger,
  input: { limit?: number; heldOutFraction?: number; minimumSupport?: number; minimumTotalEpisodes?: number; hasher?: Hasher } = {}
): Promise<InducedOperatorFromLedgerResult | undefined> {
  const hasher = input.hasher ?? createHasher();
  const traces = await episodeActionTypeTraces(events, input.limit ?? 256);
  const minimumTotalEpisodes = input.minimumTotalEpisodes ?? 6;
  if (traces.length < minimumTotalEpisodes) return undefined;
  const { fit, heldOut } = splitFitHeldOut(traces, input.heldOutFraction ?? 0.3, hasher);
  if (!fit.length || !heldOut.length) return undefined;
  const candidate = induceOperatorCandidate(fit, { minimumSupport: input.minimumSupport });
  if (!candidate) return undefined;
  const promotion = evaluateOperatorPromotion(candidate, heldOut);
  return { candidate, promotion, fitCount: fit.length, heldOutCount: heldOut.length };
}
