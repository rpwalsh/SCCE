export const HYDRATION_REQUIREMENTS: Readonly<Record<string, number>>;

export interface ExactHydrationSummary {
  readonly ok: boolean;
  readonly countSemantics: unknown;
  readonly rows: Record<string, number | null>;
  readonly required: Record<string, number>;
  readonly failures: string[];
}

export function exactHydrationSummary(readiness: unknown): ExactHydrationSummary;
