// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHasher, toJsonValue } from "./primitives.js";
import { collapseSurfaceWhitespace } from "./surface-linguistics.js";
import { languageGenerationFramesFromCounterclaimIntent } from "./semantic-realization-frames.js";
import { semanticFrameSurfaces, type LanguageMemoryRuntime, type LanguageMemoryRuntimeState } from "./language-memory-runtime.js";
import { realizeCounterclaimWithInducedPolarityConstruction, reinterpretCounterclaimWithInducedPolarityConstruction } from "./counterclaim-polarity-construction.js";
import type { SemanticAtom } from "./semantic-proof-types.js";
import type { SemanticProofResult } from "./semantic-proof-system.js";
import type { RuntimeAdversarialSearchRequest } from "./runtime-motion.js";
import type { Hasher, JsonValue, LanguageProfile } from "./types.js";

export interface CounterclaimSearchIntent {
  schema: "scce.counterclaim_search_intent.v1";
  id: string;
  claimAtomId: string;
  claimHash: string;
  originalPolarity: SemanticAtom["polarity"];
  targetPolarity: SemanticAtom["polarity"];
  predicate: string;
  /** Source-attested label only; an opaque predicate ID must never become query text. */
  predicateSurface?: string;
  roles: SemanticAtom["roles"];
  constraints: SemanticAtom["constraints"];
  claimSourceSurface: string;
  counterexampleIds: string[];
  opposingSourceSurfaces: string[];
}

/** Select an existing typed claim, never re-parse the owner request to invent one. */
export function compileCounterclaimSearchIntent(input: {
  proof: Pick<SemanticProofResult, "claimAtoms" | "counterexamples" | "evidenceAtoms" | "graphAtoms">;
  hasher?: Hasher;
}): CounterclaimSearchIntent | undefined {
  const hasher = input.hasher ?? createHasher();
  const candidates = input.proof.claimAtoms.filter(atom => atom.predicate.trim() && atom.roles.length
    && atom.roles.every(role => role.name && role.value.trim())
    && (atom.polarity === 1 || atom.polarity === -1));
  const pressure = (atom: SemanticAtom) => Math.max(0, ...input.proof.counterexamples
    .filter(row => row.claimAtomId === atom.id).map(row => row.contradiction));
  const claim = [...candidates].sort((a, b) => pressure(b) - pressure(a) || b.alpha - a.alpha || a.id.localeCompare(b.id))[0];
  if (!claim) return undefined;
  const claimHash = hasher.digestHex(JSON.stringify({ shape: claimShape(claim), polarity: claim.polarity }));
  const opposite = claim.polarity === 1 ? -1 : 1;
  const counterexamples = input.proof.counterexamples.filter(row => row.claimAtomId === claim.id);
  const evidenceIds = new Set(counterexamples.map(row => row.evidenceAtomId));
  const opposing = [...input.proof.evidenceAtoms, ...input.proof.graphAtoms]
    .filter(atom => evidenceIds.has(atom.id) && atom.polarity === opposite && claimShape(atom) === claimShape(claim));
  return {
    schema: "scce.counterclaim_search_intent.v1",
    id: `counterclaim:${claimHash.slice(0, 32)}`,
    claimAtomId: claim.id,
    claimHash,
    originalPolarity: claim.polarity,
    targetPolarity: opposite,
    predicate: claim.predicate,
    ...(normalizedSurface(claim.sourceText).includes(normalizedSurface(claim.predicate)) ? { predicateSurface: claim.predicate } : {}),
    roles: claim.roles.map(role => ({ ...role, features: [...role.features] })),
    constraints: claim.constraints.map(constraint => ({ ...constraint, evidenceIds: [...constraint.evidenceIds] })),
    claimSourceSurface: claim.sourceText,
    counterexampleIds: counterexamples.map(row => row.id).sort(),
    opposingSourceSurfaces: [...new Set(opposing.map(atom => atom.sourceText).filter(Boolean))].slice(0, 2)
  };
}

