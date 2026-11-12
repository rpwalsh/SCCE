// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createClock, createHasher, createIdFactory, createEventFactory, type InformationLabel } from "@scce/kernel";
import { PostgresStorageAdapter } from "../postgres.js";

const label: InformationLabel = { tenantId: "tenant", principals: ["owner"], compartments: [], exportClass: "restricted", mergePolicy: "isolated" };
const cold = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

it("reads construction evidence on the event append client with a one-client pool", async () => {
  const adapter = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema: "decision_client", informationAccess: {
    tenantId: "tenant", principalId: "owner", compartments: [], maximumExportClass: "restricted" } });
  adapter.pool.options.max = 1;
  const pages = new Map<string, Record<string, unknown>>(), events: Record<string, unknown>[] = [];
  const evidenceText = "abcd ".repeat(40), evidenceBytes = Buffer.from(evidenceText, "utf8");
  const evidenceHash = `sha256_${createHash("sha256").update(evidenceBytes).digest("hex")}`;
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  let active = false, escapedQueries = 0;
  const client = {
    async query(sql: string, params: readonly unknown[] = []): Promise<{ rows: unknown[] }> {
      calls.push({ sql, params });
      if (sql === "BEGIN") { expect(active).toBe(false); active = true; }
      if (sql === "COMMIT" || sql === "ROLLBACK") active = false;
      if (sql.includes('"evidence_spans"')) {
        expect(active).toBe(true);
        expect(params[0]).toEqual(["evidence"]);
        expect(sql).toContain("evidence.information_label");
        expect(params).toContain("tenant");
        return { rows: [{ id: "evidence", source_id: "source", source_version_id: "version", chunk_id: "chunk", content_hash: evidenceHash,
          media_type: "text/plain", byte_start: 0, byte_end: evidenceBytes.byteLength, char_start: 0, char_end: [...evidenceText].length,
          text_preview: "abcd", language_hints: {}, script_hints: {}, trust_vector: {},
          provenance_json: {}, features: [], status: "promoted", alpha: 1, observed_at: new Date(1), information_label: label }] };
      }
      if (sql.includes('"source_versions" sv')) return { rows: [{ id: "version", source_id: "source", content_hash: evidenceHash, byte_length: String(evidenceBytes.byteLength) }] };
      if (sql.includes('"blobs" blob')) return { rows: params[0] === evidenceHash ? [{ content: evidenceBytes, byte_length: String(evidenceBytes.byteLength),
        range_parent_hash: null, range_start: null, range_end: null, archive_reference: null, archive: null }] : [] };
      if (sql.includes('"construction_source_decision_pages"')) {
        if (sql.startsWith("INSERT")) {
          expect(active).toBe(true);
          for (const row of JSON.parse(String(params[0])) as Record<string, unknown>[]) pages.set(String(row.id), cold(row));
          return { rows: [] };
        }
        if (sql.includes("JOIN jsonb_to_recordset")) return { rows: [...pages.keys()].map(id => ({ id })) };
        const ids = params[0] as string[], owner = params[1];
        const selected = [...pages.values()].filter(row => ids.includes(String(row.id)) && row.owner_key === owner);
        return { rows: selected.map(row => sql.includes("octet_length")
          ? { id: row.id, owner_key: row.owner_key, kind: row.kind, json_bytes: String(Buffer.byteLength(JSON.stringify(row.value_json))) }
          : cold(row)) };
      }
      if (sql.includes("INSERT INTO") && sql.includes("(id, episode_id")) {
        const [id, episode_id, type_id, t, payload, parents, hash, ledger_hash] = params;
        events.push({ id, episode_id, type_id, t, payload_json: JSON.parse(String(payload)), parents, hash, ledger_hash });
      }
      if (sql.startsWith("SELECT *") && sql.includes('"events"')) return { rows: cold(events) };
      return { rows: [] };
    },
    release() { expect(active).toBe(false); }
  };
  (adapter.pool as unknown as { connect: () => Promise<unknown> }).connect = async () => {
    expect(active).toBe(false); return client;
  };
  (adapter.pool as unknown as { query: typeof client.query }).query = async (sql, params) => {
    // A real max=1 pool would wait here forever while append holds its only client.
    if (active) { escapedQueries++; throw Error("pool queried while its only client is checked out"); }
    return client.query(sql, params);
  };
  const patterns = Array.from({ length: 24 }, (_, index) => {
    const digest = `digest.${index}`;
    return { informationLabel: label, schema: "scce.language_construction_pattern.v1", storageEncoding: "scce.language_construction.source_examples.v1",
      sourceCompilationId: "compilation", contentDigest: digest,
      bundle: { schema: "scce.language_construction_pattern.v1", id: `surface.construction.bundle.${digest}`, contentDigest: digest,
        bindingId: `language.source_relation.${index}`, sourceProfileId: "profile", targetProfileId: "profile", sourceVersionIds: ["version"],
        evidenceIds: ["evidence"], evidenceContentHashes: [evidenceHash], acquisitionStatus: "source_observed",
        sourceExamples: [0, 5, 10].map(start => ({ evidenceIndex: 0, surfaceStartCodePoint: start, surfaceEndCodePoint: start + 4,
          roles: [{ slotIndex: 0, occurrenceIndex: 0, startCodePoint: 0, endCodePoint: 2 },
            { slotIndex: 1, occurrenceIndex: 0, startCodePoint: 2, endCodePoint: 4 }], nullRoles: [] })) } };
  });
  const clock = createClock({ fixedTime: 1 }), hasher = createHasher();
  const ids = createIdFactory({ clock, hasher, namespace: "decision-client", deterministicReplay: true });
  const event = createEventFactory({ clock, hasher, idFactory: ids }).create({
    episodeId: ids.episodeId(), typeId: "review", payload: { projections: patterns }
  });
  try {
    await adapter.events.appendBatch([event]);
    expect(pages.size).toBeGreaterThan(0);
    expect(calls.filter(call => call.sql.includes('"evidence_spans"'))).toHaveLength(1);
    expect(calls.some(call => call.sql === "COMMIT")).toBe(true);
    expect(escapedQueries).toBe(0);
    expect(await adapter.events.readEpisode(event.episodeId)).toEqual([event]);
  } finally { await adapter.close(); }
});
