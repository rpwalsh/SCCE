// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type {ScceStorage} from "./storage.js";
import type {Hasher} from "./types.js";
import {SOURCE_COMPUTATION_CONSTRUCTION_SCHEMA,SOURCE_COMPUTATION_SOURCE_SYSTEM} from "./source-owned-computation.js";
import {verifySourceComputationConstruction,evaluateSourceComputationRequest,sourceComputationPatternMatchesQuestion,sourceComputationBindingIdForRequest,type VerifiedSourceComputation,type VerifiedSourceComputationResult} from "./source-computation-acquisition.js";

const coldCaches=new WeakMap<ScceStorage,{generation:number;bindings:Map<string,Map<string,VerifiedSourceComputation>>}>();

/** Durable admission owns ACL/current-source guards; the cold verifier independently owns exact source bytes and the learned program. */
export async function sourceComputationForRequest(input:{storage:ScceStorage;hasher:Hasher;requestText:string;sourceVersionAllowlist?:readonly string[];generation?:number}):Promise<VerifiedSourceComputationResult|undefined>{
 const bindingId=sourceComputationBindingIdForRequest(input.requestText,input.hasher);if(!bindingId)return undefined;
 const current=await input.storage.languageMemory.listLanguagePatterns({patternSchemas:[SOURCE_COMPUTATION_CONSTRUCTION_SCHEMA],sourceSystem:SOURCE_COMPUTATION_SOURCE_SYSTEM,sourceComputationBindingId:bindingId});
 const patterns=current.filter(pattern=>sourceComputationPatternMatchesQuestion(pattern,input.requestText));
 let cache=input.generation===undefined?undefined:coldCaches.get(input.storage);
 if(!patterns.length){if(cache?.generation!==input.generation)coldCaches.delete(input.storage);else cache?.bindings.delete(bindingId);return undefined;}
 if(input.generation!==undefined&&cache?.generation!==input.generation){cache={generation:input.generation,bindings:new Map()};coldCaches.set(input.storage,cache);}
 const entries=cache?.bindings.get(bindingId)??new Map<string,VerifiedSourceComputation>();if(cache)cache.bindings.set(bindingId,entries);
 const currentIds=new Set(current.map(pattern=>pattern.id));for(const id of entries.keys())if(!currentIds.has(id))entries.delete(id);
 const cold=patterns.filter(pattern=>!entries.has(pattern.id));
 const evidenceIds=[...new Set(cold.flatMap(pattern=>pattern.evidenceIds))],evidence=evidenceIds.length?await input.storage.evidence.getEvidenceBatch(evidenceIds):[];
 const allowed=input.sourceVersionAllowlist?new Set(input.sourceVersionAllowlist):undefined;
 const admitted=evidence.filter(span=>!allowed||allowed.has(String(span.sourceVersionId)));
 const constructions=patterns.flatMap(pattern=>{const verified=entries.get(pattern.id)??verifySourceComputationConstruction({pattern,evidence:admitted,hasher:input.hasher});if(!verified||allowed&&verified.artifact.witnesses.some(witness=>!allowed.has(witness.sourceVersionId)))return [];entries.set(pattern.id,verified);return [verified];});
 return evaluateSourceComputationRequest({requestText:input.requestText,constructions,hasher:input.hasher});
}
