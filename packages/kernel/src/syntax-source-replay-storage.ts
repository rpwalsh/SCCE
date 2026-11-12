// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { induceSyntaxTemplates, type LanguageInductionDocument } from "./language-induction.js";
import { toJsonValue } from "./primitives.js";
import { sourceTextReplayDigest as digest,
  sourceTextReplayFail as fail, sourceTextReplayJson as exact, sourceTextReplayRecord as record,
  sourceTextReplaySnapshot as snapshot, packSourceTextReplayRecipe, unpackSourceTextReplayRecipe } from "./source-text-replay.js";
import { validateSourceTextReplayBindingSetReference,
  type ResolvedSourceTextReplayBindingSet, type SourceTextReplayBindingSetReference } from "./source-text-replay-binding-set.js";
import type { Hasher } from "./types.js";

export const SYNTAX_SOURCE_REPLAY_KEY = "_scceSyntaxSourceReplay";
export const SYNTAX_SOURCE_REPLAY_SCHEMA = "scce.syntax_source_replay.storage.v1";
interface Recipe {
  schema: typeof SYNTAX_SOURCE_REPLAY_SCHEMA; reducer: "kernel.syntax_templates.exact_source.v1";
  bindingSet: SourceTextReplayBindingSetReference; field: "templates" | "syntaxTemplates"; templateLimit: number;
  includeCounts: boolean; expectedLogicalDigest: string; digest: string;
}
function material(documents: readonly LanguageInductionDocument[], field: Recipe["field"], limit: number, counts: boolean, hasher: Hasher) {
  const all = induceSyntaxTemplates(documents, hasher).slice(0, 2048);
  const values: Record<string, unknown> = { [field]: all.slice(0, limit) };
  if (counts) {
    const frequencies = new Map<string, number>();
    for (const template of all) {
      const key = template.shape.join(" ").trim(); if (key) frequencies.set(key, (frequencies.get(key) ?? 0) + 1);
    }
    values.counts = Object.fromEntries([...frequencies].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 128));
  }
  return field === "templates" ? toJsonValue(values) as Record<string, unknown> : values;
}
function validated(value: unknown, hasher: Hasher): Recipe {
  const recipe = snapshot(unpackSourceTextReplayRecipe(value, SYNTAX_SOURCE_REPLAY_SCHEMA, hasher)) as Recipe;
  if (!record(recipe) || Object.keys(recipe).sort().join(",") !== "bindingSet,digest,expectedLogicalDigest,field,includeCounts,reducer,schema,templateLimit"
    || recipe.schema !== SYNTAX_SOURCE_REPLAY_SCHEMA || recipe.reducer !== "kernel.syntax_templates.exact_source.v1"
    || !["templates", "syntaxTemplates"].includes(recipe.field) || !Number.isSafeInteger(recipe.templateLimit)
    || recipe.templateLimit !== (recipe.field === "templates" ? 256 : 2048) || typeof recipe.includeCounts !== "boolean"
    || recipe.field === "syntaxTemplates" && recipe.includeCounts || typeof recipe.expectedLogicalDigest !== "string") return fail();
  validateSourceTextReplayBindingSetReference(recipe.bindingSet);
  const { digest: expected, ...body } = recipe;
  if (digest(body, hasher) !== expected) return fail();
  return recipe;
}

/** Physical boundary only. Keeps logical syntax fields intact in compiler/runtime objects. */
export function encodeSyntaxSourceReplay(value: Record<string, unknown>, input: ResolvedSourceTextReplayBindingSet): Record<string, unknown> {
  if (Object.hasOwn(value, SYNTAX_SOURCE_REPLAY_KEY)) return fail();
  const field = Object.hasOwn(value, "templates") ? "templates" : Object.hasOwn(value, "syntaxTemplates") ? "syntaxTemplates" : undefined;
  if (!field) return value;
  if (Object.hasOwn(value, "templates") && Object.hasOwn(value, "syntaxTemplates")) return fail();
  const includeCounts = field === "templates" && Object.hasOwn(value, "counts"), templateLimit = field === "templates" ? 256 : 2048;
  const expected = { [field]: value[field], ...(includeCounts ? { counts: value.counts } : {}) };
  const bindingSet = validateSourceTextReplayBindingSetReference(input.bindingSet);
  const computed = material(input.documents, field, templateLimit, includeCounts, input.hasher);
  if (exact(computed) !== exact(expected)) return fail();
  const body = { schema: SYNTAX_SOURCE_REPLAY_SCHEMA, reducer: "kernel.syntax_templates.exact_source.v1" as const,
    bindingSet, field, templateLimit, includeCounts, expectedLogicalDigest: digest(expected, input.hasher) } as const;
  // Request-seed reads intentionally omit the replay marker and source-owned
  // template body. Counts are small, bounded request metadata, so retain their
  // exact producer-verified copy inline while replaying only the templates.
  // The marker digest still binds both fields and cold full reads re-derive and
  // compare the counts below before accepting the retained copy.
  const next = { ...value }; delete next[field];
  return { ...next, [SYNTAX_SOURCE_REPLAY_KEY]: packSourceTextReplayRecipe({ ...body, digest: digest(body, input.hasher) }, input.hasher) };
}

export function syntaxSourceReplayBindingSetReference(value: Record<string, unknown>, hasher: Hasher): SourceTextReplayBindingSetReference | undefined {
  return Object.hasOwn(value, SYNTAX_SOURCE_REPLAY_KEY) ? validated(value[SYNTAX_SOURCE_REPLAY_KEY], hasher).bindingSet : undefined;
}

export function decodeSyntaxSourceReplay(value: Record<string, unknown>, context: ResolvedSourceTextReplayBindingSet): Record<string, unknown> {
  if (!Object.hasOwn(value, SYNTAX_SOURCE_REPLAY_KEY)) return value;
  const recipe = validated(value[SYNTAX_SOURCE_REPLAY_KEY], context.hasher);
  if (exact(recipe.bindingSet) !== exact(validateSourceTextReplayBindingSetReference(context.bindingSet))) return fail();
  if (Object.hasOwn(value, recipe.field)) return fail();
  const logical = material(context.documents, recipe.field, recipe.templateLimit, recipe.includeCounts, context.hasher);
  if (digest(logical, context.hasher) !== recipe.expectedLogicalDigest) return fail();
  if (recipe.includeCounts && Object.hasOwn(value, "counts") && exact(value.counts) !== exact(logical.counts)) return fail();
  const { [SYNTAX_SOURCE_REPLAY_KEY]: _marker, ...root } = value;
  return { ...root, ...logical };
}
