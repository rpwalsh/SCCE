export interface RuntimeSurfaceStartupInput {
  readonly warmupEnabled: boolean;
  readonly strictWarmup: boolean;
  readonly listen: () => Promise<void>;
  readonly warmup: () => Promise<void>;
  readonly onBackgroundWarmupError: (error: unknown) => void;
  readonly readiness: RuntimeStartupReadinessController;
}

export type RuntimeWarmupPhase = "pending" | "running" | "ready" | "failed" | "disabled";

export interface RuntimeStartupReadinessSnapshot {
  readonly schema: "scce.server.warmup.v1";
  readonly phase: RuntimeWarmupPhase;
  readonly ok: boolean;
  readonly complete: boolean;
  readonly error: string | null;
}

export interface RuntimeStartupReadiness {
  snapshot(): RuntimeStartupReadinessSnapshot;
}

export interface RuntimeStartupReadinessController extends RuntimeStartupReadiness {
  begin(): void;
  complete(): void;
  fail(error: unknown): void;
  disable(): void;
}

export function createRuntimeStartupReadiness(): RuntimeStartupReadinessController {
  let phase: RuntimeWarmupPhase = "pending";
  let error: string | null = null;
  return {
    snapshot: () => ({
      schema: "scce.server.warmup.v1",
      phase,
      ok: phase === "ready",
      complete: phase === "ready",
      error
    }),
    begin: () => {
      phase = "running";
      error = null;
    },
    complete: () => {
      phase = "ready";
      error = null;
    },
    fail: cause => {
      phase = "failed";
      error = boundedError(cause);
    },
    disable: () => {
      phase = "disabled";
      error = null;
    }
  };
}

/**
 * The default surface listens while warmup runs, but readiness remains false
 * until the cache is fully warm. Strict mode additionally gates the socket.
 */
export async function startRuntimeSurface(input: RuntimeSurfaceStartupInput): Promise<void> {
  if (!input.warmupEnabled) input.readiness.disable();
  if (input.warmupEnabled && input.strictWarmup) await runWarmup(input);
  await input.listen();
  if (input.warmupEnabled && !input.strictWarmup) {
    void runWarmup(input).catch(input.onBackgroundWarmupError);
  }
}

async function runWarmup(input: RuntimeSurfaceStartupInput): Promise<void> {
  input.readiness.begin();
  try {
    await input.warmup();
    input.readiness.complete();
  } catch (error) {
    input.readiness.fail(error);
    throw error;
  }
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 1000 ? message : `${message.slice(0, 1000)}...`;
}
