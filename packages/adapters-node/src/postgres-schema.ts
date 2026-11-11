// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { SOURCE_COMPUTATION_CONSTRUCTION_SCHEMA, CONTEXTUAL_QA_CONSTRUCTION_RECIPE, CONTEXTUAL_QA_SOURCE_SYSTEM,
  LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA, type InformationAccessContext } from "@scce/kernel";
import { evidenceTextDigestSchemaStatements } from "./evidence-text-digest.js";
import { LANGUAGE_PATTERN_SELECTION_HEADERS, languagePatternSelectionHeaderStatement } from "./postgres-language-pattern-headers.js";
import { canonicalCreativeEventSchemaStatements } from "./canonical-creative-event-store.js";
import { constructionSourceDecisionSchemaStatements } from "./construction-source-decision-store.js";

export type InformationLabeledTable =
  | "source_versions"
  | "evidence_spans"
  | "graph_nodes"
  | "graph_edges"
  | "graph_hyperedges"
  | "language_profiles"
  | "ngram_observations"
  | "ngram_models"
  | "language_units"
  | "language_patterns"
  | "semantic_frames"
  | "translation_alignments";

/**
 * Bulk corpus builds pay index maintenance per row on the largest table in the schema. Measured on 248,778
 * real observations: 20,512ms with the production indexes, 13,241ms with the primary key alone, 7,503ms with
 * none -- index maintenance is 63% of the insert, while rebuilding every one of those indexes afterwards from
 * sorted data costs 3.5s. Deferring is therefore a scheduling change and nothing else: the same rows, the same
 * counters, the same brain. It is only safe while nothing serves the schema, and `db verify` fails until
 * `db migrate` puts the indexes back, so a half-indexed brain cannot quietly be served.
 */
export const DEFERRED_INDEX_META_KEY = "deferred_bulk_load_indexes";

/**
 * Sort memory and workers for the restore transaction, not for the server: an index build is a sort, and at
 * the 64MB default it spills to disk often enough that deferring buys nothing. Sized for the 15.5GB machine
 * this runs on, and only ever held while a restore transaction is open -- Postgres may use this much per
 * parallel worker, so the product of the two is the real peak.
 */
export const DEFERRED_INDEX_RESTORE_SORT_MEMORY = "768MB";

export const DEFERRED_INDEX_RESTORE_PARALLEL_WORKERS = 2;

/** Tables whose secondary indexes exist to serve reads and can be rebuilt after a corpus build. */
export const BULK_LOAD_DEFERRABLE_TABLES = ["ngram_observations"] as const;

function informationLabelMigrationStatements(
  q: string,
  informationAccess?: InformationAccessContext
): string[] {
  const tables = [
    "source_versions",
    "evidence_spans",
    "graph_nodes",
    "graph_edges",
    "graph_hyperedges",
    "language_profiles",
    "ngram_observations",
    "ngram_models",
    "language_units",
    "language_patterns",
    "semantic_frames",
    "translation_alignments"
  ];
  const lockedLegacyLabel = JSON.stringify({
    tenantId: "migration.unassigned",
    principals: ["migration.explicit-backfill-required"],
    compartments: ["legacy.unlabeled"],
    exportClass: "restricted",
    mergePolicy: "isolated"
  }).replaceAll("'", "''");
  const publicCorpusLabel = JSON.stringify({
    tenantId: "scce.public.corpus",
    principals: [],
    compartments: [],
    exportClass: "public",
    mergePolicy: "same_owner"
  }).replaceAll("'", "''");
  const ownerCorrectionsLabel = informationAccess
    ? JSON.stringify({
      tenantId: informationAccess.tenantId.normalize("NFKC").trim(),
      principals: [informationAccess.principalId.normalize("NFKC").trim()],
      compartments: [...new Set(informationAccess.compartments.map(value => value.normalize("NFKC").trim()).filter(Boolean))].sort(),
      exportClass: "restricted",
      mergePolicy: "isolated"
    }).replaceAll("'", "''")
    : undefined;
  const publicSource = (sourceAlias: string, versionAlias: string) => `(
    (${sourceAlias}.namespace LIKE 'wikipedia-%'
      AND ${versionAlias}.metadata_json->>'sourceSystem' IN ('wikipedia','wikipedia-v3'))
    OR ((${sourceAlias}.namespace LIKE 'gutenberg%' OR ${sourceAlias}.namespace LIKE 'corpus:source_%')
      AND ${versionAlias}.metadata_json->>'sourceSystem' IN ('gutenberg','gutenberg-corpus'))
  )`;
  const ownerSource = (sourceAlias: string, versionAlias: string) => `(
    ${sourceAlias}.namespace IN ('corrections','local-corrections','scce-corrections','local-file')
    AND ${versionAlias}.metadata_json->>'sourceSystem' IN ('corrections','local-corrections')
  )`;
  const badEvidence = `bad_evidence AS MATERIALIZED (
    SELECT e.id,e.source_version_id
    FROM ${q}.evidence_spans e
    JOIN ${q}.source_versions sv ON sv.id=e.source_version_id
    JOIN ${q}.sources s ON s.id=sv.source_id
    WHERE e.status<>'promoted' OR NOT ${publicSource("s", "sv")}
  )`;
  const badSets = `bad_sets AS MATERIALIZED (
    SELECT
      COALESCE(ARRAY_AGG(id),'{}'::text[]) AS evidence_ids,
      COALESCE(ARRAY_AGG(DISTINCT source_version_id),'{}'::text[]) AS source_version_ids
    FROM bad_evidence
  )`;
  const migrationMarker = "information_label_migration_policy";
  const runOnce = (statement: string) => `DO $scce_information_labels$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM ${q}.storage_meta WHERE key='${migrationMarker}') THEN
        ${statement};
      END IF;
    END
  $scce_information_labels$`;
  const legacyStatements = [
    `WITH ${badEvidence}, ${badSets}
     DELETE FROM ${q}.translation_alignments a
     USING bad_sets b
     WHERE CARDINALITY(a.evidence_ids)=0 OR a.evidence_ids && b.evidence_ids`,
    `WITH ${badEvidence}, ${badSets}
     DELETE FROM ${q}.semantic_frames f
     USING bad_sets b
     WHERE CARDINALITY(f.evidence_ids)=0 OR f.evidence_ids && b.evidence_ids`,
    `WITH ${badEvidence}, ${badSets}
     DELETE FROM ${q}.language_patterns p
     USING bad_sets b
     WHERE p.evidence_ids && b.evidence_ids
        OR NOT EXISTS (SELECT 1 FROM ${q}.language_profiles lp WHERE lp.id=p.profile_id)
        OR EXISTS (
          SELECT 1 FROM ${q}.language_profiles lp
          WHERE lp.id=p.profile_id AND lp.source_version_id=ANY(b.source_version_ids)
        )`,
    `WITH ${badEvidence}, ${badSets}
     DELETE FROM ${q}.language_units u
     USING bad_sets b
     WHERE u.evidence_ids && b.evidence_ids
        OR u.source_version_id=ANY(b.source_version_ids)`,
    `WITH ${badEvidence}, ${badSets}
     DELETE FROM ${q}.ngram_models m
     USING bad_sets b
     WHERE NOT EXISTS (SELECT 1 FROM ${q}.ngram_observations o WHERE o.stream_id=m.stream_id)
        OR EXISTS (
          SELECT 1 FROM ${q}.ngram_observations o
          WHERE o.stream_id=m.stream_id
            AND (
              o.evidence_id=ANY(b.evidence_ids)
              OR o.source_version_id=ANY(b.source_version_ids)
              OR (o.evidence_id IS NULL AND o.source_version_id IS NULL)
            )
        )`,
    `WITH ${badEvidence}, ${badSets}
     DELETE FROM ${q}.ngram_observations o
     USING bad_sets b
     WHERE o.evidence_id=ANY(b.evidence_ids)
        OR o.source_version_id=ANY(b.source_version_ids)
        OR (o.evidence_id IS NULL AND o.source_version_id IS NULL)`,
    `WITH ${badEvidence}, ${badSets}
     DELETE FROM ${q}.language_profiles lp
     USING bad_sets b
     WHERE lp.source_version_id=ANY(b.source_version_ids)`,
    `WITH ${badEvidence}, ${badSets}, bad_nodes AS MATERIALIZED (
       SELECT n.id
       FROM ${q}.graph_nodes n
       CROSS JOIN bad_sets b
       WHERE n.evidence_ids && b.evidence_ids
          OR n.representation_json->>'sourceVersionId'=ANY(b.source_version_ids)
          OR (CARDINALITY(n.evidence_ids)=0 AND NOT (n.representation_json ? 'sourceVersionId'))
     )
     DELETE FROM ${q}.graph_hyperedges h
     USING bad_sets b
     WHERE h.provenance_refs && b.evidence_ids
        OR CARDINALITY(h.provenance_refs)=0
        OR h.member_node_ids && COALESCE((SELECT ARRAY_AGG(id) FROM bad_nodes),'{}'::text[])`,
    `WITH ${badEvidence}, ${badSets}, bad_nodes AS MATERIALIZED (
       SELECT n.id
       FROM ${q}.graph_nodes n
       CROSS JOIN bad_sets b
       WHERE n.evidence_ids && b.evidence_ids
          OR n.representation_json->>'sourceVersionId'=ANY(b.source_version_ids)
          OR (CARDINALITY(n.evidence_ids)=0 AND NOT (n.representation_json ? 'sourceVersionId'))
     )
     DELETE FROM ${q}.graph_edges g
     USING bad_sets b
     WHERE g.evidence_ids && b.evidence_ids
        OR g.source_node_id=ANY(COALESCE((SELECT ARRAY_AGG(id) FROM bad_nodes),'{}'::text[]))
        OR g.target_node_id=ANY(COALESCE((SELECT ARRAY_AGG(id) FROM bad_nodes),'{}'::text[]))`,
    `WITH ${badEvidence}, ${badSets}
     DELETE FROM ${q}.graph_nodes n
     USING bad_sets b
     WHERE n.evidence_ids && b.evidence_ids
        OR n.representation_json->>'sourceVersionId'=ANY(b.source_version_ids)
        OR (CARDINALITY(n.evidence_ids)=0 AND NOT (n.representation_json ? 'sourceVersionId'))`,
    ...(ownerCorrectionsLabel ? [
      `UPDATE ${q}.source_versions sv
       SET information_label='${ownerCorrectionsLabel}'::jsonb
       FROM ${q}.sources s
       WHERE s.id=sv.source_id AND ${ownerSource("s", "sv")}`
    ] : []),
    `UPDATE ${q}.source_versions sv
     SET information_label='${lockedLegacyLabel}'::jsonb
     FROM ${q}.sources s
     WHERE s.id=sv.source_id
       AND NOT ${publicSource("s", "sv")}
       AND NOT ${ownerSource("s", "sv")}`,
    `UPDATE ${q}.evidence_spans e
     SET information_label=sv.information_label
     FROM ${q}.source_versions sv
     WHERE sv.id=e.source_version_id
       AND sv.information_label<>'${publicCorpusLabel}'::jsonb`
  ];
  return [
    ...tables.map(table =>
      `ALTER TABLE ${q}.${table} ADD COLUMN IF NOT EXISTS information_label JSONB NOT NULL DEFAULT '${publicCorpusLabel}'::jsonb`
    ),
    ...legacyStatements.map(runOnce),
    ...tables.map(table => `ALTER TABLE ${q}.${table} ALTER COLUMN information_label DROP DEFAULT`),
    `INSERT INTO ${q}.storage_meta(key,value_json,updated_at)
     VALUES(
       '${migrationMarker}',
       '{"schema":"scce.information_label_migration.v3","legacyPolicy":"metadata_only_public_default_then_targeted_exceptions","publicCorpusRule":"matching wikipedia namespace+sourceSystem or gutenberg/gated-corpus namespace+sourceSystem","ownerCorrectionRule":"matching corrections namespace+sourceSystem with configured owner","derivativeRule":"only verified promoted public dependencies survive; unknown, mixed, dependency-free aggregate, and non-public legacy derivatives are removed","legacyTenant":"migration.unassigned","legacyPrincipal":"migration.explicit-backfill-required","quarantineInfluenceCleanup":"delete every derivative with any non-promoted or non-public dependency transactionally","newWriteDefault":"none"}'::jsonb,
       NOW()
     )
     ON CONFLICT(key) DO UPDATE SET value_json=EXCLUDED.value_json,updated_at=NOW()`
  ];
}

