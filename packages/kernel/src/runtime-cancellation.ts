// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
/** Cooperative boundaries do not detach in-flight work or reinterpret a visibility deadline. */
export function throwIfRuntimeAborted(signal: AbortSignal | undefined, phase: string): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error(`runtime turn aborted at ${phase}`);
}
