import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_DIR = '.scce/traces';

export async function handleTraceList(args: { limit?: number }): Promise<string> {
  const limit = args.limit ?? 20;
  const dir = process.env.SCCE_TRACE_DIR ?? DEFAULT_DIR;
  try {
    if (!existsSync(dir)) return JSON.stringify({ dir, files: [] });
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .reverse()
      .slice(0, limit)
      .map((f) => {
        const full = join(dir, f);
        try {
          const st = statSync(full);
          return { id: f.replace(/\.jsonl$/, ''), file: f, path: full, mtime: st.mtime.toISOString(), size: st.size };
        } catch {
          return { id: f.replace(/\.jsonl$/, ''), file: f, path: full };
        }
      });
    return JSON.stringify({ dir, files });
  } catch {
    return JSON.stringify({ error: 'trace list failed' });
  }
}

export async function handleTraceRead(args: { traceId?: string; file?: string; stage?: string; maxEvents?: number }): Promise<string> {
  const maxEvents = args.maxEvents ?? 100;
  const dir = process.env.SCCE_TRACE_DIR ?? DEFAULT_DIR;
  const fileName = args.file ?? findFile(dir, args.traceId);
  if (!fileName || !existsSync(join(dir, fileName))) return JSON.stringify({ error: 'trace not found' });
  const text = readFileSync(join(dir, fileName), 'utf8');
  const malformed: string[] = [];
  const events: unknown[] = [];
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (args.stage && parsed.stage !== args.stage) continue;
      events.push(parsed);
    } catch {
      malformed.push(line);
    }
    if (events.length >= maxEvents) break;
  }
  const out: Record<string, unknown> = { dir, file: fileName, events, malformedCount: malformed.length };
  if (malformed.length) out.malformed = malformed.slice(0, 20);
  return JSON.stringify(out);
}

export async function handleAnswerTrace(args: { traceId?: string; file?: string }): Promise<string> {
  const dir = process.env.SCCE_TRACE_DIR ?? DEFAULT_DIR;
  const fileName = args.file ?? findFile(dir, args.traceId);
  if (!fileName || !existsSync(join(dir, fileName))) return JSON.stringify({ error: 'trace not found' });
  const text = readFileSync(join(dir, fileName), 'utf8');
  const events: Array<Record<string, unknown>> = [];
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      events.push(parsed);
    } catch {}
  }
  const stages = [...new Set(events.map((e) => e.stage as string).filter(Boolean))];
  const expectedStages = [
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
    'turn.error',
  ];
  const missing = expectedStages.filter((s) => !stages.includes(s));
  const out: Record<string, unknown> = {
    dir,
    file: fileName,
    eventCount: events.length,
    stages,
    missingExpectedStages: missing.length > 0 ? missing : undefined,
  };
  return JSON.stringify(out);
}

function findFile(dir: string, id?: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().reverse();
  if (id) return files.find((f) => f.includes(id));
  return files[0];
}
