// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHasher, normalizeInformationLabel, joinInformationLabels, decodeConstructionSourceExamples, type EvidenceSpan, type InformationLabel,
  constructionSourceExampleStorageJson as exact,
  CONSTRUCTION_SOURCE_DECISION_KIND, constructionSourceDecisionPageId, createConstructionSourceDecisionRestorer,
  normalizeConstructionSourceDecisions, validateConstructionSourceDecisionPage, type ConstructionSourceDecisionPage,
  CONSTRUCTION_SOURCE_DECISION_MAX_PAGE_BYTES
} from "@scce/kernel";
import type { CreativeEventStorageHost } from "./canonical-creative-event-store.js";
import { DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY, DURABLE_JOIN_PROGRAM_BYTE_LEDGER_SCHEMA, durableJoinProgramJsonByteLengths } from "./durable-join-program-storage.js";

export interface ConstructionSourceDecisionStorageHost extends CreativeEventStorageHost {
  evidence(ids: readonly string[]): Promise<readonly EvidenceSpan[]>;
}
export interface ConstructionSourceDecisionInput { value: unknown; informationLabel?: InformationLabel; logicalValue?: unknown }
export interface ConstructionSourceDecisionStoreOptions { maxPageBytes?: number; writePageBytes?: number; maxReadBytes?: number; pageRows?: number }
export function constructionSourceDecisionSchemaStatements(q: string): string[] {
  return [`CREATE TABLE IF NOT EXISTS ${q}.construction_source_decision_pages (id TEXT PRIMARY KEY,owner_key TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind='${CONSTRUCTION_SOURCE_DECISION_KIND}'),value_json JSONB NOT NULL,information_label JSONB NOT NULL)`];
}
interface PageRow { id: string; owner_key: string; kind: string; value_json: unknown; information_label: InformationLabel; json_bytes?: string }
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const fail = (): never => { throw Error("invalid or inaccessible construction source decision storage"); };
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Immutable source-owned pages; no learned rows or source versions are replaced or collected. */
export function createConstructionSourceDecisionStore(host: ConstructionSourceDecisionStorageHost, options: ConstructionSourceDecisionStoreOptions = {}) {
  const hasher = createHasher(), maxPageBytes = options.maxPageBytes ?? CONSTRUCTION_SOURCE_DECISION_MAX_PAGE_BYTES,
    writePageBytes = options.writePageBytes ?? Math.min(16 * 1024, maxPageBytes),
    maxReadBytes = options.maxReadBytes ?? 64 * 1024 * 1024, pageRows = options.pageRows ?? 32;
  if (![maxPageBytes, writePageBytes, maxReadBytes, pageRows].every(value => natural(value) && value > 0) || pageRows > 128
    || writePageBytes > maxPageBytes || maxPageBytes > maxReadBytes || maxPageBytes > CONSTRUCTION_SOURCE_DECISION_MAX_PAGE_BYTES) return fail();
  const table = host.table("construction_source_decision_pages");
  const join = (a: InformationLabel | undefined, b: unknown): InformationLabel | undefined => b === undefined ? a : normalizeInformationLabel(a
    ? joinInformationLabels([a, normalizeInformationLabel(b as InformationLabel)], { explicitMergeAuthority: host.informationAccess?.explicitMergeAuthority === true })
    : normalizeInformationLabel(b as InformationLabel));
  const walk = (value: unknown, visit: (node: Record<string, unknown>, label?: InformationLabel) => void, inherited?: InformationLabel): void => {
    const active = new WeakSet<object>(); let count = 0;
    const next = (value: unknown, label: InformationLabel | undefined, depth: number): void => {
      if (!value || typeof value !== "object") return;
      if (++count > 1_000_000 || depth > 128 || active.has(value)) return fail(); active.add(value);
      try { if (Object.values(Object.getOwnPropertyDescriptors(value)).some(descriptor => descriptor.get || descriptor.set)) return fail();
        const node = record(value), joined = node ? join(label, node.informationLabel) : label;
        if (node) visit(node, joined); for (const child of Object.values(value)) next(child, joined, depth + 1);
      } finally { active.delete(value); }
    }; next(value, inherited, 0);
  };
  const replace = (value: unknown, visit: (node: Record<string, unknown>) => unknown): unknown => {
    let count = 0; const active = new WeakSet<object>();
    const next = (value: unknown, depth: number): unknown => {
      if (!value || typeof value !== "object") return value;
      if (++count > 1_000_000 || depth > 128 || active.has(value)) return fail(); active.add(value);
      try { const node = record(value), changed = node ? visit(node) : undefined; if (changed !== undefined) return changed;
        let modified = false; const entries = Object.entries(value).map(([key, child]) => { const result = next(child, depth + 1); modified ||= result !== child; return [key, result] as const; });
        return modified ? Array.isArray(value) ? entries.map(([, child]) => child) : Object.fromEntries(entries) : value;
      } finally { active.delete(value); }
    }; return next(value, 0);
  };
  const ownerOf = (value: unknown): string => { const key = record(value)?.sourceCompilationId; return typeof key === "string" && key.length > 0 ? key : fail(); };
  const eligible = (value: unknown): boolean => {
    const root = record(value), bundle = record(root?.bundle);
    if (root?.schema !== "scce.language_construction_pattern.v1" || root.storageEncoding !== "scce.language_construction.source_examples.v1"
      || typeof bundle?.bindingId !== "string" || !bundle.bindingId.startsWith("language.source_relation.")) return false;
    const examples = decodeConstructionSourceExamples(bundle.sourceExamples, bundle, hasher);
    // SQL request seeds can inspect inline roles when a producer omitted its true hint.
    // A page reference hides those roles, so only page bundles whose root hints retain that visibility.
    for (const [field, hint] of [["roles", "sourceConstructionCandidate"], ["nullRoles", "requestConstructionCandidate"]] as const) {
      if (root[hint] !== true && examples.some(example => {
        const roles = record(example)?.[field];
        return Array.isArray(roles) && roles.some(role => {
          const binding = record(role)?.graphBinding;
          return binding !== null && typeof binding === "object" && !Array.isArray(binding);
        });
      })) return false;
    }
    return true;
  };
  const withLedger = (value: unknown, input: ConstructionSourceDecisionInput): unknown => {
    const root = record(value) ?? fail(), original = record(input.value) ?? fail();
    const existing = record(original[DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]);
    if (Object.hasOwn(original, DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY)) {
      if (existing?.schema !== DURABLE_JOIN_PROGRAM_BYTE_LEDGER_SCHEMA || !natural(existing.decodedJsonBytes) || !natural(existing.decodedJsonbBytes)) return fail();
      if (input.logicalValue !== undefined) { if (Object.hasOwn(record(input.logicalValue) ?? {}, DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY)) return fail();
        const sizes = durableJoinProgramJsonByteLengths(input.logicalValue);
        if (existing.decodedJsonBytes !== sizes.decodedJsonBytes || existing.decodedJsonbBytes !== sizes.decodedJsonbBytes) return fail(); }
      return root;
    }
    const logical = input.logicalValue ?? input.value;
    if (Object.hasOwn(record(logical) ?? {}, DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY)) return fail();
    const logicalRoot = record(logical);
    return { ...root, [DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]: { schema: DURABLE_JOIN_PROGRAM_BYTE_LEDGER_SCHEMA, ...durableJoinProgramJsonByteLengths(logical),
      ...(logicalRoot && Object.hasOwn(logicalRoot, "joinProgram") ? { joinProgramMemberJsonbBytes: durableJoinProgramJsonByteLengths(logicalRoot.joinProgram).decodedJsonbBytes
        + Buffer.byteLength(JSON.stringify("joinProgram")) + 2 + (Object.keys(logicalRoot).length > 1 ? 2 : 0) } : {}) } };
  };
  return {
    encodeMany: async (inputs: readonly ConstructionSourceDecisionInput[]): Promise<unknown[]> => {
      const replacements = inputs.map(() => new WeakMap<object, unknown>()), groups = new Map<string, { ownerKey: string; label: InformationLabel; entries: Array<{ index: number; value: Record<string, unknown> }> }>();
      for (const [index, input] of inputs.entries()) {
        // Raw array roots have no parent ledger envelope. Preserve the logical array without page writes.
        if (Array.isArray(input.value)) continue;
        walk(input.value, (value, inherited) => {
        if (constructionSourceDecisionPageId(value) !== undefined) return fail();
        if (!eligible(value)) return;
        const ownerKey = ownerOf(value), label = normalizeInformationLabel(host.requireWritableInformationLabel(inherited));
        const key = exact([ownerKey, label]); const group = groups.get(key) ?? { ownerKey, label, entries: [] }; group.entries.push({ index, value }); groups.set(key, group);
        }, input.informationLabel);
      }
      if (!groups.size) return inputs.map(input => input.value);
      return host.transaction(async () => {
      const pending = new Map<string, { page: ConstructionSourceDecisionPage; label: InformationLabel }>();
      for (const group of groups.values()) {
        const values = group.entries.map(entry => entry.value);
        const ids = [...new Set(values.flatMap(value => { const ids = record(record(value)?.bundle)?.evidenceIds;
          return Array.isArray(ids) && ids.every((id): id is string => typeof id === "string") ? ids : fail(); }))];
        const evidence = await host.evidence(ids);
        if (evidence.length !== ids.length || new Set(evidence.map(span => span.id)).size !== ids.length || evidence.some(span => !ids.includes(String(span.id)) || span.status !== "promoted")) return fail();
        for (const span of evidence) if (span.informationLabel && exact(normalizeInformationLabel(joinInformationLabels([group.label, span.informationLabel], {
          explicitMergeAuthority: host.informationAccess?.explicitMergeAuthority === true }))) !== exact(group.label)) return fail();
        const namespace = hasher.digestHex(exact(group.label));
        const plan = normalizeConstructionSourceDecisions(values, { ownerKey: group.ownerKey, namespace, evidence, hasher, maxPageBytes: writePageBytes });
        for (const page of plan.pages) { validateConstructionSourceDecisionPage(page, group.ownerKey, hasher, writePageBytes);
          const previous = pending.get(page.id); if (previous && (exact(previous.page) !== exact(page) || exact(previous.label) !== exact(group.label))) return fail();
          pending.set(page.id, { page, label: group.label }); }
        for (const [ordinal, entry] of group.entries.entries()) if (constructionSourceDecisionPageId(plan.patterns[ordinal]) !== undefined) {
          const old = replacements[entry.index]!.get(entry.value), next = plan.patterns[ordinal]; if (old && exact(old) !== exact(next)) return fail(); replacements[entry.index]!.set(entry.value, next);
        }
      }
      const pages = [...pending.values()];
      for (let offset = 0; offset < pages.length; offset += pageRows) {
        const batch = pages.slice(offset, offset + pageRows), serialized = JSON.stringify(batch.map(({ page, label }) => ({ id: page.id, owner_key: page.ownerKey, kind: page.kind, value_json: page, information_label: label })));
        await host.query(`INSERT INTO ${table}(id,owner_key,kind,value_json,information_label)
          SELECT id,owner_key,kind,value_json,information_label FROM jsonb_to_recordset($1::jsonb) AS input(id text,owner_key text,kind text,value_json jsonb,information_label jsonb)
          ON CONFLICT(id) DO NOTHING`, [serialized]);
        const access = host.informationAccessPredicate("page", 2);
        const found = await host.query<{ id: string }>(`SELECT page.id FROM ${table} page
          JOIN jsonb_to_recordset($1::jsonb) AS expected(id text,owner_key text,kind text,value_json jsonb,information_label jsonb) ON expected.id=page.id
          WHERE page.owner_key=expected.owner_key AND page.kind=expected.kind AND page.value_json=expected.value_json
            AND page.information_label=expected.information_label AND ${access.sql}`, [serialized, ...access.params]);
        if (new Set(found.map(row => row.id)).size !== batch.length || found.some(row => !batch.some(expected => expected.page.id === row.id))) return fail();
      }
      return inputs.map((input, index) => { const next = replace(input.value, node => replacements[index]!.get(node)); return next === input.value ? input.value : withLedger(next, input); });
      });
    },
    async decodeMany(values: readonly unknown[]): Promise<unknown[]> {
      const groups = new Map<string, Set<string>>();
      for (const value of values) walk(value, node => { const id = constructionSourceDecisionPageId(node); if (id === undefined) return;
        const ownerKey = ownerOf(node), ids = groups.get(ownerKey) ?? new Set<string>(); ids.add(id); groups.set(ownerKey, ids); });
      if (!groups.size) return [...values];
      const restorers = new Map<string, (value: unknown) => unknown>(); let totalBytes = 0;
      for (const [ownerKey, ids] of groups) {
        const wanted = [...ids], pages = new Map<string, ConstructionSourceDecisionPage>();
        for (let offset = 0; offset < wanted.length; offset += pageRows) {
          const batch = wanted.slice(offset, offset + pageRows), access = host.informationAccessPredicate("page", 3), params = [batch, ownerKey, ...access.params];
          const predicate = `page.id=ANY($1::text[]) AND page.owner_key=$2 AND page.kind='${CONSTRUCTION_SOURCE_DECISION_KIND}' AND ${access.sql}`;
          const headers = await host.query<PageRow>(`SELECT page.id,page.owner_key,page.kind,octet_length(page.value_json::text)::text AS json_bytes FROM ${table} page WHERE ${predicate}`, params);
          if (new Set(headers.map(row => row.id)).size !== batch.length || headers.some(row => !batch.includes(row.id) || row.owner_key !== ownerKey || row.kind !== CONSTRUCTION_SOURCE_DECISION_KIND)) return fail();
          // PostgreSQL's JSONB text adds separator spaces to the canonical wire used by the kernel page bound.
          // At most one space is added per existing punctuation byte; the decoded canonical page is checked below.
          for (const header of headers) { const bytes = Number(header.json_bytes); if (!natural(bytes) || bytes <= 0 || bytes > maxPageBytes * 2 || (totalBytes += bytes) > maxReadBytes) return fail(); }
          const rows = await host.query<PageRow>(`SELECT page.id,page.owner_key,page.kind,page.value_json,page.information_label FROM ${table} page WHERE ${predicate}`, params);
          if (new Set(rows.map(row => row.id)).size !== batch.length || rows.some(row => !batch.includes(row.id) || row.owner_key !== ownerKey || row.kind !== CONSTRUCTION_SOURCE_DECISION_KIND)) return fail();
          for (const row of rows) {
            const page = record(row.value_json);
            if (!page || page.namespace !== hasher.digestHex(exact(normalizeInformationLabel(row.information_label)))
              || page.id !== row.id || page.kind !== row.kind || page.ownerKey !== row.owner_key) return fail();
            // The invocation-owned restorer validates and snapshots this page once on first use.
            pages.set(row.id, page as unknown as ConstructionSourceDecisionPage);
          }
        }
        restorers.set(ownerKey, createConstructionSourceDecisionRestorer(pages, ownerKey, hasher, maxPageBytes));
      }
      return values.map(value => replace(value, node => constructionSourceDecisionPageId(node) === undefined ? undefined : restorers.get(ownerOf(node))!(node)));
    }
  };
}
