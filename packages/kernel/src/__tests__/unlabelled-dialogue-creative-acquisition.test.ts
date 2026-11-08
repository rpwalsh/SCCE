// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {readFileSync} from "node:fs";
import {it,expect} from "vitest";
import {createClock,createHasher} from "../primitives.js";
import {createIdFactory} from "../ids.js";
import {createLanguageAcquisitionEngine} from "../language.js";
import {createLanguageMemoryRuntime} from "../language-memory-runtime.js";
import {compileLanguageTrainingBatch} from "../language-training-batch.js";
import {compileCreativeRequestFrameFromCompatibilityModels,sourceObservedRequestAuthority} from "../creative-event-compatibility.js";
import {projectRequestAuthority} from "../request-authority.js";
import {deriveTurnRequirementField} from "../turn-requirements.js";
import type {TranscriptTurn} from "../dialogue-communicative-act-learning.js";
import type {EvidenceSpan} from "../types.js";
const source=JSON.parse(readFileSync(new URL("./fixtures/oasst-human-russian-creative-pair.json",import.meta.url),"utf8")) as {text:string;turns:TranscriptTurn[]};
const hasher=createHasher(),ids=createIdFactory({hasher,clock:createClock({fixedTime:1}),deterministicReplay:true});
const evidence={id:"evidence.genuine.human",sourceId:"source.genuine.human",sourceVersionId:ids.sourceVersionId(source.text),contentHash:ids.contentHash(source.text),charStart:0,charEnd:[...source.text].length,text:source.text,status:"promoted"} as unknown as EvidenceSpan;
const profile=createLanguageAcquisitionEngine({idFactory:ids}).acquire({sourceVersionId:evidence.sourceVersionId,text:source.text,createdAt:1});
const turns=source.turns.map(({requestAuthority:_annotation,...turn})=>turn);
function compile(input:readonly TranscriptTurn[]){return compileLanguageTrainingBatch({runtime:createLanguageMemoryRuntime({hasher,idFactory:ids}),hasher,batch:{streamId:"fixture://original-human-oasst",sourceSystem:"dialogue",profile,sourceVersionId:evidence.sourceVersionId,text:source.text,evidence:[evidence],transcriptTurns:input,createdAt:1,retainNgramObservations:false}});}
it("retains exact human conversation correspondences without inventing source creative authority",()=>{
 const compiled=compile(turns),rows=compiled.patterns.filter(row=>(row.patternJson as any).schema==="scce.creative_event_compatibility_model.v1");expect(rows.length).toBeGreaterThan(0);
 const runtime=createLanguageMemoryRuntime({hasher,idFactory:ids}),cold=runtime.hydrate({models:[],patterns:JSON.parse(JSON.stringify(compiled.patterns)),constructionEvidence:[evidence]});
 const requestText=turns[0]!.surface.replace("\u0421\u043f\u0430\u043d\u0447","\u041a\u0432\u0430\u0440\u0442\u0443\u043d");
 const frame=compileCreativeRequestFrameFromCompatibilityModels({requestText,models:cold.creativeEventCompatibilityModels,hasher});expect(frame).toBeDefined();expect(sourceObservedRequestAuthority(frame)).toBeUndefined();
 const requirementField=deriveTurnRequirementField({requestText});expect(projectRequestAuthority({requirementField,sourceRequestFrame:frame}).requestedAuthority).toBe(projectRequestAuthority({requirementField}).requestedAuthority);
 expect(projectRequestAuthority({requirementField,sourceRequestFrame:frame,explicitAuthority:"creative"}).requestedAuthority).toBe("creative");
 expect(cold.creativeEventCompatibilityModels.every(model=>model.reliability!=="source_observed"||model.sourceObservations.every(row=>row.request.sourceAuthority==="unknown"))).toBe(true);
 const updated=runtime.hydrate({models:[],patterns:compiled.patterns,constructionEvidence:[{...evidence,sourceVersionId:ids.sourceVersionId("replacement source")}]});expect(compileCreativeRequestFrameFromCompatibilityModels({requestText,models:updated.creativeEventCompatibilityModels,hasher})).toBeUndefined();
 const revoked=runtime.hydrate({models:[],patterns:compiled.patterns,constructionEvidence:[{...evidence,status:"quarantined"}]});expect(compileCreativeRequestFrameFromCompatibilityModels({requestText,models:revoked.creativeEventCompatibilityModels,hasher})).toBeUndefined();
});
it("does not turn an explicitly factual source request into a creative source program",()=>{
 const factual=turns.map(turn=>turn.index===0?{...turn,requestAuthority:"factual" as const}:turn);expect(compile(factual).patterns.filter(row=>(row.patternJson as any).schema==="scce.creative_event_compatibility_model.v1")).toEqual([]);
});
