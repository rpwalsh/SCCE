// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
export const HYDRATION_REQUIREMENTS: Readonly<Record<string, number>>;

export interface HydrationSummary {
  readonly ok: boolean;
  readonly countSemantics: unknown;
  readonly rows: Record<string, number | null>;
  readonly measurements: Record<string, import("./storage-population-contract.mjs").StoragePopulationMeasurement | null>;
  readonly required: Record<string, number>;
  readonly failures: string[];
}

export type ExactHydrationSummary = HydrationSummary;
export function exactHydrationSummary(readiness: unknown): HydrationSummary;
export function hydrationSummary(readiness: unknown): HydrationSummary;
