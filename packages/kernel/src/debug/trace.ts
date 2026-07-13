import { mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

type TraceEvent = {
  traceId?: string;
  time: string;
  stage: string;
  label?: string;
  durationMs?: number;
  input?: string;
  output?: string;
  counts?: Record<string, number>;
  support?: Record<string, unknown>;
  warnings?: string[];
  file?: string;
  line?: number;
};

type TraceHandle = {
  traceId: string;
  file: string;
};

// Not a module-level handle; callers must store their own TraceHandle from createTrace.

function resolveDir(): string {
  return process.env.SCCE_TRACE_DIR ?? '.scce/traces';
}

function makeTraceId(): string {
  return `trace_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function redact(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k.toLowerCase().includes('secret') || k.toLowerCase().includes('password') || k.toLowerCase().includes('token')) out[k] = '***';
    else out[k] = redact(v);
  }
  return out;
}

export function createTrace(label?: string): TraceHandle | undefined {
  if (process.env.SCCE_TRACE !== '1') return undefined;
  const traceId = makeTraceId();
  const now = new Date().toISOString();
  const file = join(resolveDir(), `${now.replace(/[:.]/g, '-')}-${traceId}.jsonl`);
  const event: TraceEvent = { traceId, time: now, stage: 'trace.open', label };
  try {
    if (!existsSync(resolveDir())) mkdirSync(resolveDir(), { recursive: true });
    appendFileSync(file, JSON.stringify(event) + '\n', 'utf8');
  } catch {
    // If trace setup fails, return undefined so callers skip tracing
    return undefined;
  }
  return { traceId, file };
}

export function traceEvent(trace: TraceHandle | undefined, event: Omit<TraceEvent, 'traceId' | 'time'>): void {
  if (!trace) return;
  const full: TraceEvent = { traceId: trace.traceId, time: new Date().toISOString(), ...event };
  try { appendFileSync(trace.file, JSON.stringify(redact(full)) + '\n', 'utf8'); } catch {}
}

export function traceSpan<T>(
  trace: TraceHandle | undefined,
  stage: string,
  label: string,
  fn: () => T
): T {
  const start = Date.now();
  // We must not change runtime semantics. This means:
  // - Always return the wrapped function result
  // - Always rethrow errors after recording
  try {
    const result = fn();
    if (result !== null && typeof result === 'object' && typeof (result as unknown as Promise<unknown>).then === 'function') {
      // fn returned a Promise-like
      const promise = result as unknown as Promise<unknown>;
      const traced = promise.then(
        (value) => {
          traceEvent(trace, { stage, label, durationMs: Date.now() - start });
          return value;
        },
        (error) => {
          traceEvent(trace, { stage, label, durationMs: Date.now() - start, warnings: [String(error)] });
          throw error;
        }
      );
      return traced as T;
    }
    // Sync result
    traceEvent(trace, { stage, label, durationMs: Date.now() - start });
    return result;
  } catch (error) {
    traceEvent(trace, { stage, label, durationMs: Date.now() - start, warnings: [String(error)] });
    throw error;
  }
}

export function summarizeForTrace(value: unknown, maxChars = 2000): unknown {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') <= maxChars) return value;
  if (typeof value === 'string') return value.slice(0, maxChars);
  return { truncated: true, preview: text.slice(0, maxChars) };
}

export function redactTraceValue(value: unknown): unknown {
  return redact(value);
}