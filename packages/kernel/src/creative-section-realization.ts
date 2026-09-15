// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { traceEvent } from "./debug/trace.js";
import type { LanguageMemoryRuntime, LanguageMemoryRuntimeState } from "./language-memory-runtime.js";
import { languageGenerationSentenceEndingsAdequate, languageGenerationSurfaceAdequate } from "./language-memory-runtime.js";
import { namedSubjectAnchors } from "./kernel-answer-primitives.js";
import { collapseSurfaceWhitespace, sourceDerivedCasingHints, surfaceContainsTerm, surfaceUnits } from "./surface-linguistics.js";
import type { LanguageProfile } from "./types.js";
import type { NarrativeConditioning } from "./document-generation-session.js";
import { requestSubjectSegments, type TurnRequirementField } from "./turn-requirements.js";


export interface CreativeSectionRealizationInput {
  languageMemory: LanguageMemoryRuntime;
  state: LanguageMemoryRuntimeState;
  targetLanguageProfile?: LanguageProfile;
  requestText: string;
  sectionGoal: string;
  /** Prior realized prose supplies continuation context, never typed state IDs. */
  priorSurfaceTexts?: readonly string[];
  /** The committed narrative's exact typed state, kept separate from lexical context. */
  narrativeConditioning?: NarrativeConditioning;
  /** Words this section's prose should favor -- typically the request's own retrieved-evidence vocabulary, so word choice stays on-topic instead of drifting into an unrelated source's fingerprint. */
  topicVocabulary?: readonly string[];
  /** Typed section obligations, separate from names and soft vocabulary. */
  requiredContentTerms?: readonly string[];
  /**
   * The document's cast, already resolved by the caller when the request
   * text itself has none (a bare-pronoun follow-up like "write a story
   * about her") -- typically proper-noun anchors pulled from this turn's
   * own discourse-bound evidence. Used only as a fallback: a request that
   * names its own subject always wins on its own text.
   */
  resolvedCastSubjectIds?: readonly string[];
  /** Additional correctly-cased text (typically this turn's evidence) used only to recover proper-noun casing, never as content. */
  casingSourceTexts?: readonly string[];
  /** Distinct attempts sample distinct continuations for the same goal. */
  attempt?: number;
  generationExtent?: number;
  targetLanguage?: string;
  targetScript?: string;
}

export interface CreativeSectionRealization {
  text: string;
  accepted: boolean;
  reason: "ok" | "empty-generation" | "inadequate-surface" | "prompt-echo" | "uncovered-content";
  generationAudit?: {
    stoppedBy: string;
    symbolCount: number;
    moveCount: number;
    averageInformation: number;
    confidence: number;
    rawTextChars: number;
  };
}

/**
 * Section-scoped call into the same generation engine the Mouth uses,
 * without the Mouth's per-turn pipeline cost. Fails closed with a
 * reason; prompts are never content.
 */
