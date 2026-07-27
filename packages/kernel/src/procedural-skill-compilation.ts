import type { JsonValue } from "./types.js";

/**
 * Plan items 215-216. Compiles repeatedly-successful action-type sequences
 * (the same real episode-trace shape `induced-reasoning-operator.ts`
 * already inducts patterns from) into a typed, directly executable
 * "skill" -- preconditions/postconditions/authority/cost/rollback -- and
 * runs it purely from that typed program. `executeSkill` never touches
 * the original episodes' conversational text at all: the executor
 * interface it calls receives only a `SkillStep`'s typed `actionType` (and
 * whatever typed `input` the skill declares), never a raw string pulled
 * from history.
 */

export interface SkillStep {
  actionType: string;
  input: JsonValue;
}

export interface CompiledSkill {
  id: string;
  steps: SkillStep[];
  preconditions: string[];
  postconditions: string[];
  authority: string;
  cost: number;
  rollbackSteps?: SkillStep[];
  sourceEpisodeIds: string[];
}

export interface ProceduralEpisodeTrace {
  episodeId: string;
  steps: SkillStep[];
  succeeded: boolean;
}

export interface CompileSkillInput {
  episodes: readonly ProceduralEpisodeTrace[];
  minimumSuccessCount: number;
  authority: string;
  cost: number;
  preconditions?: readonly string[];
  postconditions?: readonly string[];
  rollbackSteps?: readonly SkillStep[];
}

function stepKey(steps: readonly SkillStep[]): string {
  return steps.map(step => `${step.actionType}:${JSON.stringify(step.input)}`).join("|");
}

/**
 * Compiles a skill only from episodes that (a) actually succeeded and (b)
 * repeat the exact same typed step sequence at least `minimumSuccessCount`
 * times -- a single successful episode, however clean, is never enough on
 * its own (that is `induced-reasoning-operator.ts`'s held-out-gain concern
 * one layer up; this module's own minimum is the floor beneath that).
 */
export function compileSkillFromEpisodes(input: CompileSkillInput): CompiledSkill | undefined {
  const successful = input.episodes.filter(episode => episode.succeeded && episode.steps.length > 0);
  const groups = new Map<string, { steps: SkillStep[]; episodeIds: string[] }>();
  for (const episode of successful) {
    const key = stepKey(episode.steps);
    const existing = groups.get(key);
    if (existing) existing.episodeIds.push(episode.episodeId);
    else groups.set(key, { steps: episode.steps, episodeIds: [episode.episodeId] });
  }
  const candidates = [...groups.values()].filter(group => group.episodeIds.length >= input.minimumSuccessCount);
  if (!candidates.length) return undefined;
  candidates.sort((left, right) => right.episodeIds.length - left.episodeIds.length || stepKey(left.steps).localeCompare(stepKey(right.steps)));
  const winner = candidates[0]!;
  return {
    id: `skill.${stepKey(winner.steps).replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 80)}`,
    steps: winner.steps,
    preconditions: [...(input.preconditions ?? [])],
    postconditions: [...(input.postconditions ?? [])],
    authority: input.authority,
    cost: input.cost,
    ...(input.rollbackSteps ? { rollbackSteps: [...input.rollbackSteps] } : {}),
    sourceEpisodeIds: [...winner.episodeIds].sort()
  };
}

export interface SkillStepResult {
  actionType: string;
  ok: boolean;
  output?: JsonValue;
}

export interface SkillExecutionResult {
  skillId: string;
  ok: boolean;
  stepResults: SkillStepResult[];
  rolledBack: boolean;
}

export interface SkillExecutionContext {
  /** Receives only a step's typed actionType/input -- never the source episodes' original text. */
  executeStep(step: SkillStep): { ok: boolean; output?: JsonValue };
}

/**
 * Runs a compiled skill purely from its typed `steps` program. Stops and
 * (if a rollback program exists) runs it in reverse order the moment any
 * step fails -- it never falls back to replaying the original
 * conversational text the skill was compiled from (this module has no
 * access to that text at all, by construction: `CompiledSkill` never
 * stores it).
 */
export function executeSkill(skill: CompiledSkill, context: SkillExecutionContext): SkillExecutionResult {
  const stepResults: SkillStepResult[] = [];
  let ok = true;
  for (const step of skill.steps) {
    const result = context.executeStep(step);
    stepResults.push({ actionType: step.actionType, ok: result.ok, ...(result.output !== undefined ? { output: result.output } : {}) });
    if (!result.ok) { ok = false; break; }
  }
  let rolledBack = false;
  if (!ok && skill.rollbackSteps?.length) {
    for (const step of [...skill.rollbackSteps].reverse()) context.executeStep(step);
    rolledBack = true;
  }
  return { skillId: skill.id, ok, stepResults, rolledBack };
}
