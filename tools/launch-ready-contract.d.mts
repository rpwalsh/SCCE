// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
export const HYDRATION_REQUIREMENTS: Readonly<Record<string, number>>;

export interface ExactHydrationSummary {
  readonly ok: boolean;
  readonly countSemantics: unknown;
  readonly rows: Record<string, number | null>;
  readonly required: Record<string, number>;
  readonly failures: string[];
}

export function exactHydrationSummary(readiness: unknown): ExactHydrationSummary;
