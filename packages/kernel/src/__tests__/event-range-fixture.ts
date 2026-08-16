import type { EventRangeQuery } from "../storage.js";
import type { EpisodeId, ScceEvent } from "../types.js";

/**
 * Shared, correctly-filtering readRange for in-memory ScceStorage test
 * fixtures -- mirrors production-turn-runtime.ts's real, filtered
 * event-range reads. Several fixtures previously stubbed readRange as
 * `async () => events`, ignoring the query entirely; that only stayed
 * invisible as long as nothing consuming the result assumed the returned
 * rows actually matched the requested typeId.
 */
export function filterEventRange(events: readonly ScceEvent[], query: EventRangeQuery): ScceEvent[] {
  let rows = events.slice();
  if (query.episodeId !== undefined) rows = rows.filter(event => event.episodeId === query.episodeId);
  if (query.typeId !== undefined) rows = rows.filter(event => event.typeId === query.typeId);
  if (query.afterT !== undefined) rows = rows.filter(event => event.t > query.afterT!);
  if (query.beforeT !== undefined) rows = rows.filter(event => event.t < query.beforeT!);
  if (query.limit !== undefined) rows = rows.slice(0, query.limit);
  return rows;
}

/** Same latent-bug class as filterEventRange, for readEpisode's narrower contract. */
export function filterEpisodeEvents(events: readonly ScceEvent[], episodeId: EpisodeId): ScceEvent[] {
  return events.filter(event => event.episodeId === episodeId);
}
