// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type {DurableLanguageConstructionBundle} from "./language-construction-memory.js";
import type {ProgramExpression} from "./program-transformation-search.js";

export const SOURCE_COMPUTATION_CONSTRUCTION_SCHEMA="scce.source_owned_computation_construction.v1" as const;
export const SOURCE_COMPUTATION_CONSTRUCTION_RECIPE="kernel.dialogue_computation_construction.v1" as const;
export const SOURCE_COMPUTATION_SOURCE_SYSTEM="dialogue" as const;

export interface SourceComputationSpan {
 startCodePoint:number;
 endCodePoint:number;
 surfaceDigest:string;
}
export interface SourceComputationWitness {
 sourceId:string;
 sourceVersionId:string;
 profileId:string;
 evidenceId:string;
 contentHash:string;
 request:SourceComputationSpan;
 reply:SourceComputationSpan;
 arguments:readonly {slotIndex:number;startCodePoint:number;endCodePoint:number;surface:string}[];
 resultText:string;
 verificationRole:"fit"|"held_out";
}
/** A measured question form owns its numeric ports; an independently checked source program owns the result. */
export interface SourceComputationConstruction {
 schema:typeof SOURCE_COMPUTATION_CONSTRUCTION_SCHEMA;
 componentRecipe:typeof SOURCE_COMPUTATION_CONSTRUCTION_RECIPE;
 sourceSystem:typeof SOURCE_COMPUTATION_SOURCE_SYSTEM;
 sourceId:string;
 sourceVersionId:string;
 profileId:string;
 bindingId:string;
 inputConstruction:DurableLanguageConstructionBundle;
 expression:ProgramExpression;
 witnesses:readonly SourceComputationWitness[];
 contentDigest:string;
}
