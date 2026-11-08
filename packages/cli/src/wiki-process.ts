// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import path from "node:path";

export function wikiChildArgs(input: {
  cliPath: string;
  configPath: string;
  schema: string;
  childHeapMb: number;
  target: string;
  flags: string[];
}): string[] {
  return [
    `--max-old-space-size=${input.childHeapMb}`, input.cliPath,
    "--config", path.resolve(input.configPath), "--schema", input.schema,
    "ingest", "wiki", input.target, ...input.flags
  ];
}

export function wikiRunPaths(tempRoot: string, schema: string, overrides: {
  statusPath?: string; lockPath?: string; stopFile?: string;
} = {}): { root: string; statusPath: string; lockPath: string; stopFile: string } {
  const root = path.resolve(tempRoot, "wiki-firehose", schema);
  return {
    root,
    statusPath: overrides.statusPath ?? path.join(root, "status.json"),
    lockPath: overrides.lockPath ?? path.join(root, "lock.json"),
    stopFile: overrides.stopFile ?? path.join(root, "stop.json")
  };
}

export function wikiContinueAfterConfiguredPageCap(status: {
  stopReason?: string; lastCheckpointOffset: number; resumedFromOffset: number;
}, options: { maxPages?: number; maxBlocks?: number }): boolean {
  if (status.stopReason !== "maxPagesPerRun" || options.maxPages !== undefined || (options.maxBlocks ?? 0) > 0) return false;
  if (status.lastCheckpointOffset <= status.resumedFromOffset) {
    throw new Error("Wikipedia page cap made no durable block progress; increase maxPagesPerRun before resuming");
  }
  return true;
}

export async function withWikiIngestCancellation<T>(run: (signal: AbortSignal) => Promise<T>, events: { once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown; off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown } = process): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException("Wikipedia ingestion interrupted by owner", "AbortError"));
  events.once("SIGINT", abort);
  events.once("SIGTERM", abort);
  try { return await run(controller.signal); }
  finally { events.off("SIGINT", abort); events.off("SIGTERM", abort); }
}
