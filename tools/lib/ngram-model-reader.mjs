// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Open the public, replay-aware n-gram boundary for read-only diagnostics.
 * Direct model_json SQL is intentionally forbidden here: replay-backed rows
 * do not persist expanded sufficient-statistics maps.
 */
export async function openNgramModelReader(options = {}) {
  const root = path.resolve(options.root ?? path.join(import.meta.dirname, "..", ".."));
  const adapterApi = await import(pathToFileURL(path.join(root, "packages", "adapters-node", "dist", "index.js")).href);
  const kernel = await import(pathToFileURL(path.join(root, "packages", "kernel", "dist", "index.js")).href);
  const config = await adapterApi.readScceRuntimeConfig(options.configPath ?? path.join(root, "scce.config.json"));
  const storage = adapterApi.createPostgresStorageAdapter({
    ...config.database,
    informationAccess: config.security.informationAccess
  });
  const materialize = record => {
    const rootJson = record?.modelJson && typeof record.modelJson === "object" && !Array.isArray(record.modelJson)
      ? record.modelJson : undefined;
    return kernel.materializeKneserNey(rootJson?.model);
  };
  return {
    storage,
    materialize,
    forEach: (query, visit, paging = {}) => forEachNgramModelPage({
      languageMemory: storage.languageMemory, materialize, query, visit, ...paging
    }),
    close: () => storage.close()
  };
}

/** Pure paging loop, exported for deterministic smoke tests. */
export async function forEachNgramModelPage(input) {
  const limit = Math.max(1, Math.min(64, Math.floor(input.limit ?? 16)));
  const maxTotalJsonBytes = Math.max(1, Math.floor(input.maxTotalJsonBytes ?? 64 * 1024 * 1024));
  let afterId = "", count = 0;
  while (true) {
    const page = await input.languageMemory.listNgramModels({ ...input.query, afterId, limit, maxTotalJsonBytes });
    if (!page.length) return count;
    for (const record of page) {
      if (record.id <= afterId) throw new Error("n-gram model cursor did not advance");
      const model = input.materialize(record);
      if (!model) throw new Error(`invalid hydrated n-gram model ${record.id}`);
      await input.visit(record, model);
      count++;
    }
    afterId = page[page.length - 1].id;
  }
}
