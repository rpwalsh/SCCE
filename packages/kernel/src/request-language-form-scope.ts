// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { AsyncLocalStorage } from "node:async_hooks";

interface RequestLanguageFormContext {
  generation: number;
  snapshots: Map<string, unknown>;
}

let nextGeneration = 0;
const contexts = new AsyncLocalStorage<RequestLanguageFormContext>();

export function withRequestLanguageFormScope<T>(run: () => Promise<T>): Promise<T> {
  const context = { generation: allocateRequestLanguageFormGeneration(), snapshots: new Map<string, unknown>() };
  return contexts.run(context, async () => {
    try { return await run(); }
    finally { context.snapshots.clear(); }
  });
}

export function allocateRequestLanguageFormGeneration(): number {
  nextGeneration += 1;
  return nextGeneration;
}

export function requestLanguageFormScopeGeneration(): number | undefined {
  return contexts.getStore()?.generation;
}

export function requestLanguageFormScopeValue<T>(key: string): { active: boolean; generation?: number; value?: T } {
  const context = contexts.getStore();
  if (!context) return { active: false };
  return { active: true, generation: context.generation, value: context.snapshots.get(key) as T | undefined };
}

export function setRequestLanguageFormScopeValue<T>(key: string, value: T): boolean {
  const context = contexts.getStore();
  if (!context) return false;
  context.snapshots.set(key, value);
  context.generation = allocateRequestLanguageFormGeneration();
  return true;
}

export function cacheRequestLanguageFormScopeValue<T>(key: string, value: T): boolean {
  const context = contexts.getStore();
  if (!context) return false;
  context.snapshots.set(key, value);
  return true;
}
