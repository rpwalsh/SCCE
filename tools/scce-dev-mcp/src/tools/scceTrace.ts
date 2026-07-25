import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename } from 'node:path';
import { resolveTraceDir, resolveTraceFile, TraceContainmentError } from '../lib/tracePath.js';

const MAX_LINES_SCANNED = 200_000;
const MAX_BYTES_SCANNED = 64 * 1024 * 1024;

export async function handleTraceList(args: { limit?: number }): Promise<string> {
  const limit = args.limit ?? 20;
  const dir = resolveTraceDir();
  try {
    if (!existsSync(dir)) return JSON.stringify({ dir, files: [] });
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .reverse()
      .slice(0, limit)
      .map((f) => {
        const full = `${dir}/${f}`;
        try {
          const st = statSync(full);
          return { id: f.replace(/\.jsonl$/, ''), file: f, mtime: st.mtime.toISOString(), size: st.size };
        } catch {
          return { id: f.replace(/\.jsonl$/, ''), file: f };
        }
      });
    return JSON.stringify({ dir, files });
  } catch (error) {
    return JSON.stringify({ error: 'trace list failed', message: error instanceof Error ? error.message : String(error) });
  }
}

interface StreamResult {
  events: unknown[];
  malformed: string[];
  linesScanned: number;
  bytesScanned: number;
  truncated: boolean;
}

async function streamJsonlEvents(path: string, opts: { maxEvents: number; stage?: string }): Promise<StreamResult> {
  const events: unknown[] = [];
  const malformed: string[] = [];
  let linesScanned = 0;
  let bytesScanned = 0;
  let truncated = false;

  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      bytesScanned += Buffer.byteLength(line, 'utf8') + 1;
      linesScanned += 1;
      if (line.length > 0) {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (!opts.stage || parsed.stage === opts.stage) events.push(parsed);
        } catch {
          if (malformed.length < 20) malformed.push(line.slice(0, 300));
        }
      }
      if (events.length >= opts.maxEvents || linesScanned >= MAX_LINES_SCANNED || bytesScanned >= MAX_BYTES_SCANNED) {
        truncated = events.length >= opts.maxEvents && linesScanned < MAX_LINES_SCANNED;
        break;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { events, malformed, linesScanned, bytesScanned, truncated };
}

export async function handleTraceRead(args: { traceId?: string; file?: string; stage?: string; maxEvents?: number }): Promise<string> {
  const maxEvents = args.maxEvents ?? 100;
  const dir = resolveTraceDir();
  try {
    const fileName = args.file ?? findFile(dir, args.traceId);
    if (!fileName) return JSON.stringify({ error: 'trace not found' });
    const resolved = resolveTraceFile(fileName);
    const result = await streamJsonlEvents(resolved, { maxEvents, stage: args.stage });
    const out: Record<string, unknown> = {
      dir,
      file: basename(resolved),
      events: result.events,
      malformedCount: result.malformed.length,
      linesScanned: result.linesScanned,
      bytesScanned: result.bytesScanned,
      truncated: result.truncated
    };
    if (result.malformed.length) out.malformed = result.malformed;
    return JSON.stringify(out);
  } catch (error) {
    if (error instanceof TraceContainmentError) return JSON.stringify({ error: 'trace not found', message: error.message });
    return JSON.stringify({ error: 'trace read failed', message: error instanceof Error ? error.message : String(error) });
  }
}

const EXPECTED_STAGES = [
  'trace.open',
  'api.request',
  'api.response',
  'runtime.error',
  'cli.command.start',
  'cli.command.end',
  'turn.input',
  'turn.runtime.start',
  'turn.runtime.end',
  'runtime.start',
  'graph.resolve',
  'contradiction.check',
  'proof.attach',
  'candidate.score',
  'planner.select',
  'mouth.generate',
  'turn.output',
  'turn.error'
];

export async function handleAnswerTrace(args: { traceId?: string; file?: string }): Promise<string> {
  const dir = resolveTraceDir();
  try {
    const fileName = args.file ?? findFile(dir, args.traceId);
    if (!fileName) return JSON.stringify({ error: 'trace not found' });
    const resolved = resolveTraceFile(fileName);
    const result = await streamJsonlEvents(resolved, { maxEvents: MAX_LINES_SCANNED });
    const stages = [...new Set(result.events.map((e) => (e as Record<string, unknown>).stage as string).filter(Boolean))];
    const missing = EXPECTED_STAGES.filter((s) => !stages.includes(s));
    return JSON.stringify({
      dir,
      file: basename(resolved),
      eventCount: result.events.length,
      stages,
      missingExpectedStages: missing.length > 0 ? missing : undefined,
      truncated: result.truncated
    });
  } catch (error) {
    if (error instanceof TraceContainmentError) return JSON.stringify({ error: 'trace not found', message: error.message });
    return JSON.stringify({ error: 'trace read failed', message: error instanceof Error ? error.message : String(error) });
  }
}

function findFile(dir: string, id?: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().reverse();
  if (id) return files.find((f) => f.includes(id));
  return files[0];
}
