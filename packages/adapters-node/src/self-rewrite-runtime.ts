// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import path from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import {
  createClock,
  createEventFactory,
  createHasher,
  createIdFactory,
  createSelfRewriteEngine,
  type EpisodeId,
  type ScceStorage,
  type SelfRewriteFile,
  type SelfRewriteGoal,
  type SelfRewriteProposal
} from "@scce/kernel";

export interface SelfRewriteProposalReport {
  episodeId: string;
  rewriteEpisodeId: string;
  target: string;
  fileCount: number;
  patchCount: number;
  status: SelfRewriteProposal["episode"]["status"];
  audit: SelfRewriteProposal["audit"];
}

const DEFAULT_EXCLUDED = ["node_modules", "dist", ".git", ".tmp", "coverage"];
const SOURCE_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".json", ".md", ".sql"]);

/**
 * The self-rewrite engine reads the running system's own source and proposes program changes. Proposals are persisted
 * as `proposed` and nothing is applied: approval, patch transaction and validation remain the operator's separate,
 * already-governed steps. This is the missing caller, not a new capability.
 */
export async function proposeSelfRewrite(input: {
  storage: ScceStorage;
  rootPath: string;
  goal: SelfRewriteGoal;
  maxFiles?: number;
  maxFileBytes?: number;
  excluded?: readonly string[];
}): Promise<SelfRewriteProposalReport> {
  const hasher = createHasher();
  const clock = createClock();
  const idFactory = createIdFactory({ clock, hasher, namespace: "self-rewrite" });
  const events = createEventFactory({ idFactory, clock, hasher });
  const maxFiles = Math.max(1, Math.min(4096, Math.floor(input.maxFiles ?? 512)));
  const maxFileBytes = Math.max(1024, Math.min(4_000_000, Math.floor(input.maxFileBytes ?? 256_000)));
  const excluded = new Set([...(input.excluded ?? DEFAULT_EXCLUDED)]);
  const root = path.resolve(input.rootPath);
  const files: SelfRewriteFile[] = [];
  const preferred = new Set((input.goal.preferredFiles ?? []).map(value => value.replace(/\\/g, "/")));

  const walk = async (directory: string): Promise<void> => {
    if (files.length >= maxFiles) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (files.length >= maxFiles) return;
      if (excluded.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
      const stats = await stat(absolute).catch(() => undefined);
      if (!stats || stats.size > maxFileBytes) continue;
      const relative = path.relative(root, absolute).replace(/\\/g, "/");
      if (preferred.size && !preferred.has(relative)) continue;
      files.push({ path: relative, content: await readFile(absolute, "utf8"), mediaType: "text/plain" });
    }
  };
  await walk(root);
  if (!files.length) throw new Error(`self-rewrite found no readable source under ${root}`);

  const episodeId = idFactory.episodeId();
  const proposal = createSelfRewriteEngine({ idFactory, hasher }).propose({
    episodeId: episodeId as EpisodeId,
    goal: input.goal,
    files,
    createdAt: clock.now()
  });
  await input.storage.selfRewrite.putEpisode(proposal.episode);
  for (const patch of proposal.patches) await input.storage.selfRewrite.putPatch(patch);
  await input.storage.events.append(events.create({
    episodeId,
    typeId: "CandidateGenerated",
    payload: {
      kind: "self-rewrite-proposal",
      rewriteEpisodeId: proposal.episode.id,
      target: proposal.episode.target,
      fileCount: files.length,
      patchCount: proposal.patches.length,
      applied: false
    }
  }));
  return {
    episodeId: String(episodeId),
    rewriteEpisodeId: proposal.episode.id,
    target: proposal.episode.target,
    fileCount: files.length,
    patchCount: proposal.patches.length,
    status: proposal.episode.status,
    audit: proposal.audit
  };
}
