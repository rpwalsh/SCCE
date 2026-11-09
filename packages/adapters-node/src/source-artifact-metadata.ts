// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalDigestHex, canonicalStringify, createHasher, normalizeInformationLabel, REQUEST_SEED_PATTERN_JSON_FIELDS, REQUEST_SEED_FRAME_JSON_FIELDS, toJsonValue, validateSourceLanguageCompilationHeader, type SourceId, type SourceVersionId, type ContentHash, type InformationLabel } from "@scce/kernel";
import { profileSourceOwnershipSql } from "./pooled-profile-ownership.js";
import { DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY, DURABLE_JOIN_PROGRAM_BYTE_LEDGER_SCHEMA, durableJoinProgramJsonByteLengths } from "./durable-join-program-storage.js";
import type { CreativeEventStorageHost } from "./canonical-creative-event-store.js";

export const SOURCE_ARTIFACT_METADATA_KEY = "_scceSourceArtifactMetadata";
export const SOURCE_ARTIFACT_METADATA_SCHEMA = "scce.source_artifact_metadata.v1";
export const SOURCE_ARTIFACT_METADATA_REF_SCHEMA = "scce.source_artifact_metadata_ref.v1";
const hasher = createHasher();
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const fail = (): never => { throw new Error("canonical source artifact metadata is missing, inaccessible or changed"); };
// Root objects inspected by SQL must remain directly queryable. Scalars and primitive arrays always remain inline.
const QUERY_ROOTS = new Set<string>([...REQUEST_SEED_PATTERN_JSON_FIELDS, ...REQUEST_SEED_FRAME_JSON_FIELDS, "graphBoundConstructions", "lexicalClasses", "sourceCompilation", "compilation", "inheritedMetadata", "bundle", "joinProgram", "profileBinding", "sourceDependencies", "requestDependencies", "trainingWitnesses", "pooledSourceBinding", "requirementCoefficients", "model", "identity", "sourceAdmission", "sourceMetadataBinding", "transcriptArchive"]);
interface Input { value: unknown; logicalValue?: unknown; profileId?: string; sourceVersionId?: string; informationLabel?: InformationLabel }
interface Holder { id: string; profile_id: string; pattern_json: Record<string, unknown>; information_label: InformationLabel }
interface ValidatedHolder { metadata: Record<string, unknown>; digest: string; compilationId: string; profileId: string; sourceVersionId: unknown; label: string }
interface Reference { schema: string; receiptId: string; digest: string; keys: string[]; introducedLedger: boolean; recordDigest: string }
const same = (a: unknown, b: unknown): boolean => canonicalStringify(a) === canonicalStringify(b);
const compilationId = (value: Record<string, unknown>): string | undefined => typeof value.sourceCompilationId === "string" ? value.sourceCompilationId
  : typeof record(value.sourceCompilation)?.compilationId === "string" ? record(value.sourceCompilation)!.compilationId as string : undefined;