export function realizeCreativeSection(input: CreativeSectionRealizationInput): CreativeSectionRealization {
  const conditioning = (input.priorSurfaceTexts ?? []).filter(Boolean).slice(-6);
  // Corpus-named anchors only, not a ranking over every word by length.
  // contentUnits' length ranking had no way to tell a request's own
  // instruction words ("write", "paragraph", "three") from its actual
  // subject -- live-verified: "write a three paragraph short story about
  // her" put "write"/"three"/"paragraph" into the story as characters.
  // A request with no capitalized subject (a pronoun, a common noun)
  // honestly yields no forced entity rather than a wrong one.
  // A section goal built from the request text ("... [part N of M]") has
  // the same emptiness a bare-pronoun request does -- the resolved cast
  // fallback applies here too, not just to the whole-request entity set.
  const resolvedCast = (input.resolvedCastSubjectIds ?? []).slice(0, 3);
  const goalUnits = resolvedCast.length
    ? resolvedCast
    : properNounEntityAnchors(input.sectionGoal).slice(0, 3);
  // One rotated unit per section owns the hard required-coverage
  // obligation (its opener varies instead of chanting every unit every
  // time) -- but the whole document's core entities (protagonist,
  // antagonist) are boosted in EVERY section. Rotating them away entirely
  // was the reason "Einstein" was absent from sections whose rotated
  // unit happened to land on a different word -- a multi-section
  // document has exactly one cast, present throughout.
  const rotation = goalUnits.length ? (stableRotation(input.sectionGoal) + Math.max(0, Math.floor(input.attempt ?? 1) - 1)) % goalUnits.length : 0;
  const sectionUnit = goalUnits.length ? [goalUnits[rotation]!] : [];
  // One source of truth for the cast: the turn resolves it once, with the corpus own closed class available to cut
  // a relative clause down to its head, and re-deriving it here from the goal text reintroduced the clause
  // ("blacksmith who forgets his own" required in every section). The goal-derived anchors remain the fallback for
  // a caller that resolves no cast at all.
  const persistentEntities = resolvedCast.length
    ? resolvedCast
    : properNounEntityAnchors(input.sectionGoal).slice(0, 3);
  const castTerms = [...new Set([...persistentEntities, ...sectionUnit])];
  const requiredTerms = [...new Set([...castTerms, ...(input.requiredContentTerms ?? [])])];
  // Evidence text is a casing source too, not just the request: a
  // pronoun follow-up ("...a story about her") contains none of the
  // subject's own words, so every name reaching the surface comes from
  // evidence and was rendered lowercase -- "Augusta ada king countess"
  // instead of "Augusta Ada King, Countess" (verified live).
  const properNounCasing = sourceDerivedCasingHints([
    input.requestText,
    input.sectionGoal,
    ...conditioning,
    ...(input.casingSourceTexts ?? [])
  ]);
  // What actually steers a section, recorded: three separate channels (context, required terms, topic vocabulary)
  // can each put request words into prose, and reasoning about them from the outside cost several wrong fixes.
  traceEvent((globalThis as { __sccTrace?: Parameters<typeof traceEvent>[0] }).__sccTrace, {
    stage: "creative.section.inputs",
    label: "kernel.creative",
    counts: { castTerms: castTerms.length, topicVocabulary: (input.topicVocabulary ?? []).length, conditioning: conditioning.length },
    support: {
      sectionGoal: input.sectionGoal,
      goalUnits,
      castTerms,
      resolvedCastIn: input.resolvedCastSubjectIds ?? [],
      requestTextIn: input.requestText,
      topicVocabularySample: (input.topicVocabulary ?? []).slice(0, 16),
      conditioningHeads: conditioning.map(line => line.slice(0, 60))
    }
  });
  const generation = input.languageMemory.generate({
    state: input.state,
    targetLanguageProfile: input.targetLanguageProfile,
    choiceSeed: `${input.sectionGoal}\u0001${Math.max(1, Math.floor(input.attempt ?? 1))}`,
    // Unit symbols, not whole sentences: KN context matching is n-gram-sized.
    //
    // The raw goal used to lead this list, to make each attempt distinct. But contextSymbols IS the n-gram
    // history the generator continues from, so the instruction was the thing being continued: every section
    // opened by realizing the request back ("Sailor leaving harbour to me; for I was now", live 2026-09-12).
    // A sampling seed must perturb sampling, not prepend text to the history, so distinctness now comes from
    // the entity rotation above, and the context is the subject and what previous sections established.
    contextSymbols: [
      // Continuation context is the end of the supplied material, in source
      // order. Taking the longest units from the beginning made a follow-on
      // section restart from an arbitrary vocabulary fingerprint and dropped
      // the actual handoff point. The tail is a structural signal; it does
      // not assume a source language or a lexical ontology.
      ...conditioning.flatMap(line => continuationUnits(line)),
      ...goalUnits
    ],
    frames: [{
      id: "frame:creative-section",
      role: "answer",
      force: "creative",
      narrativeConditioning: input.narrativeConditioning,
      // Whole-sentence atoms would force the output to embed the prompt --
      // which the echo gate forbids. Unit atoms and terms make coverage
      // mean "on topic", and the required-term seed steers the
      // continuation toward them.
      propositionAtoms: castTerms.map((unit, index) => ({
        id: `atom:creative-section:goal:${index}`,
        text: unit,
        kind: "surface",
        weight: 0.9,
        source: "section-plan"
      })),
      // The document's whole cast is a hard requirement of every section,
      // not just the section's own rotated emphasis -- a story keeps its
      // characters, it does not lose them section to section.
      requiredTerms: requiredTerms.map((unit, index) => ({
        id: `term:creative-section:goal:${index}`,
        text: unit,
        weight: 0.9,
        source: "section-plan"
      })),
      topicVocabulary: input.topicVocabulary,
      properNounCasing,
      targetLanguage: input.targetLanguage ?? "",
      targetScript: input.targetScript ?? ""
    }],
    generationExtent: Math.max(48, Math.min(320, Math.floor(input.generationExtent ?? 180)))
  });
  const generationAudit = {
    stoppedBy: generation.stoppedBy,
    symbolCount: generation.symbols.length,
    moveCount: generation.discourse.moves.length,
    averageInformation: generation.averageInformation,
    confidence: generation.confidence,
    rawTextChars: generation.text.length
  };
  const text = generation.text.trim();
  if (!text) return { text: "", accepted: false, reason: "empty-generation", generationAudit };
  if (!languageGenerationSurfaceAdequate(generation)
    || !languageGenerationSentenceEndingsAdequate(text, input.state)) return { text: "", accepted: false, reason: "inadequate-surface", generationAudit };
  if (requiredTerms.some(term => !surfaceContainsTerm(text, term))) {
    return { text: "", accepted: false, reason: "uncovered-content", generationAudit };
  }
  if (surfaceEchoesPrompt(text, input.sectionGoal) || surfaceEchoesPrompt(text, input.requestText)) {
    return { text: "", accepted: false, reason: "prompt-echo", generationAudit };
  }
  return { text, accepted: true, reason: "ok", generationAudit };
}

