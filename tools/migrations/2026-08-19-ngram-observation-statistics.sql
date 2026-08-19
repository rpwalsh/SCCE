-- Expression statistics for ngram_observations' JSON-path predicates.
--
-- Without these, the planner has no distribution for
-- metadata_json->>'sourceSystem' (68% of 13.5M rows are 'gutenberg') and
-- estimated 1 surviving row for the hydration query, choosing a parallel
-- seq scan over the 30GB table -- caught live at 375s of a single creative
-- turn (see commit 22322e9). Statistics alone do NOT fix that plan (the
-- information-access jsonb containment operators have constant default
-- selectivities), which is why listNgramObservations also uses an
-- index-first prefetch -- but accurate expression stats keep every OTHER
-- query against these paths honestly costed, and the estimate error they
-- fix (1 vs 9,164,041) is not one to leave in place.
--
-- Idempotent; already applied to the live database on 2026-08-19.

CREATE STATISTICS IF NOT EXISTS scce3_runtime.stx_ngram_obs_source_system
  ON (metadata_json->>'sourceSystem') FROM scce3_runtime.ngram_observations;
CREATE STATISTICS IF NOT EXISTS scce3_runtime.stx_ngram_obs_export_class
  ON (information_label->>'exportClass') FROM scce3_runtime.ngram_observations;
CREATE STATISTICS IF NOT EXISTS scce3_runtime.stx_ngram_obs_profile
  ON (metadata_json->>'profileId') FROM scce3_runtime.ngram_observations;

ANALYZE scce3_runtime.ngram_observations;
