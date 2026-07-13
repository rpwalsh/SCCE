import path from "node:path";
import type { Scce2BrainShardIndexOptions } from "@scce/adapters-node";
import type { BrainShardImportOptions } from "@scce/kernel";

export interface Scce2CliImportOptions extends BrainShardImportOptions {
  statusPath?: string;
}

export interface Scce2CliInspectOptions extends Scce2BrainShardIndexOptions {
  summaryOnly?: boolean;
}

export function parseScce2ImportOptions(args: string[]): Scce2CliImportOptions {
  const out: Scce2CliImportOptions = {};
  for (const arg of args) {
    const [flag, raw] = arg.split("=", 2);
    const num = raw === undefined ? NaN : Number(raw);
    if (flag === "--graph-shard-limit" && Number.isFinite(num)) out.graphShardLimit = num;
    else if (flag === "--language-shard-limit" && Number.isFinite(num)) out.languageShardLimit = num;
    else if (flag === "--ngram-state-limit" && Number.isFinite(num)) out.ngramStateLimit = num;
    else if (flag === "--ngram-observation-limit" && Number.isFinite(num)) out.ngramObservationLimit = num;
    else if (flag === "--graph-relation-limit" && Number.isFinite(num)) out.graphRelationLimit = num;
    else if (flag === "--graph-concept-limit" && Number.isFinite(num)) out.graphConceptLimit = num;
    else if (flag === "--max-state-mb" && Number.isFinite(num)) out.maxStateBytes = megabytes(Math.max(1, num));
    else if (flag === "--v8-decode-work-extent-mb" && Number.isFinite(num)) out.v8DecodeWorkExtentBytes = megabytes(Math.max(1, num));
    else if (flag === "--hash-work-extent-mb" && Number.isFinite(num)) out.hashWorkExtentBytes = megabytes(Math.max(0, num));
    else if (flag === "--max-hash-file-mb" && Number.isFinite(num)) out.maxHashBytesPerFile = megabytes(Math.max(0, num));
    else if (flag === "--heap-checkpoint-mb" && Number.isFinite(num)) out.heapCheckpointMb = Math.max(128, num);
    else if (flag === "--status" && raw) out.statusPath = path.resolve(raw);
    else if (flag === "--stop-file" && raw) out.stopFile = path.resolve(raw);
    else if (arg === "--no-direct-evidence") out.importDirectEvidence = false;
    else if (arg === "--no-hashes") out.hashWorkExtentBytes = 0;
    else if (arg === "--summary-only") {
      out.graphConceptLimit = 0;
      out.graphRelationLimit = 0;
      out.ngramObservationLimit = 0;
      out.importDirectEvidence = false;
    } else throw new Error(`unknown scce2 option: ${arg}`);
  }
  return out;
}

export function parseScce2InspectOptions(args: string[]): Scce2CliInspectOptions {
  const out: Scce2CliInspectOptions = {};
  for (const arg of args) {
    const [flag, raw] = arg.split("=", 2);
    const num = raw === undefined ? NaN : Number(raw);
    if (flag === "--hash-work-extent-mb" && Number.isFinite(num)) out.hashWorkExtentBytes = megabytes(Math.max(0, num));
    else if (flag === "--max-hash-file-mb" && Number.isFinite(num)) out.maxHashBytesPerFile = megabytes(Math.max(0, num));
    else if (flag === "--max-depth" && Number.isFinite(num)) out.maxDepth = Math.max(1, num);
    else if (flag === "--max-files" && Number.isFinite(num)) out.maxFiles = Math.max(1, num);
    else if (arg === "--no-hashes") out.hashWorkExtentBytes = 0;
    else if (arg === "--summary-only") out.summaryOnly = true;
    else throw new Error(`unknown scce2 inspect option: ${arg}`);
  }
  return out;
}

function megabytes(value: number): number {
  return value * 1024 * 1024;
}
