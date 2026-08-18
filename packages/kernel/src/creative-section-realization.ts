import type { LanguageMemoryRuntime, LanguageMemoryRuntimeState } from "./language-memory-runtime.js";
import { languageGenerationSurfaceAdequate } from "./language-memory-runtime.js";
import { normalizePriorKey, splitPriorUnits } from "./kernel-answer-primitives.js";
import { collapseSurfaceWhitespace } from "./surface-linguistics.js";
import type { LanguageProfile } from "./types.js";

export interface CreativeSectionRealizationInput {
  languageMemory: LanguageMemoryRuntime;
  state: LanguageMemoryRuntimeState;
  targetLanguageProfile?: LanguageProfile;
  requestText: string;
  sectionGoal: string;
  narrativeConditioning?: readonly string[];
  generationExtent?: number;
  targetLanguage?: string;
  targetScript?: string;
}

export interface CreativeSectionRealization {
  text: string;
  accepted: boolean;
  reason: "ok" | "empty-generation" | "inadequate-surface" | "prompt-echo";
}

/**
 * Section-scoped creative realization: a DIRECT call into the same
 * overgenerate-and-rank engine the Mouth uses (language-memory-runtime's
 * generate -- sentence plans, clause lattices, discourse beams,
 * Kneser-Ney ranking), invoked at section granularity instead of
 * re-running the Mouth's entire candidate/proof/energy pipeline once per
 * section. Verified live before this existed: a 12-section story spent
 * 509 seconds re-running full turns and returned the request echoed
 * twelve times, because the Mouth's creative fallback echoes the request
 * text when learned realization is inadequate. Here the failure mode is
 * an explicit rejection, never an echo: prompts are never content.
 */
export function realizeCreativeSection(input: CreativeSectionRealizationInput): CreativeSectionRealization {
  const conditioning = (input.narrativeConditioning ?? []).filter(Boolean).slice(0, 6);
  const generation = input.languageMemory.generate({
    state: input.state,
    targetLanguageProfile: input.targetLanguageProfile,
    contextSymbols: [input.sectionGoal, input.requestText, ...conditioning],
    frames: [{
      id: "frame:creative-section",
      role: "point",
      force: "creative",
      propositionAtoms: [
        { id: "atom:creative-section:goal", text: input.sectionGoal, kind: "goal", weight: 0.9, source: "section-plan" },
        ...conditioning.map((line, index) => ({
          id: `atom:creative-section:conditioning:${index}`,
          text: line,
          kind: "narrative-conditioning",
          weight: 0.6,
          source: "narrative-state"
        }))
      ],
      requiredTerms: [],
      targetLanguage: input.targetLanguage ?? "",
      targetScript: input.targetScript ?? ""
    }],
    generationExtent: Math.max(48, Math.min(320, Math.floor(input.generationExtent ?? 180)))
  });
  const text = generation.text.trim();
  if (!text) return { text: "", accepted: false, reason: "empty-generation" };
  if (!languageGenerationSurfaceAdequate(generation)) return { text: "", accepted: false, reason: "inadequate-surface" };
  if (surfaceEchoesPrompt(text, input.sectionGoal) || surfaceEchoesPrompt(text, input.requestText)) {
    return { text: "", accepted: false, reason: "prompt-echo" };
  }
  return { text, accepted: true, reason: "ok" };
}

/**
 * Language-agnostic prompt-echo detection: the surface is an echo when it
 * is (near-)contained in the prompt space -- normalized containment
 * either way at comparable length, or near-total unit overlap. Unit
 * comparison, no word lists.
 */
export function surfaceEchoesPrompt(surface: string, prompt: string): boolean {
  const cleanSurface = collapseSurfaceWhitespace(surface).toLocaleLowerCase();
  const cleanPrompt = collapseSurfaceWhitespace(prompt).toLocaleLowerCase();
  if (!cleanSurface || !cleanPrompt) return false;
  if (cleanSurface === cleanPrompt) return true;
  const longer = cleanSurface.length >= cleanPrompt.length ? cleanSurface : cleanPrompt;
  const shorter = cleanSurface.length >= cleanPrompt.length ? cleanPrompt : cleanSurface;
  if (longer.includes(shorter) && longer.length <= shorter.length * 2) return true;
  const surfaceUnits = new Set(splitPriorUnits(normalizePriorKey(cleanSurface)).filter(unit => unit.length >= 3));
  const promptUnits = new Set(splitPriorUnits(normalizePriorKey(cleanPrompt)).filter(unit => unit.length >= 3));
  if (!surfaceUnits.size || !promptUnits.size) return false;
  let shared = 0;
  for (const unit of surfaceUnits) if (promptUnits.has(unit)) shared++;
  const union = surfaceUnits.size + promptUnits.size - shared;
  return union > 0 && shared / union >= 0.8;
}