/**
 * listNgramModels ranks by `trainedMass DESC, updated_at DESC, id ASC` under
 * either a sourceSystem or a profileIds filter; these two indexes carry that
 * whole ordering so neither scoping has to sort the table.
 *
 * They are created ONLY on a schema this migration just created. Both index
 * expressions read inside `model_json`, which forces a detoast of every row
 * (ngram_models is 784kB of heap against 1680MB of TOAST on the live
 * schema), and `migrate()` runs its statements inside one transaction, so
 * CREATE INDEX CONCURRENTLY is not available to it. Building these against a
 * populated ngram_models would therefore hold a write lock on a running
 * server for as long as it takes to read 1.6GB. On an existing schema they
 * are an operator action, run CONCURRENTLY out of band.
 */
export function freshSchemaIndexStatements(q: string): string[] {
  return [
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_ngram_model_source_system_ranked ON ${q}.ngram_models((model_json->>'sourceSystem'), (COALESCE((model_json->'model'->>'totalUnigramCount')::numeric, 0)) DESC, updated_at DESC, id)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_ngram_model_profile_ranked ON ${q}.ngram_models((model_json->>'profileId'), (COALESCE((model_json->'model'->>'totalUnigramCount')::numeric, 0)) DESC, updated_at DESC, id)`
  ];
}

export function schemaStatements(q: string, informationAccess?: InformationAccessContext): string[] {
  return [
    `CREATE EXTENSION IF NOT EXISTS vector`,
    `CREATE EXTENSION IF NOT EXISTS pg_trgm`,
    `CREATE SCHEMA IF NOT EXISTS ${q}`,
    `CREATE TABLE IF NOT EXISTS ${q}.storage_meta (key TEXT PRIMARY KEY, value_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    `CREATE TABLE IF NOT EXISTS ${q}.events (id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, type_id TEXT NOT NULL, t BIGINT NOT NULL, payload_json JSONB NOT NULL, parents TEXT[] NOT NULL, hash TEXT NOT NULL UNIQUE, ledger_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    // Plan item 63: the event ledger's append-only guarantee must not
    // depend on application discipline alone. This trigger rejects
    // UPDATE/DELETE unconditionally, regardless of which role executes
    // it -- unlike a role-privilege restriction (which needs a second,
    // migration-only connection role and is an operator deployment
    // decision left undone deliberately, see observeImmutabilityControls),
    // a trigger is safe to provision here because it can never make an
    // already-working deployment lose access it needs: no legitimate
    // code path ever updates or deletes an event row.
    `CREATE OR REPLACE FUNCTION ${q}.reject_event_mutation() RETURNS TRIGGER AS $trigger$
       BEGIN
         RAISE EXCEPTION 'events table is append-only: % on % is not permitted', TG_OP, TG_TABLE_NAME;
       END;
     $trigger$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS events_immutable ON ${q}.events`,
    `CREATE TRIGGER events_immutable BEFORE UPDATE OR DELETE ON ${q}.events FOR EACH ROW EXECUTE FUNCTION ${q}.reject_event_mutation()`,
    `CREATE TABLE IF NOT EXISTS ${q}.conversation_turns (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, episode_id TEXT NOT NULL, turn_index BIGINT NOT NULL, role_id TEXT NOT NULL, text TEXT NOT NULL, evidence_ids TEXT[] NOT NULL, metadata_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.ingestion_checkpoints (id TEXT PRIMARY KEY, root_uri TEXT NOT NULL, item_uri TEXT NOT NULL, phase TEXT NOT NULL, status TEXT NOT NULL, offset_bytes BIGINT NOT NULL, content_hash TEXT, byte_length BIGINT, reason TEXT, metadata_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.blobs (content_hash TEXT PRIMARY KEY, media_type TEXT NOT NULL, byte_length BIGINT NOT NULL, content BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    `CREATE TABLE IF NOT EXISTS ${q}.sources (id TEXT PRIMARY KEY, namespace TEXT NOT NULL, canonical_uri TEXT NOT NULL, first_seen_at TIMESTAMPTZ NOT NULL, last_seen_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.source_versions (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES ${q}.sources(id), content_hash TEXT NOT NULL REFERENCES ${q}.blobs(content_hash), media_type TEXT NOT NULL, observed_at TIMESTAMPTZ NOT NULL, byte_length BIGINT NOT NULL, trust_vector JSONB NOT NULL, metadata_json JSONB NOT NULL, information_label JSONB NOT NULL)`,
    `ALTER TABLE ${q}.source_versions ADD COLUMN IF NOT EXISTS trust_vector JSONB NOT NULL DEFAULT '{"identity":0.5,"integrity":0.9,"parserReliability":0.5,"directness":0.4,"authority":0.4,"freshness":0.3,"independenceGroup":"legacy:migrated","accessScope":"unknown","licenseStatus":"unknown"}'::jsonb`,
    `ALTER TABLE ${q}.source_versions ALTER COLUMN trust_vector DROP DEFAULT`,
    `ALTER TABLE ${q}.source_versions DROP COLUMN IF EXISTS trust`,
    `CREATE TABLE IF NOT EXISTS ${q}.evidence_spans (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES ${q}.sources(id), source_version_id TEXT NOT NULL REFERENCES ${q}.source_versions(id), chunk_id TEXT NOT NULL, content_hash TEXT NOT NULL REFERENCES ${q}.blobs(content_hash), media_type TEXT NOT NULL, byte_start BIGINT NOT NULL, byte_end BIGINT NOT NULL, char_start BIGINT NOT NULL, char_end BIGINT NOT NULL, text_preview TEXT NOT NULL, text_content TEXT NOT NULL, language_hints JSONB NOT NULL, script_hints JSONB NOT NULL, trust_vector JSONB NOT NULL, provenance_json JSONB NOT NULL, features TEXT[] NOT NULL, status TEXT NOT NULL, alpha DOUBLE PRECISION NOT NULL, observed_at TIMESTAMPTZ NOT NULL, information_label JSONB NOT NULL)`,
    ...evidenceTextDigestSchemaStatements(q),
    // Anchor features are a deterministic prefix projection of evidence_spans.features.  The former helper
    // table stored that subset a second time and maintained a second GIN over the same postings.  Existing
    // brains can discard it losslessly; all retrieval now uses the canonical evidence feature array/index.
    `DROP TABLE IF EXISTS ${q}.evidence_anchor_index`,
    `ALTER TABLE ${q}.evidence_spans ADD COLUMN IF NOT EXISTS visual_embedding vector(512)`,
    `ALTER TABLE ${q}.evidence_spans ADD COLUMN IF NOT EXISTS visual_regions JSONB`,
    // Computed once by the database from provenance: ranking reads a short column instead of decoding a 32 KB
    // (max 882 KB) provenance document per candidate row, which measured 7-11s per anchor group. One statement: one
    // table rewrite (each ADD COLUMN ... STORED rewrites the table; measured 12+ minutes on 7 GB).
    `ALTER TABLE ${q}.evidence_spans ADD COLUMN IF NOT EXISTS source_title TEXT GENERATED ALWAYS AS (lower(COALESCE(provenance_json->>'title', provenance_json->'metadata'->>'title', ''))) STORED, ADD COLUMN IF NOT EXISTS source_name TEXT GENERATED ALWAYS AS (btrim(lower(COALESCE(provenance_json->>'title', '') || ' ' || COALESCE(provenance_json->'metadata'->>'title', '') || ' ' || COALESCE(provenance_json->>'identity', '') || ' ' || COALESCE(provenance_json->'metadata'->>'identity', '')))) STORED`,
    // Source kind is a scalar identity residue read on every ranked candidate; stored narrow, it no longer detoasts 58KB of provenance per row.
    `ALTER TABLE ${q}.evidence_spans ADD COLUMN IF NOT EXISTS source_kind TEXT GENERATED ALWAYS AS (COALESCE(provenance_json->>'sourceKind', provenance_json->'metadata'->>'sourceKind', '')) STORED`,
    `CREATE TABLE IF NOT EXISTS ${q}.graph_nodes (id TEXT PRIMARY KEY, type_id TEXT NOT NULL, representation_json JSONB NOT NULL, alpha DOUBLE PRECISION NOT NULL, evidence_ids TEXT[] NOT NULL, features TEXT[] NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, metadata_json JSONB NOT NULL, information_label JSONB NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.graph_edges (id TEXT PRIMARY KEY, source_node_id TEXT NOT NULL, target_node_id TEXT NOT NULL, relation_id TEXT NOT NULL, alpha DOUBLE PRECISION NOT NULL, weight DOUBLE PRECISION NOT NULL, temporal_scope JSONB NOT NULL, evidence_ids TEXT[] NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, metadata_json JSONB NOT NULL, information_label JSONB NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.graph_hyperedges (id TEXT PRIMARY KEY, schema_id TEXT NOT NULL, relation_id TEXT NOT NULL, participant_ports JSONB NOT NULL, member_node_ids TEXT[] NOT NULL, qualifiers_json JSONB NOT NULL, modality_json JSONB NOT NULL, evidence_ids TEXT[] NOT NULL, weight_vector JSONB NOT NULL, temporal_scope JSONB NOT NULL, provenance_refs TEXT[] NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, information_label JSONB NOT NULL)`,
    `ALTER TABLE ${q}.graph_hyperedges ADD COLUMN IF NOT EXISTS schema_id TEXT NOT NULL DEFAULT 'scce.hyperedge.v2'`,
    `ALTER TABLE ${q}.graph_hyperedges ADD COLUMN IF NOT EXISTS participant_ports JSONB NOT NULL DEFAULT '[]'::jsonb`,
    `ALTER TABLE ${q}.graph_hyperedges ADD COLUMN IF NOT EXISTS qualifiers_json JSONB NOT NULL DEFAULT '{}'::jsonb`,
    `ALTER TABLE ${q}.graph_hyperedges ADD COLUMN IF NOT EXISTS modality_json JSONB NOT NULL DEFAULT '{}'::jsonb`,
    `ALTER TABLE ${q}.graph_hyperedges ADD COLUMN IF NOT EXISTS evidence_ids TEXT[] NOT NULL DEFAULT ARRAY[]::text[]`,
    `CREATE TABLE IF NOT EXISTS ${q}.relation_observations (relation_seed_id TEXT NOT NULL, channel TEXT NOT NULL, source_family_id TEXT NOT NULL, signature TEXT NOT NULL, candidate_id TEXT NOT NULL, source_id TEXT NOT NULL, observed_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(relation_seed_id,channel,source_family_id,signature))`,
    `CREATE TABLE IF NOT EXISTS ${q}.quarantine_sources (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, source_version_id TEXT NOT NULL, uri TEXT NOT NULL, content_hash TEXT NOT NULL, media_type TEXT NOT NULL, fetched_at TIMESTAMPTZ NOT NULL, trust_vector JSONB NOT NULL, permission_vector JSONB NOT NULL, license_hint TEXT, decision TEXT NOT NULL, decision_json JSONB)`,
    `CREATE TABLE IF NOT EXISTS ${q}.semantic_proofs (id TEXT PRIMARY KEY, claim_id TEXT NOT NULL, verdict TEXT NOT NULL, confidence_json JSONB NOT NULL, proof_graph_json JSONB NOT NULL, evidence_ids TEXT[] NOT NULL, transform_ids TEXT[] NOT NULL, scores_json JSONB NOT NULL, validator_version TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.construct_graphs (id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, force_vector JSONB NOT NULL, graph_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    `CREATE TABLE IF NOT EXISTS ${q}.validation_graphs (id TEXT PRIMARY KEY, construct_id TEXT NOT NULL, graph_json JSONB NOT NULL, passed BOOLEAN NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    `CREATE TABLE IF NOT EXISTS ${q}.emission_graphs (id TEXT PRIMARY KEY, construct_id TEXT NOT NULL, graph_json JSONB NOT NULL, output_refs JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    `CREATE TABLE IF NOT EXISTS ${q}.program_builds (id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, construct_id TEXT NOT NULL, result_json JSONB NOT NULL, passed BOOLEAN NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    `CREATE TABLE IF NOT EXISTS ${q}.capability_calls (id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, capability_id TEXT NOT NULL, phase TEXT NOT NULL, status TEXT NOT NULL, input_json JSONB NOT NULL, result_json JSONB, risk_vector JSONB NOT NULL, permission_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL, completed_at TIMESTAMPTZ)`,
    `CREATE TABLE IF NOT EXISTS ${q}.forecast_states (id TEXT PRIMARY KEY, episode_id TEXT, t BIGINT NOT NULL, state_vector DOUBLE PRECISION[] NOT NULL, alpha_surface_json JSONB NOT NULL, spectrum_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    `CREATE TABLE IF NOT EXISTS ${q}.forecast_envelopes (id TEXT PRIMARY KEY, source_state_id TEXT NOT NULL, horizon INT NOT NULL, mean_vector DOUBLE PRECISION[] NOT NULL, covariance_json JSONB NOT NULL, interval_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.learning_needs (id TEXT PRIMARY KEY, episode_id TEXT, goal TEXT NOT NULL, gap_json JSONB NOT NULL, source_plan_json JSONB NOT NULL, status TEXT NOT NULL, priority DOUBLE PRECISION NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    `CREATE TABLE IF NOT EXISTS ${q}.language_profiles (id TEXT PRIMARY KEY, source_version_id TEXT NOT NULL, profile_json JSONB NOT NULL, ngram_keys TEXT[] NOT NULL DEFAULT ARRAY[]::text[], created_at TIMESTAMPTZ NOT NULL, information_label JSONB NOT NULL)`,
    `ALTER TABLE ${q}.language_profiles ADD COLUMN IF NOT EXISTS ngram_keys TEXT[] NOT NULL DEFAULT ARRAY[]::text[]`,
    `UPDATE ${q}.language_profiles profile
     SET ngram_keys=COALESCE((
       SELECT ARRAY_AGG(DISTINCT LOWER(item->>'ngram') ORDER BY LOWER(item->>'ngram'))
       FROM jsonb_array_elements(profile.profile_json->'charNgrams') item
       WHERE COALESCE(item->>'ngram','')<>''
     ),ARRAY[]::text[])
     WHERE CARDINALITY(profile.ngram_keys)=0
       AND jsonb_typeof(profile.profile_json->'charNgrams')='array'`,
    `CREATE TABLE IF NOT EXISTS ${q}.language_profile_aliases (
       alias_key TEXT NOT NULL,
       alias_surface TEXT NOT NULL,
       profile_id TEXT NOT NULL REFERENCES ${q}.language_profiles(id) ON DELETE CASCADE,
       source_version_id TEXT NOT NULL,
       evidence_refs TEXT[] NOT NULL,
       source_version_refs TEXT[] NOT NULL,
       confidence DOUBLE PRECISION NOT NULL,
       updated_at TIMESTAMPTZ NOT NULL,
       PRIMARY KEY(alias_key,profile_id)
     )`,
    `WITH candidates AS (
       SELECT LOWER(BTRIM(name->>'surface')) AS alias_key,
              BTRIM(name->>'surface') AS alias_surface,
              lp.id AS profile_id,
              lp.source_version_id,
              ARRAY(SELECT jsonb_array_elements_text(COALESCE(name->'evidenceRefs','[]'::jsonb))) AS evidence_refs,
              ARRAY(SELECT jsonb_array_elements_text(COALESCE(name->'sourceVersionRefs','[]'::jsonb))) AS source_version_refs,
              GREATEST(0, LEAST(1, COALESCE((name->>'confidence')::DOUBLE PRECISION,0))) AS confidence,
              lp.created_at AS updated_at
       FROM ${q}.language_profiles lp
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(lp.profile_json->'discoveredNames','[]'::jsonb)) name
       WHERE BTRIM(COALESCE(name->>'surface',''))<>''
     ), owned AS (
       SELECT *
       FROM candidates c
       WHERE c.source_version_id=ANY(c.source_version_refs)
          OR EXISTS (
            SELECT 1
            FROM ${q}.evidence_spans e
            WHERE e.id=ANY(c.evidence_refs)
              AND e.source_version_id=c.source_version_id
          )
     ), selected AS (
       SELECT DISTINCT ON (alias_key,profile_id) *
       FROM owned
       ORDER BY alias_key,profile_id,confidence DESC,alias_surface
     )
     INSERT INTO ${q}.language_profile_aliases(
       alias_key,alias_surface,profile_id,source_version_id,evidence_refs,source_version_refs,confidence,updated_at
     )
     SELECT alias_key,alias_surface,profile_id,source_version_id,evidence_refs,source_version_refs,confidence,updated_at
     FROM selected
     ON CONFLICT(alias_key,profile_id) DO UPDATE SET
       alias_surface=EXCLUDED.alias_surface,
       source_version_id=EXCLUDED.source_version_id,
       evidence_refs=EXCLUDED.evidence_refs,
       source_version_refs=EXCLUDED.source_version_refs,
       confidence=EXCLUDED.confidence,
       updated_at=EXCLUDED.updated_at`,
    `CREATE TABLE IF NOT EXISTS ${q}.ngram_observations (id TEXT PRIMARY KEY, stream_id TEXT NOT NULL, language_hint TEXT NOT NULL, order_n INT NOT NULL, history TEXT[] NOT NULL, symbol TEXT NOT NULL, count BIGINT NOT NULL, field_weight DOUBLE PRECISION NOT NULL, source_version_id TEXT, evidence_id TEXT, observed_at TIMESTAMPTZ NOT NULL, metadata_json JSONB NOT NULL, information_label JSONB NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.ngram_models (id TEXT PRIMARY KEY, stream_id TEXT NOT NULL, language_hint TEXT NOT NULL, max_order INT NOT NULL, discount DOUBLE PRECISION NOT NULL, model_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL, information_label JSONB NOT NULL)`,
    // The trainedMass DESC ranking and the profile/source-system scope filters read these instead of detoasting model_json (1.68GB of TOAST) per row.
    `ALTER TABLE ${q}.ngram_models ADD COLUMN IF NOT EXISTS profile_id TEXT GENERATED ALWAYS AS (model_json->>'profileId') STORED, ADD COLUMN IF NOT EXISTS source_system TEXT GENERATED ALWAYS AS (model_json->>'sourceSystem') STORED, ADD COLUMN IF NOT EXISTS trained_mass NUMERIC GENERATED ALWAYS AS (COALESCE((model_json->'model'->>'totalUnigramCount')::numeric, 0)) STORED`,
    // Identity discovery counts documents; Kneser-Ney wants text per model. One artifact cannot serve both:
    // language_profiles holds one row per trained shard, so growing a shard to improve the model shrinks the
    // document count the closed class is measured over. Page signatures are the discovery population, written
    // per page from a profile that is computed for every page anyway and otherwise thrown away. Deliberately
    // NOT language_profiles: turn-time hydration loads that table, and pages must not enter it.
    `CREATE TABLE IF NOT EXISTS ${q}.language_profile_signatures (id TEXT PRIMARY KEY, source_version_id TEXT NOT NULL, scripts JSONB NOT NULL, direction TEXT NOT NULL, top_continuation JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL, information_label JSONB NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.language_units (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, source_version_id TEXT NOT NULL, script TEXT NOT NULL, unit_kind TEXT NOT NULL, unit_text TEXT NOT NULL, features TEXT[] NOT NULL, competence_vector DOUBLE PRECISION[] NOT NULL, alpha DOUBLE PRECISION NOT NULL, evidence_ids TEXT[] NOT NULL, metadata_json JSONB NOT NULL, information_label JSONB NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.language_patterns (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, pattern_kind TEXT NOT NULL, support DOUBLE PRECISION NOT NULL, entropy DOUBLE PRECISION NOT NULL, pattern_json JSONB NOT NULL, evidence_ids TEXT[] NOT NULL, updated_at TIMESTAMPTZ NOT NULL, information_label JSONB NOT NULL)`,
    ...canonicalCreativeEventSchemaStatements(q),
    ...constructionSourceDecisionSchemaStatements(q),
    // candidate_pool's scope filter reads this instead of detoasting pattern_json (5.4GB) per row.
    `ALTER TABLE ${q}.language_patterns ADD COLUMN IF NOT EXISTS source_system TEXT GENERATED ALWAYS AS (pattern_json->>'sourceSystem') STORED`,
    languagePatternSelectionHeaderStatement(q),
    `CREATE TABLE IF NOT EXISTS ${q}.semantic_frames (id TEXT PRIMARY KEY, frame_json JSONB NOT NULL, embedding VECTOR(64) NOT NULL, evidence_ids TEXT[] NOT NULL, alpha DOUBLE PRECISION NOT NULL, created_at TIMESTAMPTZ NOT NULL, information_label JSONB NOT NULL)`,
    `ALTER TABLE ${q}.semantic_frames ADD COLUMN IF NOT EXISTS normalized_surface_hash TEXT`,
    `CREATE TABLE IF NOT EXISTS ${q}.translation_alignments (id TEXT PRIMARY KEY, source_frame_id TEXT NOT NULL, target_frame_id TEXT NOT NULL, source_language TEXT NOT NULL, target_language TEXT NOT NULL, force TEXT NOT NULL, loss_vector JSONB NOT NULL, alignment_json JSONB NOT NULL, evidence_ids TEXT[] NOT NULL, updated_at TIMESTAMPTZ NOT NULL, information_label JSONB NOT NULL)`,
    ...informationLabelMigrationStatements(q, informationAccess),
    `CREATE TABLE IF NOT EXISTS ${q}.scce2_import_ledger (id TEXT PRIMARY KEY, import_run_id TEXT NOT NULL, brain_version TEXT NOT NULL, root_path TEXT NOT NULL, section_id TEXT NOT NULL, section_kind TEXT NOT NULL, force_class TEXT NOT NULL, source_path TEXT, file_hash TEXT, shard_hash TEXT, source_version_id TEXT, evidence_ids TEXT[] NOT NULL, node_ids TEXT[] NOT NULL, row_counts_json JSONB NOT NULL, warnings TEXT[] NOT NULL, metadata_json JSONB NOT NULL, imported_at TIMESTAMPTZ NOT NULL, UNIQUE(import_run_id, section_id))`,
    `CREATE TABLE IF NOT EXISTS ${q}.brain_import_lifecycle (import_run_id TEXT PRIMARY KEY, brain_version TEXT NOT NULL, root_path TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('CREATED','IMPORTING','VALIDATING','READY','ACTIVE','STOPPED','FAILED','QUARANTINED','INCOMPATIBLE')), manifest_json JSONB NOT NULL, validation_json JSONB, reason TEXT, revision BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL)`,
    `WITH legacy_runs AS (
       SELECT import_run_id,
              brain_version,
              root_path,
              MIN(imported_at) AS created_at,
              MAX(imported_at) AS updated_at,
              MAX(shard_hash) FILTER (WHERE shard_hash ~ '^[a-fA-F0-9]{64}$') AS manifest_hash,
              COUNT(DISTINCT section_id)::INT AS prior_section_count,
              SUM(COALESCE((row_counts_json->>'graph_nodes')::BIGINT,0)) AS graph_node_count,
              SUM(COALESCE((row_counts_json->>'language_units')::BIGINT,0) + COALESCE((row_counts_json->>'language_patterns')::BIGINT,0)) AS language_row_count,
              SUM(COALESCE((row_counts_json->>'ngram_models')::BIGINT,0)) AS ngram_state_count,
              BOOL_OR(force_class='direct_evidence') AS has_direct_evidence,
              BOOL_OR(force_class='learned_concept_prior') AS has_graph_priors,
              BOOL_OR(force_class='learned_language_prior') AS has_language_priors
       FROM ${q}.scce2_import_ledger
       GROUP BY import_run_id,brain_version,root_path
     ), selected AS (
       SELECT *
       FROM legacy_runs
       WHERE manifest_hash IS NOT NULL AND has_direct_evidence AND has_graph_priors AND has_language_priors
       ORDER BY updated_at DESC,import_run_id
       LIMIT 1
     )
     INSERT INTO ${q}.brain_import_lifecycle(import_run_id,brain_version,root_path,state,manifest_json,validation_json,reason,revision,created_at,updated_at)
     SELECT import_run_id,
            brain_version,
            root_path,
            'ACTIVE',
            jsonb_build_object(
              'schema','scce.brainManifestContract.v1',
              'importRunId',import_run_id,
              'brainVersion',brain_version,
              'rootPath',root_path,
              'manifestHash',manifest_hash,
              'sourceSchema','scce.legacyImportLedger.v1',
              'runtimeContractVersion',1,
              'content',jsonb_build_object(
                'graphShardCount',CASE WHEN graph_node_count>0 THEN 1 ELSE 0 END,
                'languageShardCount',CASE WHEN language_row_count>0 OR ngram_state_count>0 THEN 1 ELSE 0 END,
                'ngramStateCount',ngram_state_count,
                'priorSectionCount',prior_section_count
              ),
              'metadata',jsonb_build_object('migration','postgres.v12.legacy_lifecycle_backfill','sourceTable','scce2_import_ledger'),
              'createdAt',FLOOR(EXTRACT(EPOCH FROM created_at)*1000)
            ),
            jsonb_build_object(
              'schema','scce.brainValidationReport.v1',
              'importRunId',import_run_id,
              'brainVersion',brain_version,
              'manifestHash',manifest_hash,
              'validatorVersion','postgres.v12.legacy_lifecycle_backfill',
              'disposition','PASSED',
              'checks',jsonb_build_array(
                jsonb_build_object('id','legacy_ledger.manifest_hash','passed',true,'severity','error','message','legacy ledger retained a SHA-256 manifest identity'),
                jsonb_build_object('id','legacy_ledger.force_classes','passed',true,'severity','error','message','legacy ledger contains direct evidence, graph priors, and language priors')
              ),
              'validatedAt',FLOOR(EXTRACT(EPOCH FROM updated_at)*1000)
            ),
            'migration activated newest complete legacy ledger run',
            1,
            created_at,
            updated_at
     FROM selected
     WHERE NOT EXISTS (SELECT 1 FROM ${q}.brain_import_lifecycle)
     ON CONFLICT(import_run_id) DO NOTHING`,
    `CREATE TABLE IF NOT EXISTS ${q}.correction_rules (id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, rule_kind TEXT NOT NULL, scope TEXT NOT NULL, pattern TEXT NOT NULL, replacement TEXT, weight DOUBLE PRECISION NOT NULL, context_json JSONB NOT NULL, provenance_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL)`,
    // Real tenant isolation: keyed on (conversation_id, id), not id alone.
    // Claim ids are content-derived (`ruleFromStructuredCorrection`'s
    // `idFactory.semanticId`), so two unrelated conversations recording
    // the identical correction content would otherwise collide on a
    // global id and one would silently fail to ever persist.
    `CREATE TABLE IF NOT EXISTS ${q}.user_model_claims (id TEXT NOT NULL, conversation_id TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL, value TEXT NOT NULL, source TEXT NOT NULL, scope TEXT NOT NULL, confidence DOUBLE PRECISION NOT NULL, observed_at TIMESTAMPTZ NOT NULL, evidence_ids TEXT[] NOT NULL, supersedes_claim_id TEXT, PRIMARY KEY (conversation_id, id))`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_user_model_claims_conversation ON ${q}.user_model_claims(conversation_id, observed_at ASC)`,
    `CREATE TABLE IF NOT EXISTS ${q}.task_resumption_snapshots (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, snapshot_json JSONB NOT NULL, captured_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.document_generation_sessions (id TEXT NOT NULL, conversation_id TEXT NOT NULL, session_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (conversation_id, id))`,
    `CREATE TABLE IF NOT EXISTS ${q}.translation_seeds (target_language TEXT NOT NULL, source_symbol TEXT NOT NULL, source_language TEXT NOT NULL, target_symbol TEXT NOT NULL, score DOUBLE PRECISION NOT NULL, basis TEXT NOT NULL, evidence_ids TEXT[] NOT NULL, observed_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (target_language, source_symbol))`,
    `CREATE TABLE IF NOT EXISTS ${q}.translation_constructions (target_language TEXT NOT NULL, source_symbol_a TEXT NOT NULL, source_symbol_b TEXT NOT NULL, target_symbol_a TEXT NOT NULL, target_symbol_b TEXT NOT NULL, score DOUBLE PRECISION NOT NULL, evidence_ids TEXT[] NOT NULL, observed_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (target_language, source_symbol_a, source_symbol_b))`,
    `CREATE TABLE IF NOT EXISTS ${q}.translation_corrections (id TEXT PRIMARY KEY, source_language TEXT NOT NULL, target_language TEXT NOT NULL, correction_json JSONB NOT NULL, observed_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.locale_bundles (id TEXT PRIMARY KEY, source_locale TEXT NOT NULL, target_language_id TEXT NOT NULL, target_script_id TEXT, status TEXT NOT NULL, force TEXT NOT NULL, messages_json JSONB NOT NULL, missing_terms_json JSONB NOT NULL, evidence_ids TEXT[] NOT NULL, translation_alignment_ids TEXT[] NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.ppf_cache (id TEXT PRIMARY KEY, graph_hash TEXT NOT NULL, beta DOUBLE PRECISION NOT NULL, personalization_json JSONB NOT NULL, mass_json JSONB NOT NULL, diagnostics_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.alpha_traces (id TEXT PRIMARY KEY, graph_hash TEXT NOT NULL, alpha DOUBLE PRECISION NOT NULL, trace_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.self_rewrite_episodes (id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, target TEXT NOT NULL, program_graph_json JSONB NOT NULL, improvement_json JSONB NOT NULL, status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.self_rewrite_patches (id TEXT PRIMARY KEY, rewrite_episode_id TEXT NOT NULL REFERENCES ${q}.self_rewrite_episodes(id), file_path TEXT NOT NULL, before_hash TEXT, after_hash TEXT NOT NULL, patch_json JSONB NOT NULL, score_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.workspaces (id TEXT PRIMARY KEY, root_path TEXT NOT NULL, root_uri TEXT NOT NULL, corpus_id TEXT NOT NULL, status TEXT NOT NULL, metadata_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.workspace_source_files (workspace_id TEXT NOT NULL REFERENCES ${q}.workspaces(id), corpus_id TEXT NOT NULL, path TEXT NOT NULL, absolute_path TEXT NOT NULL, media_type TEXT NOT NULL, content_hash TEXT, modified_time TIMESTAMPTZ NOT NULL, byte_length BIGINT NOT NULL, ingestion_status TEXT NOT NULL, import_batch_id TEXT, source_version_id TEXT, evidence_ids TEXT[] NOT NULL, symbol_ids TEXT[] NOT NULL, concept_ids TEXT[] NOT NULL, warnings TEXT[] NOT NULL, errors TEXT[] NOT NULL, metadata_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(workspace_id,path))`,
    `CREATE TABLE IF NOT EXISTS ${q}.workspace_reports (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES ${q}.workspaces(id), corpus_id TEXT NOT NULL, report_kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, data_json JSONB NOT NULL, source_refs_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.interaction_state_records (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL, state_json JSONB NOT NULL, feature_refs TEXT[] NOT NULL, signal_refs TEXT[] NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.dialogue_policy_decision_records (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL, decision_json JSONB NOT NULL, selected_action_ids TEXT[] NOT NULL, score_trace_refs TEXT[] NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.conversation_outcome_records (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL, prompt_hash TEXT NOT NULL, answer_graph_hash TEXT, response_hash TEXT NOT NULL, accepted BOOLEAN, rejected BOOLEAN, corrected BOOLEAN, correction_text TEXT, requested_constraint_refs TEXT[] NOT NULL, satisfied_constraint_refs TEXT[] NOT NULL, failed_constraint_refs TEXT[] NOT NULL, score_trace_refs TEXT[] NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.user_correction_records (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL, prompt_hash TEXT NOT NULL, response_hash TEXT NOT NULL, correction_text TEXT NOT NULL, rejected_surface_hash TEXT, accepted_surface_hash TEXT, preference_delta_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.style_preference_snapshots (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, profile_hash TEXT NOT NULL, profile_json JSONB NOT NULL, source_outcome_ids TEXT[] NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.response_candidate_records (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL, candidate_id TEXT NOT NULL, policy_decision_id TEXT NOT NULL, answer_graph_hash TEXT, response_hash TEXT NOT NULL, response_text TEXT NOT NULL, critic_score DOUBLE PRECISION NOT NULL, score_trace_refs TEXT[] NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.target_profile_patterns (id TEXT PRIMARY KEY, target_profile_id TEXT NOT NULL, pattern_family_id TEXT NOT NULL, pattern_json JSONB NOT NULL, evidence_ids TEXT[] NOT NULL, alpha DOUBLE PRECISION NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.calibration_observations (id TEXT PRIMARY KEY, calibration_id TEXT NOT NULL, subsystem_id TEXT NOT NULL, task_class TEXT NOT NULL, raw_score DOUBLE PRECISION NOT NULL, outcome BOOLEAN NOT NULL, selected_output_hash TEXT, accepted BOOLEAN, rejected BOOLEAN, corrected BOOLEAN, unsupported_fact_hit BOOLEAN, citation_failure BOOLEAN, user_correction_distance DOUBLE PRECISION, final_outcome TEXT NOT NULL, source_trace_id TEXT, source_record_id TEXT, metadata_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.model_state (id TEXT PRIMARY KEY, model_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.benchmark_runs (id TEXT PRIMARY KEY, config_json JSONB NOT NULL, started_at TIMESTAMPTZ NOT NULL, completed_at TIMESTAMPTZ, summary_json JSONB)`,
    `CREATE TABLE IF NOT EXISTS ${q}.benchmark_cases (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, case_json JSONB NOT NULL, result_json JSONB NOT NULL, score_json JSONB NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.policy_evaluations (id TEXT PRIMARY KEY, policy_fingerprint TEXT NOT NULL, objective_schema_id TEXT NOT NULL, vector_json JSONB NOT NULL, objectives DOUBLE PRECISION[] NOT NULL, evaluation_window_json JSONB NOT NULL, observations INTEGER NOT NULL, information_label JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.policy_genomes (policy_fingerprint TEXT NOT NULL, objective_schema_id TEXT NOT NULL, vector_json JSONB NOT NULL, aggregated_objectives DOUBLE PRECISION[] NOT NULL, evaluation_count INTEGER NOT NULL, information_label JSONB NOT NULL, first_evaluated_at TIMESTAMPTZ NOT NULL, last_evaluated_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (policy_fingerprint, objective_schema_id))`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_policy_evaluations_fingerprint ON ${q}.policy_evaluations(policy_fingerprint, objective_schema_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_policy_genomes_schema ON ${q}.policy_genomes(objective_schema_id, last_evaluated_at DESC)`,
    `CREATE TABLE IF NOT EXISTS ${q}.executive_episode (episode_id TEXT PRIMARY KEY, revision BIGINT NOT NULL, updated_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.executive_command (episode_id TEXT NOT NULL REFERENCES ${q}.executive_episode(episode_id), command_id TEXT NOT NULL, revision_start BIGINT NOT NULL, revision_end BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (episode_id, command_id))`,
    `CREATE TABLE IF NOT EXISTS ${q}.executive_event (episode_id TEXT NOT NULL, revision BIGINT NOT NULL, command_id TEXT NOT NULL, event_json JSONB NOT NULL, information_label JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (episode_id, revision), FOREIGN KEY (episode_id, command_id) REFERENCES ${q}.executive_command(episode_id, command_id))`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_executive_event_episode ON ${q}.executive_event(episode_id, revision ASC)`,
    `CREATE TABLE IF NOT EXISTS ${q}.sparse_ranking_models (model_id TEXT PRIMARY KEY, task_class TEXT NOT NULL, feature_schema_id TEXT NOT NULL, lifecycle TEXT NOT NULL, state_json JSONB NOT NULL, training_window_json JSONB NOT NULL, examples_seen BIGINT NOT NULL, evaluation_json JSONB, previous_active_model_id TEXT, rollback_reason TEXT, information_label JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.sparse_ranking_active_model (task_class TEXT NOT NULL, feature_schema_id TEXT NOT NULL, model_id TEXT NOT NULL REFERENCES ${q}.sparse_ranking_models(model_id), activated_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (task_class, feature_schema_id))`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_sparse_ranking_models_task ON ${q}.sparse_ranking_models(task_class, feature_schema_id, lifecycle)`,
    `CREATE TABLE IF NOT EXISTS ${q}.relation_potential_models (model_id TEXT PRIMARY KEY, lifecycle TEXT NOT NULL, model_json JSONB NOT NULL, validation_json JSONB, training_window_json JSONB NOT NULL, dataset_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.relation_potential_active_model (slot TEXT PRIMARY KEY, model_id TEXT NOT NULL REFERENCES ${q}.relation_potential_models(model_id), activated_at TIMESTAMPTZ NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_relation_potential_models_created ON ${q}.relation_potential_models(lifecycle, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS ${q}.sparse_ranking_comparisons (id TEXT PRIMARY KEY, task_class TEXT NOT NULL, feature_schema_id TEXT NOT NULL, recorded_at TIMESTAMPTZ NOT NULL, candidates_json JSONB NOT NULL, preferred_index INT NOT NULL, weight DOUBLE PRECISION NOT NULL, source TEXT NOT NULL, information_label JSONB NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_sparse_ranking_comparisons_task ON ${q}.sparse_ranking_comparisons(task_class, feature_schema_id, recorded_at DESC)`,
    `CREATE TABLE IF NOT EXISTS ${q}.segmentation_aggregates (segmentation_version TEXT NOT NULL, language_cluster TEXT NOT NULL, tenant_id TEXT NOT NULL, corpus_role TEXT NOT NULL, active_import_version TEXT NOT NULL, documents_observed BIGINT NOT NULL, lexical_segments_observed BIGINT NOT NULL, spaced_boundary_observations BIGINT NOT NULL, total_boundary_observations BIGINT NOT NULL, first_observed_at TIMESTAMPTZ NOT NULL, last_observed_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (segmentation_version, language_cluster, tenant_id, corpus_role, active_import_version))`,
    `CREATE TABLE IF NOT EXISTS ${q}.induced_language_models (id TEXT PRIMARY KEY, training_plan_id TEXT NOT NULL, model_json JSONB NOT NULL, corpus_documents INTEGER NOT NULL, vocabulary_size INTEGER NOT NULL, information_label JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_induced_language_models_created ON ${q}.induced_language_models(created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS ${q}.segmentation_consolidation_runs (run_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('building','fitting','complete','failed')), run_json JSONB NOT NULL, snapshot_json JSONB, inference_json JSONB, information_label JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.segmentation_consolidation_rows (run_id TEXT NOT NULL REFERENCES ${q}.segmentation_consolidation_runs(run_id), collection TEXT NOT NULL, order_key TEXT COLLATE "C" NOT NULL, row_json JSONB NOT NULL, PRIMARY KEY(run_id,collection,order_key))`,
    `CREATE TABLE IF NOT EXISTS ${q}.segmentation_consolidation_active (scope_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES ${q}.segmentation_consolidation_runs(run_id), header_json JSONB NOT NULL, activated_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.segmentation_population_models (id TEXT PRIMARY KEY, training_plan_id TEXT NOT NULL, model_json JSONB NOT NULL, profile_ids TEXT[] NOT NULL, source_version_ids TEXT[] NOT NULL, population_count INTEGER NOT NULL, mdl_gain_nats DOUBLE PRECISION NOT NULL, information_label JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_segmentation_population_models_profiles ON ${q}.segmentation_population_models USING GIN(profile_ids)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_segmentation_population_models_created ON ${q}.segmentation_population_models(created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS ${q}.language_identities (id TEXT PRIMARY KEY, identity_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL, information_label JSONB NOT NULL)`,
    `ALTER TABLE ${q}.language_profiles ADD COLUMN IF NOT EXISTS language_id TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_language_profiles_language ON ${q}.language_profiles(language_id) WHERE language_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_events_episode_t ON ${q}.events(episode_id,t)`,
    // Real, measured fix: EventLedger.readRange's own typeId-filtered
    // lookups (e.g. production-turn-runtime.ts's per-turn
    // `readRange({ typeId: "SelfModelProjected", beforeT, limit: 9 })`)
    // had no index on type_id at all and fell back to a parallel
    // sequential scan of the whole events table (confirmed via EXPLAIN
    // ANALYZE against a real 142k-row table: ~220ms and growing with
    // table size). type_id is never queried without also filtering by t
    // (see readRange's WHERE-clause builder), so this composite index
    // covers the real access pattern directly.
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_events_type_t ON ${q}.events(type_id,t DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_conversation_session_turn ON ${q}.conversation_turns(session_id, turn_index DESC, id DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_ingestion_root_status ON ${q}.ingestion_checkpoints(root_uri,status,updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_evidence_features ON ${q}.evidence_spans USING GIN(features)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_evidence_source ON ${q}.evidence_spans(source_id)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_evidence_source_version ON ${q}.evidence_spans(source_version_id)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_evidence_source_kind ON ${q}.evidence_spans(source_kind)`,
    // The title match is LIKE '%unit%' over source_name; only a trigram index serves an unanchored LIKE.
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_evidence_source_name_trgm ON ${q}.evidence_spans USING gin(source_name gin_trgm_ops)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_evidence_status ON ${q}.evidence_spans(status)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_evidence_status_rank ON ${q}.evidence_spans(status, alpha DESC, observed_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_nodes_features ON ${q}.graph_nodes USING GIN(features)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_nodes_evidence ON ${q}.graph_nodes USING GIN(evidence_ids)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_nodes_updated ON ${q}.graph_nodes(updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_nodes_alpha_rank ON ${q}.graph_nodes(alpha DESC,updated_at DESC,id)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_edges_source ON ${q}.graph_edges(source_node_id)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_edges_target ON ${q}.graph_edges(target_node_id)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_edges_relation ON ${q}.graph_edges(relation_id)`,
    // Version 12 repairs pre-index duplicate ACTIVE rows deterministically. A
    // valid marker is selected; otherwise the most recently updated run is selected. The
    // partial unique index then makes the single-ACTIVE invariant durable.
    `WITH ranked_active AS (
       SELECT import_run_id,
              ROW_NUMBER() OVER (
                ORDER BY
                  CASE WHEN import_run_id=(
                    SELECT model_json->'activeImportRunIds'->>0
                    FROM ${q}.model_state
                    WHERE id='scce2.active_brain'
                  ) THEN 0 ELSE 1 END,
                  updated_at DESC,
                  import_run_id
              ) AS active_rank
       FROM ${q}.brain_import_lifecycle
       WHERE state='ACTIVE'
     )
     UPDATE ${q}.brain_import_lifecycle AS lifecycle
     SET state='READY', reason='migration repaired duplicate ACTIVE lifecycle row', revision=revision+1, updated_at=NOW()
     FROM ranked_active
     WHERE lifecycle.import_run_id=ranked_active.import_run_id AND ranked_active.active_rank>1`,
    `DELETE FROM ${q}.model_state
     WHERE id='scce2.active_brain'
       AND NOT EXISTS (SELECT 1 FROM ${q}.brain_import_lifecycle WHERE state='ACTIVE')`,
    `INSERT INTO ${q}.model_state(id,model_json,updated_at)
     SELECT 'scce2.active_brain',
            jsonb_build_object(
              'activeBrainVersion', brain_version,
              'activeImportRunIds', jsonb_build_array(import_run_id),
              'updatedAt', FLOOR(EXTRACT(EPOCH FROM updated_at)*1000)
            ),
            updated_at
     FROM ${q}.brain_import_lifecycle
     WHERE state='ACTIVE'
     ON CONFLICT(id) DO UPDATE SET model_json=EXCLUDED.model_json, updated_at=EXCLUDED.updated_at`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_${clean(q)}_brain_lifecycle_single_active ON ${q}.brain_import_lifecycle(state) WHERE state='ACTIVE'`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_brain_lifecycle_state_updated ON ${q}.brain_import_lifecycle(state,updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_source_versions_history ON ${q}.source_versions(source_id,observed_at DESC,id DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_edges_source_rank ON ${q}.graph_edges(source_node_id, alpha DESC, updated_at DESC, id)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_edges_target_rank ON ${q}.graph_edges(target_node_id, alpha DESC, updated_at DESC, id)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_edges_evidence ON ${q}.graph_edges USING GIN(evidence_ids)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_hyperedges_members ON ${q}.graph_hyperedges USING GIN(member_node_ids)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_hyperedges_provenance ON ${q}.graph_hyperedges USING GIN(provenance_refs)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_proofs_evidence ON ${q}.semantic_proofs USING GIN(evidence_ids)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_quarantine_decision ON ${q}.quarantine_sources(decision,fetched_at)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_relation_observations_seed ON ${q}.relation_observations(relation_seed_id,channel)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_learning_needs_status ON ${q}.learning_needs(status,priority DESC,updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_ngram_stream_order ON ${q}.ngram_observations(stream_id,language_hint,order_n,observed_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_ngram_source_version_rank ON ${q}.ngram_observations(source_version_id,count DESC,observed_at DESC)`,
    // Expression indexes preserve scope lookup without rewriting the observation corpus during upgrades.
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_ngram_profile_rank ON ${q}.ngram_observations((metadata_json->>'profileId'),count DESC,observed_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_ngram_source_system_rank ON ${q}.ngram_observations((metadata_json->>'sourceSystem'),count DESC,observed_at DESC)`,
    `DROP INDEX IF EXISTS ${q}.idx_${clean(q)}_ngram_profile_rank_stored`,
    `DROP INDEX IF EXISTS ${q}.idx_${clean(q)}_ngram_source_system_rank_stored`,
    // Unscoped listNgramObservations ordering; without this the 7.6M-row
    // table is fully sorted per call (measured live: 6+ minutes).
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_ngram_global_rank ON ${q}.ngram_observations(count DESC, observed_at DESC, id ASC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_ngram_model_source_version_updated ON ${q}.ngram_models((model_json->>'sourceVersionId'),updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_ngram_model_profile_updated ON ${q}.ngram_models((model_json->>'profileId'),updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_ngram_model_source_system_updated ON ${q}.ngram_models((model_json->>'sourceSystem'), updated_at DESC)`,
    // Models load best-trained first (learned unigram mass), not newest first.
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_ngram_model_source_system_trained ON ${q}.ngram_models((model_json->>'sourceSystem'), (COALESCE((model_json->'model'->>'totalUnigramCount')::numeric, 0)) DESC, updated_at DESC)`,
    // Same ranking, on the stored narrow columns: cheap enough to build on a populated table, unlike the JSONB-expression indexes above (fresh-schema only, see freshSchemaIndexStatements).
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_ngram_model_profile_id_trained_rank ON ${q}.ngram_models(profile_id, trained_mass DESC, updated_at DESC, id)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_ngram_model_source_system_trained_rank ON ${q}.ngram_models(source_system, trained_mass DESC, updated_at DESC, id)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_language_profiles_created ON ${q}.language_profiles(created_at DESC,id ASC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_language_profiles_ngrams ON ${q}.language_profiles USING GIN(ngram_keys)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_language_profiles_source_version ON ${q}.language_profiles(source_version_id,created_at DESC,id ASC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_language_profile_alias_lookup ON ${q}.language_profile_aliases(alias_key,confidence DESC,updated_at DESC,profile_id)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_language_units_profile ON ${q}.language_units(profile_id,alpha DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_profile_signature_source_version ON ${q}.language_profile_signatures(source_version_id)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_language_units_source_system_rank ON ${q}.language_units((metadata_json->>'sourceSystem'), alpha DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_language_patterns_source_system_rank ON ${q}.language_patterns((pattern_json->>'sourceSystem'), support DESC, updated_at DESC)`,
    // Same shape on the stored column: a sequential scan otherwise detoasts the whole table (5.4GB) to evaluate the WHERE (measured 18.9s->1.9s forcing the JSONB index; this one the planner can choose on its own).
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_language_patterns_source_system_stored_rank ON ${q}.language_patterns(source_system, support DESC, updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_language_patterns_profile_rank ON ${q}.language_patterns(profile_id,support DESC,updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_source_code_function_lookup ON ${q}.language_patterns(source_system,(pattern_json->>'formalLanguage'),(pattern_json->>'parameterCount'),support DESC,updated_at DESC,id) WHERE pattern_kind='source_code_function'`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_source_computation_binding_lookup ON ${q}.language_patterns(source_system,(pattern_json->>'bindingId'),support DESC,updated_at DESC,id) WHERE pattern_json->>'schema'='${SOURCE_COMPUTATION_CONSTRUCTION_SCHEMA}'`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_contextual_qa_request_lookup ON ${q}.language_patterns USING GIN ((pattern_json->'contextualQaRequestFeatures')) WHERE pattern_kind='semantic_role' AND pattern_json->>'schema'='${LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA}' AND pattern_json->>'componentRecipe'='${CONTEXTUAL_QA_CONSTRUCTION_RECIPE}' AND source_system='${CONTEXTUAL_QA_SOURCE_SYSTEM}'`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_semantic_frames_source_system_rank ON ${q}.semantic_frames((frame_json->>'sourceSystem'), alpha DESC, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_semantic_frames_profile_rank ON ${q}.semantic_frames((frame_json->>'profileId'),alpha DESC,created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_semantic_frames_source_version_rank ON ${q}.semantic_frames((frame_json->>'sourceVersionId'),alpha DESC,created_at DESC)`,
    `DROP INDEX IF EXISTS ${q}.idx_${clean(q)}_semantic_frames_surface_rank`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_semantic_frames_normalized_surface_hash_rank ON ${q}.semantic_frames(normalized_surface_hash,alpha DESC,created_at DESC,id ASC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_semantic_frames_embedding ON ${q}.semantic_frames USING ivfflat (embedding vector_cosine_ops) WITH (lists = 64)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_evidence_visual_embedding ON ${q}.evidence_spans USING ivfflat (visual_embedding vector_cosine_ops) WITH (lists = 32)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_translation_pair ON ${q}.translation_alignments(source_language,target_language,updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_scce2_import_run ON ${q}.scce2_import_ledger(import_run_id,imported_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_scce2_import_force ON ${q}.scce2_import_ledger(force_class,imported_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_scce2_import_hash ON ${q}.scce2_import_ledger(section_kind,file_hash,shard_hash)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_correction_scope_kind ON ${q}.correction_rules(scope,rule_kind,updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_correction_weight ON ${q}.correction_rules(weight DESC,updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_user_model_claims_subject_scope ON ${q}.user_model_claims(subject,scope,observed_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_task_resumption_goal ON ${q}.task_resumption_snapshots(goal_id,captured_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_document_generation_updated ON ${q}.document_generation_sessions(updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_translation_seeds_target_score ON ${q}.translation_seeds(target_language,score DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_translation_constructions_target_score ON ${q}.translation_constructions(target_language,score DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_translation_corrections_pair ON ${q}.translation_corrections(source_language,target_language,observed_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_locale_bundles_target ON ${q}.locale_bundles(target_language_id,status,updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_ppf_graph_hash ON ${q}.ppf_cache(graph_hash,created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_alpha_graph_hash ON ${q}.alpha_traces(graph_hash,created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_self_rewrite_status ON ${q}.self_rewrite_episodes(status,created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_workspaces_updated ON ${q}.workspaces(updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_workspace_files_status ON ${q}.workspace_source_files(workspace_id,ingestion_status,updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_workspace_files_hash ON ${q}.workspace_source_files(workspace_id,content_hash)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_workspace_reports_kind ON ${q}.workspace_reports(workspace_id,report_kind,created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_interaction_state_conversation ON ${q}.interaction_state_records(conversation_id,created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_interaction_state_head ON ${q}.interaction_state_records(conversation_id,((state_json->>'turnIndex')::numeric) DESC,created_at DESC,id DESC) WHERE state_json->>'schema'='scce.dialogue_cognitive_state.v2' AND jsonb_typeof(state_json->'turnIndex')='number'`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_dialogue_policy_conversation ON ${q}.dialogue_policy_decision_records(conversation_id,created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_conversation_outcome_conversation ON ${q}.conversation_outcome_records(conversation_id,created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_conversation_outcome_prompt ON ${q}.conversation_outcome_records(prompt_hash,created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_user_correction_conversation ON ${q}.user_correction_records(conversation_id,created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_style_snapshot_conversation ON ${q}.style_preference_snapshots(conversation_id,created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_response_candidate_conversation ON ${q}.response_candidate_records(conversation_id,created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_target_profile_patterns_profile ON ${q}.target_profile_patterns(target_profile_id,pattern_family_id,updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_calibration_observations_id_time ON ${q}.calibration_observations(calibration_id,task_class,created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_calibration_observations_subsystem ON ${q}.calibration_observations(subsystem_id,created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_calibration_observations_source_record ON ${q}.calibration_observations(source_record_id,created_at DESC)`
  ];
}

function clean(q: string): string {
  return q.replace(/[^A-Za-z0-9_]/g, "");
}

export function requiredHydrationColumns(): Record<string, string[]> {
  return {
    storage_meta: ["key", "value_json", "updated_at"],
    segmentation_consolidation_runs: ["run_id", "scope_id", "state", "run_json", "snapshot_json", "inference_json", "information_label", "created_at"],
    segmentation_consolidation_rows: ["run_id", "collection", "order_key", "row_json"],
    segmentation_consolidation_active: ["scope_id", "run_id", "header_json", "activated_at"],
    events: ["id", "episode_id", "type_id", "payload_json", "ledger_hash"],
    conversation_turns: ["id", "session_id", "episode_id", "turn_index", "role_id", "text", "evidence_ids", "metadata_json"],
    blobs: ["content_hash", "media_type", "byte_length", "content"],
    sources: ["id", "namespace", "canonical_uri"],
    source_versions: ["id", "source_id", "content_hash", "media_type", "observed_at", "byte_length", "trust_vector", "metadata_json", "information_label"],
    evidence_spans: ["id", "source_id", "source_version_id", "content_hash", "byte_start", "byte_end", "text_content", "text_sha256", "trust_vector", "provenance_json", "features", "status", "alpha", "information_label"],
    graph_nodes: ["id", "type_id", "representation_json", "alpha", "evidence_ids", "features", "metadata_json", "information_label"],
    graph_edges: ["id", "source_node_id", "target_node_id", "relation_id", "alpha", "weight", "evidence_ids", "metadata_json", "information_label"],
    graph_hyperedges: ["id", "schema_id", "relation_id", "participant_ports", "member_node_ids", "qualifiers_json", "modality_json", "evidence_ids", "weight_vector", "provenance_refs", "information_label"],
    semantic_proofs: ["id", "claim_id", "verdict", "proof_graph_json", "evidence_ids", "scores_json"],
    construct_graphs: ["id", "episode_id", "force_vector", "graph_json"],
    validation_graphs: ["id", "construct_id", "graph_json", "passed"],
    emission_graphs: ["id", "construct_id", "graph_json", "output_refs"],
    language_profiles: ["id", "source_version_id", "profile_json", "information_label"],
    language_profile_aliases: ["alias_key", "alias_surface", "profile_id", "source_version_id", "evidence_refs", "source_version_refs", "confidence", "updated_at"],
    ngram_observations: ["id", "stream_id", "language_hint", "order_n", "history", "symbol", "count", "metadata_json", "information_label"],
    ngram_models: ["id", "stream_id", "language_hint", "max_order", "discount", "model_json", "information_label"],
    language_units: ["id", "profile_id", "source_version_id", "script", "unit_kind", "unit_text", "features", "competence_vector", "alpha", "evidence_ids", "metadata_json", "information_label"],
    creative_event_templates: ["id", "kind", "value_json"],
    creative_event_lexemes: ["id", "kind", "value_json"],
    creative_event_lexical_pages: ["id", "kind", "member_ids", "value_json"],
    construction_source_decision_pages: ["id", "owner_key", "kind", "value_json", "information_label"],
    creative_event_witnesses: ["id", "kind", "value_json", "information_label"],
    creative_event_occurrences: ["id", "kind", "value_json", "information_label"],
    language_patterns: ["id", "profile_id", "pattern_kind", "support", "entropy", "pattern_json", "evidence_ids", "information_label", ...LANGUAGE_PATTERN_SELECTION_HEADERS],
    semantic_frames: ["id", "frame_json", "normalized_surface_hash", "embedding", "evidence_ids", "alpha", "information_label"],
    translation_alignments: ["id", "source_frame_id", "target_frame_id", "source_language", "target_language", "force", "alignment_json", "evidence_ids", "information_label"],
    scce2_import_ledger: ["id", "import_run_id", "brain_version", "root_path", "section_id", "section_kind", "force_class", "row_counts_json", "warnings", "metadata_json"],
    brain_import_lifecycle: ["import_run_id", "brain_version", "root_path", "state", "manifest_json", "revision", "created_at", "updated_at"],
    correction_rules: ["id", "episode_id", "rule_kind", "scope", "pattern", "weight", "context_json", "provenance_json"],
    user_model_claims: ["id", "conversation_id", "kind", "subject", "value", "source", "scope", "confidence", "observed_at", "evidence_ids"],
    task_resumption_snapshots: ["id", "goal_id", "snapshot_json", "captured_at"],
    document_generation_sessions: ["id", "conversation_id", "session_json", "updated_at"],
    translation_seeds: ["target_language", "source_symbol", "source_language", "target_symbol", "score", "basis", "evidence_ids", "observed_at"],
    translation_constructions: ["target_language", "source_symbol_a", "source_symbol_b", "target_symbol_a", "target_symbol_b", "score", "evidence_ids", "observed_at"],
    translation_corrections: ["id", "source_language", "target_language", "correction_json", "observed_at"],
    model_state: ["id", "model_json", "updated_at"],
    ppf_cache: ["id", "graph_hash", "personalization_json", "mass_json", "diagnostics_json"],
    alpha_traces: ["id", "graph_hash", "alpha", "trace_json"],
    workspaces: ["id", "root_path", "root_uri", "corpus_id", "status", "metadata_json"],
    workspace_source_files: ["workspace_id", "corpus_id", "path", "absolute_path", "media_type", "evidence_ids", "metadata_json"],
    workspace_reports: ["id", "workspace_id", "corpus_id", "report_kind", "body", "data_json", "source_refs_json"],
    interaction_state_records: ["id", "conversation_id", "turn_id", "state_json", "feature_refs", "signal_refs"],
    dialogue_policy_decision_records: ["id", "conversation_id", "turn_id", "decision_json", "selected_action_ids", "score_trace_refs"],
    conversation_outcome_records: ["id", "conversation_id", "turn_id", "prompt_hash", "response_hash", "requested_constraint_refs", "satisfied_constraint_refs", "failed_constraint_refs"],
    user_correction_records: ["id", "conversation_id", "turn_id", "prompt_hash", "response_hash", "correction_text", "preference_delta_json"],
    style_preference_snapshots: ["id", "conversation_id", "profile_hash", "profile_json", "source_outcome_ids"],
    response_candidate_records: ["id", "conversation_id", "turn_id", "candidate_id", "policy_decision_id", "response_hash", "response_text", "critic_score"],
    target_profile_patterns: ["id", "target_profile_id", "pattern_family_id", "pattern_json", "evidence_ids", "alpha"],
    calibration_observations: ["id", "calibration_id", "subsystem_id", "task_class", "raw_score", "outcome", "final_outcome", "metadata_json"]
  };
}

/** A concurrent migration created the same database-wide extension first; both wanted it present, and it is. */
export function isDuplicateExtensionError(error: unknown): boolean {
  const failure = error as { code?: string; constraint?: string; message?: string } | undefined;
  if (!failure) return false;
  // 23505 unique_violation on the extension name index, or 42710 duplicate_object from a concurrent CREATE EXTENSION.
  if (failure.code === "42710") return true;
  return failure.code === "23505"
    && (failure.constraint === "pg_extension_name_index" || String(failure.message ?? "").includes("pg_extension_name_index"));
}
