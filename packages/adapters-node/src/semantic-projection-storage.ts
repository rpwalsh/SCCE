// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { constructionSourceExampleStorageJson, createHasher, replaySemanticInductionProjection,
  type SemanticInductionProjection } from "@scce/kernel";

export const SEMANTIC_PROJECTION_STORAGE_KEY = "_scceSemanticProjectionStorage";
export const SEMANTIC_PROJECTION_STORAGE_SCHEMA = "scce.semantic_projection.storage.v1";
const TAPE_STORAGE_SCHEMA = "scce.semantic_projection.json.v1";
const fields = ["semanticFrames", "graphBoundConstructions", "lexicalClasses", "relationHypothesisModel"] as const;
const exact = constructionSourceExampleStorageJson;
const fail = (): never => { throw Error("invalid sufficient semantic projection storage"); };
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined;
const selected = (row: Record<string, unknown>) => Object.fromEntries(fields.map(key => Object.hasOwn(row, key) ? [key, row[key]] : fail()));

/** The exact subset read by the existing SQL request-seed projection. */
export function semanticEntityQueryProjection(graphs: unknown): unknown[] {
  if (!Array.isArray(graphs)) return fail();
  return graphs.flatMap(raw => {
    const row = record(raw); if (!row || !Array.isArray(row.slots)) return fail();
    const slots = row.slots.flatMap(rawSlot => {
      const slot = record(rawSlot); if (!slot) return fail();
      return slot.semanticRole === "entity" ? [{ semanticRole: "entity",
        observedFillers: slot.observedFillers ?? [], lexicalClassId: slot.lexicalClassId ?? null }] : [];
    });
    return slots.length ? [{ evidenceIds: row.evidenceIds ?? [], slots }] : [];
  });
}

/** Replace the quadratic derived caches with their ordered sufficient facts. */
export function encodeSemanticProjection(value: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(value, "semanticInductionProjection")) return value;
  if (Object.hasOwn(value, SEMANTIC_PROJECTION_STORAGE_KEY)) return fail();
  const projection = record(value.semanticInductionProjection);
  if (!projection || projection.schema !== "scce.semantic_induction_projection.v1") return fail();
  const material = selected(value);
  if (projection.expectedDerivedDigest !== createHasher().digestHex(exact(material))) return fail();
  const { semanticFrames: _frames, relationHypothesisModel: _relations, graphBoundConstructions: graphs, ...root } = value;
  const text = JSON.stringify(projection);
  // The tape is opaque to SQL. A JSON string preserves NUL and lone UTF-16
  // units through JSONB without changing the learned source or its checksum.
  return { ...root, semanticInductionProjection: { schema: TAPE_STORAGE_SCHEMA, text, digest: createHasher().digestHex(text) },
    graphBoundConstructions: semanticEntityQueryProjection(graphs),
    [SEMANTIC_PROJECTION_STORAGE_KEY]: { schema: SEMANTIC_PROJECTION_STORAGE_SCHEMA } };
}

/** No inference or language fitting: the original ordered reducer replays fixed measured posteriors. */
export function decodeSemanticProjection(value: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(value, SEMANTIC_PROJECTION_STORAGE_KEY)) return value;
  const marker = record(value[SEMANTIC_PROJECTION_STORAGE_KEY]);
  if (!marker || marker.schema !== SEMANTIC_PROJECTION_STORAGE_SCHEMA || Object.keys(marker).length !== 1
    || Object.hasOwn(value, "semanticFrames") || Object.hasOwn(value, "relationHypothesisModel")) return fail();
  const tape = record(value.semanticInductionProjection);
  if (!tape || Object.keys(tape).sort().join(",") !== "digest,schema,text" || tape.schema !== TAPE_STORAGE_SCHEMA
    || typeof tape.text !== "string" || tape.text.length > 64 * 1024 * 1024 || typeof tape.digest !== "string"
    || createHasher().digestHex(tape.text) !== tape.digest) return fail();
  let projection: SemanticInductionProjection;
  try { projection = JSON.parse(tape.text) as SemanticInductionProjection; } catch { return fail(); }
  const restored = replaySemanticInductionProjection({ projection, hasher: createHasher() });
  if (exact(value.graphBoundConstructions) !== exact(semanticEntityQueryProjection(restored.graphBoundConstructions))
    || exact(value.lexicalClasses) !== exact(restored.lexicalClasses)) return fail();
  const { [SEMANTIC_PROJECTION_STORAGE_KEY]: _marker, ...root } = value;
  return { ...root, ...restored, semanticInductionProjection: projection };
}
