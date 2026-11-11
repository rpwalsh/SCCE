// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from "node:assert/strict";
import test from "node:test";
import { forEachNgramModelPage } from "./ngram-model-reader.mjs";

test("replay-aware tool scans advance an id cursor under a fixed decoded-byte page budget", async () => {
  const rows = ["model.a", "model.b", "model.c"].map(id => ({ id, modelJson: { model: { id } } }));
  const queries = [], seen = [];
  const count = await forEachNgramModelPage({
    languageMemory: { async listNgramModels(query) {
      queries.push(query);
      return rows.filter(row => row.id > query.afterId).slice(0, 2);
    } },
    materialize: record => record.modelJson.model,
    query: { profileIds: ["profile.fixture"] },
    limit: 2,
    maxTotalJsonBytes: 1024,
    visit: (record, model) => seen.push([record.id, model.id])
  });
  assert.equal(count, 3);
  assert.deepEqual(seen, [["model.a", "model.a"], ["model.b", "model.b"], ["model.c", "model.c"]]);
  assert.deepEqual(queries.map(query => [query.afterId, query.limit, query.maxTotalJsonBytes]),
    [["", 2, 1024], ["model.b", 2, 1024], ["model.c", 2, 1024]]);
});

test("replay-aware tool scans fail closed when a backend ignores the cursor", async () => {
  await assert.rejects(forEachNgramModelPage({
    languageMemory: { async listNgramModels() { return [{ id: "model.a", modelJson: { model: {} } }]; } },
    materialize: () => ({}), query: {}, visit() {}
  }), /cursor did not advance/u);
});