/** Storage-only normalization. The public record is reconstructed exactly; no learned payload is inferred. */
export function createSourceArtifactMetadataCodec(host: CreativeEventStorageHost) {
  async function holders(inputs: readonly Input[], encoding: boolean): Promise<Map<string, Holder>> {
    const ids = [...new Set(inputs.flatMap(input => {
      const root = record(input.value); if (!root) return [];
      const reference = record(root[SOURCE_ARTIFACT_METADATA_KEY]);
      if (reference) return typeof reference.receiptId === "string" ? [reference.receiptId] : fail();
      const id = encoding ? compilationId(root) : undefined;
      return id ? [`source.language.compilation.${id}`] : [];
    }))];
    const result = new Map<string, Holder>();
    for (let offset = 0; offset < ids.length; offset += 128) {
      const params: unknown[] = [ids.slice(offset, offset + 128)];
      const access = host.informationAccessPredicate("receipt", params.length + 1); params.push(...access.params);
      const profileAccess = host.informationAccessPredicate("profile", params.length + 1); params.push(...profileAccess.params);
      const ownership = profileSourceOwnershipSql(host, params, "profile");
      const versionAccess = host.informationAccessPredicate("version", params.length + 1); params.push(...versionAccess.params);
      const rows = await host.query<Holder>(`SELECT receipt.id,receipt.profile_id,receipt.pattern_json,receipt.information_label
        FROM ${host.table("language_patterns")} receipt JOIN ${host.table("language_profiles")} profile ON profile.id=receipt.profile_id
        JOIN ${host.table("source_versions")} version ON version.id=receipt.pattern_json->'compilation'->>'sourceVersionId'
          AND version.source_id=receipt.pattern_json->'compilation'->>'sourceId'
          AND version.content_hash=receipt.pattern_json->'compilation'->>'contentHash'
          AND profile.source_version_id=version.id
        WHERE receipt.id=ANY($1::text[]) AND receipt.pattern_kind='source_compilation' AND ${access.sql} AND ${profileAccess.sql} AND ${versionAccess.sql} AND ${ownership}`, params);
      for (const row of rows) result.set(row.id, row);
    }
    return result;
  }
  function validateBase(holder: Holder): ValidatedHolder | undefined {
    const compilation = record(holder.pattern_json.compilation), shared = record(holder.pattern_json.inheritedMetadata);
    if (!shared) return undefined;
    const metadata = record(shared.value);
    const { compilationId: id, modelInventory: _inventory, ...header } = compilation ?? {};
    if (holder.pattern_json.schema !== "scce.source_language_compilation_receipt.v1" || compilation?.schema !== "scce.source_language_compilation.v1"
      || typeof compilation.compilerRecipe !== "string" || !metadata || shared.schema !== SOURCE_ARTIFACT_METADATA_SCHEMA || typeof shared.digest !== "string"
      || shared.digest !== canonicalDigestHex(metadata, hasher) || record(compilation?.options)?.artifactMetadataDigest !== shared.digest
      || typeof id !== "string" || holder.id !== `source.language.compilation.${id}` || canonicalDigestHex(header, hasher) !== id
      || compilation?.profileId !== holder.profile_id) return fail();
    try {
      validateSourceLanguageCompilationHeader({ owner: { sourceId: header.sourceId as SourceId, sourceVersionId: header.sourceVersionId as SourceVersionId,
        contentHash: header.contentHash as ContentHash }, profileId: holder.profile_id, sourceSystem: String(header.sourceSystem), hasher,
        modelJson: toJsonValue({ profileId: holder.profile_id, sourceVersionId: header.sourceVersionId, sourceCompilation: { ...header, compilationId: id } }), validationPolicy: "read_stored" });
    } catch { return fail(); }
    return { metadata, digest: shared.digest, compilationId: id, profileId: holder.profile_id,
      sourceVersionId: compilation.sourceVersionId, label: canonicalStringify(normalizeInformationLabel(holder.information_label)) };
  }
  function validate(input: Input, holder: Holder | undefined, expectedId: string,
    validated: Map<Holder, ValidatedHolder | undefined>, expectedDigest?: string): ValidatedHolder | undefined {
    if (!holder) return fail();
    // The owner read and this memo belong only to this single invocation, never another call or database snapshot.
    if (!validated.has(holder)) validated.set(holder, validateBase(holder));
    const shared = validated.get(holder);
    if (!shared) { if (expectedDigest !== undefined) return fail(); return undefined; }
    const root = record(input.value)!;
    if (shared.compilationId !== expectedId || input.profileId !== undefined && input.profileId !== shared.profileId
      || input.sourceVersionId !== undefined && input.sourceVersionId !== shared.sourceVersionId
      || typeof root.profileId === "string" && root.profileId !== shared.profileId
      || input.informationLabel !== undefined && canonicalStringify(normalizeInformationLabel(input.informationLabel)) !== shared.label
      || expectedDigest !== undefined && expectedDigest !== shared.digest) return fail();
    return shared;
  }
  return {
    async encodeMany(inputs: readonly Input[]): Promise<unknown[]> {
      const owners = await holders(inputs, true), validated = new Map<Holder, ValidatedHolder | undefined>();
      return inputs.map(input => {
        const root = record(input.value); if (!root || root.schema === "scce.source_language_compilation_receipt.v1") return input.value;
        if (root[SOURCE_ARTIFACT_METADATA_KEY] !== undefined) return fail();
        const id = compilationId(root); if (!id) return input.value;
        const shared = validate(input, owners.get(`source.language.compilation.${id}`), id, validated); if (!shared) return input.value;
        const keys = Object.keys(shared.metadata).filter(key => !QUERY_ROOTS.has(key) && key !== DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY && key !== SOURCE_ARTIFACT_METADATA_KEY
          && root[key] !== undefined && same(root[key], shared.metadata[key]) && root[key] !== null && typeof root[key] === "object"
          && (!Array.isArray(root[key]) || (root[key] as unknown[]).some(value => value !== null && typeof value === "object")));
        if (!keys.length) return input.value;
        const existingLedger = record(root[DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]);
        if (Object.hasOwn(root, DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY)) {
          if (input.logicalValue === undefined || Object.hasOwn(record(input.logicalValue) ?? {}, DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY)) return fail();
          const sizes = durableJoinProgramJsonByteLengths(input.logicalValue);
          if (existingLedger?.schema !== DURABLE_JOIN_PROGRAM_BYTE_LEDGER_SCHEMA || existingLedger.decodedJsonBytes !== sizes.decodedJsonBytes
            || existingLedger.decodedJsonbBytes !== sizes.decodedJsonbBytes) return fail();
        }
        const next = { ...root }; for (const key of keys) delete next[key];
        const introducedLedger = root[DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY] === undefined;
        if (introducedLedger) next[DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY] = { schema: DURABLE_JOIN_PROGRAM_BYTE_LEDGER_SCHEMA, ...durableJoinProgramJsonByteLengths(root) };
        next[SOURCE_ARTIFACT_METADATA_KEY] = { schema: SOURCE_ARTIFACT_METADATA_REF_SCHEMA, receiptId: `source.language.compilation.${id}`, digest: shared.digest, keys, introducedLedger, recordDigest: canonicalDigestHex(root, hasher) };
        return next;
      });
    },
    async decodeMany(inputs: readonly Input[]): Promise<unknown[]> {
      const owners = await holders(inputs, false), validated = new Map<Holder, ValidatedHolder | undefined>();
      return inputs.map(input => {
        const root = record(input.value); if (!root || !Object.hasOwn(root, SOURCE_ARTIFACT_METADATA_KEY)) return input.value;
        const raw = record(root[SOURCE_ARTIFACT_METADATA_KEY]); if (!raw) return fail();
        if (raw.schema !== SOURCE_ARTIFACT_METADATA_REF_SCHEMA || typeof raw.receiptId !== "string" || typeof raw.digest !== "string"
          || typeof raw.recordDigest !== "string" || typeof raw.introducedLedger !== "boolean" || !Array.isArray(raw.keys) || !raw.keys.length
          || raw.keys.some(key => typeof key !== "string" || QUERY_ROOTS.has(key) || key === SOURCE_ARTIFACT_METADATA_KEY || key === DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY)
          || new Set(raw.keys).size !== raw.keys.length) return fail();
        const ref = raw as unknown as Reference, id = compilationId(root); if (!id || ref.receiptId !== `source.language.compilation.${id}`) return fail();
        const shared = validate(input, owners.get(ref.receiptId), id, validated, ref.digest)!;
        const next = { ...root }; delete next[SOURCE_ARTIFACT_METADATA_KEY];
        for (const key of ref.keys) { if (!Object.hasOwn(shared.metadata, key) || Object.hasOwn(root, key)) return fail();
          Object.defineProperty(next, key, { value: structuredClone(shared.metadata[key]), enumerable: true, writable: true, configurable: true }); }
        if (ref.introducedLedger) {
          const ledger = record(next[DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]); delete next[DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY];
          const sizes = durableJoinProgramJsonByteLengths(next);
          if (ledger?.schema !== DURABLE_JOIN_PROGRAM_BYTE_LEDGER_SCHEMA || ledger.decodedJsonBytes !== sizes.decodedJsonBytes || ledger.decodedJsonbBytes !== sizes.decodedJsonbBytes) return fail();
        }
        if (canonicalDigestHex(next, hasher) !== ref.recordDigest) return fail();
        return next;
      });
    }
  };
}