export function counterclaimSurfaceViolationIds(input: {
  intent: CounterclaimSearchIntent;
  surface: string;
  originalQuerySurface: string;
  interpretedAtoms: readonly SemanticAtom[];
}): string[] {
  const failures: string[] = [];
  const surface = normalizedSurface(input.surface);
  if (!surface) failures.push("counterclaim.empty_surface");
  if (surface === normalizedSurface(input.originalQuerySurface)
    || surface === normalizedSurface(input.intent.claimSourceSurface)) failures.push("counterclaim.query_echo");
  if (!input.interpretedAtoms.length) failures.push("counterclaim.uninterpretable_surface");
  if (input.interpretedAtoms.some(atom => atom.polarity !== input.intent.targetPolarity)) failures.push("counterclaim.polarity_not_preserved");
  if (input.interpretedAtoms.some(atom => claimShape(atom) !== claimShape(input.intent))) failures.push("counterclaim.predicate_roles_or_constraints_changed");
  return failures;
}

/** Generate once through the active learned language lane, then verify the generated surface independently. */
export function realizeCounterclaimSearchIntent(input: {
  intent?: CounterclaimSearchIntent;
  originalQuerySurface: string;
  languageMemory: LanguageMemoryRuntime;
  state: LanguageMemoryRuntimeState;
  targetLanguageProfile?: LanguageProfile;
  targetLanguageId?: string;
  interpretSurface: (surface: string) => readonly SemanticAtom[];
  hasher?: Hasher;
}): { request?: RuntimeAdversarialSearchRequest; audit: JsonValue } {
  const hasher = input.hasher ?? createHasher();
  const originalQueryHash = hasher.digestHex(input.originalQuerySurface);
  const base = {
    schema: "scce.counterclaim_search_realization.v1",
    originalQueryHash,
    intentId: input.intent?.id ?? null,
    claimHash: input.intent?.claimHash ?? null,
    claimAtomId: input.intent?.claimAtomId ?? null,
    targetPolarity: input.intent?.targetPolarity ?? null,
    targetLanguageProfileId: input.targetLanguageProfile?.id ?? null,
    targetLanguageId: input.targetLanguageId ?? null
  };
  const rejected = (reasonIds: string[], extra: Record<string, unknown> = {}) => ({
    audit: toJsonValue({ ...base, accepted: false, reasonIds, ...extra })
  });
  if (!input.intent) return rejected(["counterclaim.no_typed_claim"]);
  const intent = input.intent;
  const profile = input.targetLanguageProfile;
  if (!profile || (!input.state.models.length && input.state.importedLanguagePriorCount === 0)) {
    return rejected(["counterclaim.learned_language_unavailable"]);
  }
  if (input.state.scope.profileIds.length && !input.state.scope.profileIds.includes(profile.id)) {
    return rejected(["counterclaim.target_profile_outside_active_scope"]);
  }
  const frames = languageGenerationFramesFromCounterclaimIntent(input.intent, {
    targetLanguage: input.targetLanguageId ?? profile.id,
    targetScript: profile.scripts[0]?.script
  });
  try {
    const generation = input.languageMemory.generate({
      state: input.state,
      targetLanguageProfile: profile,
      frames,
      // Only already-bound values and actual opposing evidence can seed
      // realization. No negation word, query template, or opaque role ID.
      contextSymbols: [...input.intent.roles.map(role => role.value), ...input.intent.opposingSourceSurfaces],
      generationExtent: 64
    });
    const surface = generation.text.trim();
    const importedIds = [...generation.importedNgramModelIdsUsed, ...generation.importedLanguageUnitIdsUsed,
      ...generation.importedPhrasePatternIdsUsed, ...generation.importedSemanticFrameIdsUsed];
    const violations = counterclaimSurfaceViolationIds({
      intent: input.intent,
      surface,
      originalQuerySurface: input.originalQuerySurface,
      interpretedAtoms: surface ? input.interpretSurface(surface) : []
    });
    if (!importedIds.length) violations.push("counterclaim.no_learned_realization_contribution");
    const querySurfaceHash = hasher.digestHex(surface);
    const realizationAudit = { querySurfaceHash, importedIds: [...new Set(importedIds)].slice(0, 16), frameIds: frames.map(frame => frame.id) };
    if (violations.length) {
      const learned = learnedCounterclaimSurfaces({
        state: input.state,
        profileId: profile.id,
        intent,
        originalQuerySurface: input.originalQuerySurface,
        interpretSurface: input.interpretSurface
      });
      if (!learned.length) {
        const constructed = realizeCounterclaimWithInducedPolarityConstruction({
          state: input.state,
          profileId: profile.id,
          intent,
          interpretSurface: input.interpretSurface
        });
        if (constructed.surface && constructed.construction) {
          const constructedAtoms = reinterpretCounterclaimWithInducedPolarityConstruction({
            intent,
            construction: constructed.construction,
            surface: constructed.surface,
            interpretSurface: input.interpretSurface
          });
          const constructionViolations = counterclaimSurfaceViolationIds({
            intent,
            surface: constructed.surface,
            originalQuerySurface: input.originalQuerySurface,
            interpretedAtoms: constructedAtoms
          });
          if (!constructionViolations.length) {
            const selectedAudit = {
              querySurfaceHash: hasher.digestHex(constructed.surface),
              importedIds: [constructed.construction.positiveSourceId, constructed.construction.negativeSourceId],
              frameIds: frames.map(frame => frame.id),
              realizationMode: "induced_source_polarity_construction",
              sourceKind: "paired_source_surface",
              polarityConstruction: constructed.audit
            };
            const audit = toJsonValue({ ...base, ...selectedAudit, accepted: true, reasonIds: [],
              predicatePreserved: true, rolesPreserved: true, constraintsPreserved: true, oppositePolarityPreserved: true });
            return {
              request: {
                searchKind: "counterclaim",
                querySurface: constructed.surface,
                claimHash: input.intent.claimHash,
                intentId: input.intent.id,
                originalQueryHash,
                targetLanguageId: input.targetLanguageId ?? profile.id,
                realizationAudit: audit
              },
              audit
            };
          }
          return rejected([...violations, ...constructionViolations], { ...realizationAudit, polarityConstruction: constructed.audit });
        }
        return rejected(violations, { ...realizationAudit, polarityConstruction: constructed.audit });
      }
      // This is still the language-memory realization lane: the typed intent
      // constrains which previously learned source surfaces it may select. It
      // does not synthesize a marker, translate an opaque relation, or infer a
      // natural-language negator. The surface is independently interpreted
      // again below before it can become a search request.
      const realized = input.languageMemory.realize({
        state: input.state,
        requestText: input.originalQuerySurface,
        candidates: learned.map(candidate => ({
          text: candidate.text,
          fit: candidate.support,
          profileId: profile.id,
          contextKey: intent.id
        }))
      });
      const selected = learned.find(candidate => normalizedSurface(candidate.text) === normalizedSurface(realized.text));
      const selectedViolations = selected
        ? counterclaimSurfaceViolationIds({
          intent,
          surface: selected.text,
          originalQuerySurface: input.originalQuerySurface,
          interpretedAtoms: input.interpretSurface(selected.text)
        })
        : ["counterclaim.learned_surface_not_selected"];
      if (selected && selectedViolations.length === 0) {
        const selectedAudit = {
          querySurfaceHash: hasher.digestHex(selected.text),
          importedIds: [selected.id],
          frameIds: frames.map(frame => frame.id),
          realizationMode: "source_bound_counterclaim_surface",
          sourceKind: selected.source
        };
        const audit = toJsonValue({ ...base, ...selectedAudit, accepted: true, reasonIds: [],
          predicatePreserved: true, rolesPreserved: true, constraintsPreserved: true, oppositePolarityPreserved: true });
        return {
          request: {
            searchKind: "counterclaim",
            querySurface: selected.text,
            claimHash: input.intent.claimHash,
            intentId: input.intent.id,
            originalQueryHash,
            targetLanguageId: input.targetLanguageId ?? profile.id,
            realizationAudit: audit
          },
          audit
        };
      }
      return rejected([...violations, ...selectedViolations], realizationAudit);
    }
    const audit = toJsonValue({ ...base, ...realizationAudit, accepted: true, reasonIds: [],
      predicatePreserved: true, rolesPreserved: true, constraintsPreserved: true, oppositePolarityPreserved: true });
    return {
      request: {
        searchKind: "counterclaim",
        querySurface: surface,
        claimHash: input.intent.claimHash,
        intentId: input.intent.id,
        originalQueryHash,
        targetLanguageId: input.targetLanguageId ?? profile.id,
        realizationAudit: audit
      },
      audit
    };
  } catch {
    return rejected(["counterclaim.realization_or_interpretation_failed"]);
  }
}

