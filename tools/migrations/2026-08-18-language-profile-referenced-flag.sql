-- Precomputes "is this language profile referenced by language memory?"
--
-- listLanguageProfiles({ surfaceNgrams, referencedByLanguageMemory: true })
-- runs on the critical path of every turn: it is the whole of the
-- runtime.seed.surface_cluster stage, measured at ~2.5s of a 6.6s turn.
--
-- EXPLAIN ANALYZE on the live corpus (22463 profiles):
--
--   Seq Scan on language_profiles  (actual time=1.445..793.610 rows=1053)
--     Filter: (ngram_keys && '{...}' AND ((SubPlan 2) OR (SubPlan 3) OR ...))
--     Rows Removed by Filter: 21410
--     SubPlan 2 -> Index Only Scan ... (loops=22390)
--     SubPlan 3 -> Index Only Scan ... (loops=21337)
--
-- The trigram prefilter cannot reduce that: `ngram_keys && $1` matches 22390
-- of 22463 rows -- 99.7% -- because common trigrams ("the", "ing", "ati")
-- appear in nearly every profile. So four correlated EXISTS subqueries run
-- per row over the whole table, every turn, for a predicate whose answer
-- does not depend on the question being asked at all.
--
-- Hoisting them into a MATERIALIZED union was measured and REJECTED: it ran
-- 16148ms against the original 794ms, because the union materialises the
-- referenced set across four tables while the correlated EXISTS short-
-- circuits at the first match in 0.006ms. The cost is the 22390 repetitions,
-- not the probe -- so the fix is to stop repeating it, not to restructure it.
--
-- Idempotent: safe to run repeatedly, and safe to run before or after the
-- application starts reading the column.

BEGIN;

ALTER TABLE scce3_runtime.language_profiles
  ADD COLUMN IF NOT EXISTS referenced_by_language_memory BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index: the query only ever asks for referenced profiles, so only
-- those rows need to be indexed.
CREATE INDEX IF NOT EXISTS idx_scce3_runtime_language_profiles_referenced
  ON scce3_runtime.language_profiles (id)
  WHERE referenced_by_language_memory;

-- One-time backfill. Written as four anti-correlated updates rather than a
-- single OR so each can use its own index.
UPDATE scce3_runtime.language_profiles lp SET referenced_by_language_memory = TRUE
 WHERE NOT lp.referenced_by_language_memory
   AND (EXISTS (SELECT 1 FROM scce3_runtime.language_units u WHERE u.profile_id = lp.id)
     OR EXISTS (SELECT 1 FROM scce3_runtime.language_patterns p WHERE p.profile_id = lp.id)
     OR EXISTS (SELECT 1 FROM scce3_runtime.ngram_models m WHERE m.model_json->>'profileId' = lp.id)
     OR EXISTS (SELECT 1 FROM scce3_runtime.semantic_frames f WHERE f.frame_json->>'profileId' = lp.id));

-- Maintenance. A precomputed flag that is not maintained is worse than no
-- flag at all, because it fails silently and selectively: a profile trained
-- after the migration would simply stop being retrievable. The trigger sets
-- the flag on insert into any referencing table.
--
-- It only ever sets TRUE, never clears. Clearing correctly would require
-- checking the other three tables on every delete, and language memory rows
-- are not deleted in normal operation; a stale TRUE costs one wasted
-- candidate, while a wrong FALSE loses a profile from retrieval entirely.
-- plpgsql resolves every field reference in an expression against the row type it is handed, whichever CASE
-- branch would be taken, so naming model_json and frame_json here made the trigger fail on every insert into
-- language_units and language_patterns ("record \"new\" has no field \"model_json\""). That silently ended all
-- language-memory writes the day this shipped. Reading the row as JSON is table-shape independent.
CREATE OR REPLACE FUNCTION scce3_runtime.mark_language_profile_referenced()
RETURNS TRIGGER AS $$
DECLARE
  row_json JSONB;
  target TEXT;
BEGIN
  row_json := to_jsonb(NEW);
  target := COALESCE(
    row_json->>'profile_id',
    row_json->'model_json'->>'profileId',
    row_json->'frame_json'->>'profileId'
  );
  IF target IS NOT NULL THEN
    UPDATE scce3_runtime.language_profiles
       SET referenced_by_language_memory = TRUE
     WHERE id = target AND NOT referenced_by_language_memory;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_language_units_referenced ON scce3_runtime.language_units;
CREATE TRIGGER trg_language_units_referenced
  AFTER INSERT OR UPDATE ON scce3_runtime.language_units
  FOR EACH ROW EXECUTE FUNCTION scce3_runtime.mark_language_profile_referenced();

DROP TRIGGER IF EXISTS trg_language_patterns_referenced ON scce3_runtime.language_patterns;
CREATE TRIGGER trg_language_patterns_referenced
  AFTER INSERT OR UPDATE ON scce3_runtime.language_patterns
  FOR EACH ROW EXECUTE FUNCTION scce3_runtime.mark_language_profile_referenced();

DROP TRIGGER IF EXISTS trg_ngram_models_referenced ON scce3_runtime.ngram_models;
CREATE TRIGGER trg_ngram_models_referenced
  AFTER INSERT OR UPDATE ON scce3_runtime.ngram_models
  FOR EACH ROW EXECUTE FUNCTION scce3_runtime.mark_language_profile_referenced();

DROP TRIGGER IF EXISTS trg_semantic_frames_referenced ON scce3_runtime.semantic_frames;
CREATE TRIGGER trg_semantic_frames_referenced
  AFTER INSERT OR UPDATE ON scce3_runtime.semantic_frames
  FOR EACH ROW EXECUTE FUNCTION scce3_runtime.mark_language_profile_referenced();

COMMIT;

ANALYZE scce3_runtime.language_profiles;