function stableRotation(value: string): number {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function continuationUnits(text: string): string[] {
  // Preserve source order because these units seed the n-gram history. A
  // length-ranked list is useful for entity discovery, but it is not a valid
  // continuation boundary: it discards which material came last.
  return [...new Set(surfaceUnits(collapseSurfaceWhitespace(text).toLocaleLowerCase()))]
    .filter(unit => unit.length >= 3)
    .slice(-4);
}

/** Preserve a contiguous content segment instead of stitching residual control words into prose. */
export function creativeRequestContentSurface(requestText: string, field?: Pick<TurnRequirementField, "trace">): string {
  if (!field) return requestText;
  const segments = requestSubjectSegments(requestText, field)
    .map(text => text.trim())
    .filter(text => surfaceUnits(text).length > 0);
  return segments.join(" ") || requestText;
}

/** Cast anchors as the corpus names them (identity, then concentration, then content runs); position decides nothing. */
export function properNounEntityAnchors(text: string): string[] {
  return namedSubjectAnchors(text);
}

/** Echo = normalized containment at comparable length, or >=0.8 unit overlap. */
export function surfaceEchoesPrompt(surface: string, prompt: string): boolean {
  const cleanSurface = collapseSurfaceWhitespace(surface).toLocaleLowerCase();
  const cleanPrompt = collapseSurfaceWhitespace(prompt).toLocaleLowerCase();
  if (!cleanSurface || !cleanPrompt) return false;
  if (cleanSurface === cleanPrompt) return true;
  const longer = cleanSurface.length >= cleanPrompt.length ? cleanSurface : cleanPrompt;
  const shorter = cleanSurface.length >= cleanPrompt.length ? cleanPrompt : cleanSurface;
  if (longer.includes(shorter) && longer.length <= shorter.length * 2) return true;
  const surfaceSet = new Set(surfaceUnits(cleanSurface).filter(unit => unit.length >= 3));
  const promptSet = new Set(surfaceUnits(cleanPrompt).filter(unit => unit.length >= 3));
  if (!surfaceSet.size || !promptSet.size) return false;
  let shared = 0;
  for (const unit of surfaceSet) if (promptSet.has(unit)) shared++;
  const union = surfaceSet.size + promptSet.size - shared;
  return union > 0 && shared / union >= 0.8;
}