interface LearnedCounterclaimSurface {
  id: string;
  text: string;
  source: "language_unit" | "semantic_frame";
  support: number;
}

/**
 * Read only profile-owned language surfaces already admitted by the learner.
 * The structural check is deliberately performed here, before language-memory
 * ranking, so arbitrary short/opaque scripts do not depend on a Latin-centric
 * anchor heuristic to be eligible for a typed counterclaim realization.
 */
function learnedCounterclaimSurfaces(input: {
  state: LanguageMemoryRuntimeState;
  profileId: string;
  intent: CounterclaimSearchIntent;
  originalQuerySurface: string;
  interpretSurface: (surface: string) => readonly SemanticAtom[];
}): LearnedCounterclaimSurface[] {
  const candidates: LearnedCounterclaimSurface[] = [];
  for (const unit of input.state.importedUnits) {
    if (unit.profileId !== input.profileId || (unit.unitKind !== "phrase" && unit.unitKind !== "symbol")) continue;
    candidates.push({ id: unit.id, text: unit.text, source: "language_unit", support: unit.alpha });
  }
  for (const frame of input.state.importedSemanticFrames) {
    const profileId = frameProfileId(frame.frameJson);
    if (profileId !== input.profileId) continue;
    for (const text of semanticFrameSurfaces(frame)) {
      candidates.push({ id: frame.id, text, source: "semantic_frame", support: frame.alpha });
    }
  }
  const retained = new Map<string, LearnedCounterclaimSurface>();
  for (const candidate of candidates) {
    const text = candidate.text.trim();
    if (!text) continue;
    const violations = counterclaimSurfaceViolationIds({
      intent: input.intent,
      surface: text,
      originalQuerySurface: input.originalQuerySurface,
      interpretedAtoms: input.interpretSurface(text)
    });
    if (violations.length) continue;
    const key = normalizedSurface(text);
    const current = retained.get(key);
    if (!current || candidate.support > current.support || (candidate.support === current.support && candidate.id.localeCompare(current.id) < 0)) {
      retained.set(key, { ...candidate, text });
    }
  }
  return [...retained.values()]
    .sort((left, right) => right.support - left.support || left.id.localeCompare(right.id) || left.text.localeCompare(right.text))
    .slice(0, 32);
}

function frameProfileId(value: JsonValue): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const profileId = (value as Record<string, JsonValue>).profileId;
  return typeof profileId === "string" && profileId ? profileId : undefined;
}

function normalizedSurface(surface: string): string {
  return collapseSurfaceWhitespace(surface.normalize("NFKC")).toLocaleLowerCase();
}

function claimShape(atom: Pick<SemanticAtom, "predicate" | "roles" | "constraints">): string {
  return JSON.stringify({
    predicate: atom.predicate,
    roles: atom.roles.map(role => [role.name, role.normalized || normalizedSurface(role.value), role.type]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    constraints: atom.constraints.map(constraint => [constraint.kind, constraint.subject, constraint.operator, constraint.value])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  });
}
