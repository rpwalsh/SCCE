// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

/** Minimal async-context port used by request-owned learned-form state. */
export interface RequestContextPort<T> {
  run<R>(context: T, callback: () => R): R;
  getStore(): T | undefined;
}

/**
 * Browser Worker implementation. A Worker has one cognitive writer lane, so
 * request contexts are serialized instead of being implicitly interleaved.
 * Overlap is rejected rather than leaking one request's learned forms into
 * another request.
 */
export function createSerializedRequestContextPort<T>(): RequestContextPort<T> {
  let current: T | undefined;
  return {
    run<R>(context: T, callback: () => R): R {
      if (current !== undefined) throw new Error("portable request context does not permit overlapping cognitive executions");
      current = context;
      try {
        const result = callback();
        if (result && typeof result === "object" && typeof (result as { then?: unknown }).then === "function") {
          return Promise.resolve(result).finally(() => { current = undefined; }) as R;
        }
        current = undefined;
        return result;
      } catch (error) {
        current = undefined;
        throw error;
      }
    },
    getStore(): T | undefined { return current; }
  };
}
