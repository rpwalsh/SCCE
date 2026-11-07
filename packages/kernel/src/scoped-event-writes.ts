// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { AsyncLocalStorage } from "node:async_hooks";
import type { ScceEvent } from "./types.js";

interface EventWriteScope {
  open: boolean;
  events: ScceEvent[];
  flushed?: Promise<void>;
}

export function createScopedEventWrites(sink: {
  append(event: ScceEvent): Promise<void>;
  appendBatch(events: ScceEvent[]): Promise<void>;
  failedFlushDuringRunFailure(error: unknown): void;
}) {
  const scopes = new AsyncLocalStorage<EventWriteScope>();
  return {
    async append(event: ScceEvent): Promise<ScceEvent> {
      const scope = scopes.getStore();
      if (scope?.open) scope.events.push(event);
      else {
        // Detached work persists after the originating batch, never into its released array.
        if (scope?.flushed) await scope.flushed;
        await sink.append(event);
      }
      return event;
    },
    async withBufferedWrites<T>(run: () => Promise<T>): Promise<T> {
      if (scopes.getStore()?.open) return run();
      const scope: EventWriteScope = { open: true, events: [] };
      return scopes.run(scope, async () => {
        let result!: T;
        let failed = false;
        let runError: unknown;
        try { result = await run(); }
        catch (error) { failed = true; runError = error; }
        scope.open = false;
        const events = scope.events.splice(0);
        scope.flushed = events.length ? Promise.resolve().then(() => sink.appendBatch(events)) : Promise.resolve();
        try { await scope.flushed; }
        catch (error) {
          if (!failed) throw error;
          sink.failedFlushDuringRunFailure(error);
        }
        if (failed) throw runError;
        return result;
      });
    }
  };
}
