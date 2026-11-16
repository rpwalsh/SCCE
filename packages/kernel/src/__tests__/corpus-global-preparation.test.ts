// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {afterEach,expect,it} from "vitest";
import {clearCorpusIdentitySignals,concentrationThreshold,corpusIdentitySignals} from "../corpus-identity.js";
import {prepareCorpusIdentityMetadata,primeCorpusIdentityForTurn,measureRequestCorpusSubject,resetCorpusIdentityMeasurements} from "../corpus-identity-runtime.js";
import type {EvidenceStore} from "../storage.js";
afterEach(()=>{resetCorpusIdentityMeasurements();clearCorpusIdentitySignals();});
function deferred<T>(){let resolve!:(v:T)=>void;return{promise:new Promise<T>(r=>{resolve=r;}),get resolve(){return resolve;}};}
function fixture(){
 const state={revision:"1",titles:1,identity:"alpha",distribution:[1,1,100,100],titleReads:0,distributionReads:0,arbitrationReads:0,samples:[]as number[]};
 const evidence:Pick<EvidenceStore,"readSourceIdentityRevision"|"prepareSourceIdentityMetadata"|"sourceIdentityArbitration"|"sourceSpreadDistribution">={
  readSourceIdentityRevision:async()=>state.revision,
  prepareSourceIdentityMetadata:async()=>{state.titleReads++;return{revision:state.revision,sourceTitles:state.titles};},
  sourceSpreadDistribution:async sample=>{state.distributionReads++;state.samples.push(sample);return state.distribution;},
  sourceIdentityArbitration:async()=>{state.arbitrationReads++;return{identities:[state.identity],spread:new Map([[state.identity,1]])};}
 };return{state,evidence};
}
it("prepares independent title metadata and the exact400-sample threshold concurrently without priming a request",async()=>{
 const f=fixture(),titles=deferred<{revision:string;sourceTitles:number}>(),distribution=deferred<number[]>();let titleStarted=false,distributionStarted=false;
 f.evidence.prepareSourceIdentityMetadata=async()=>{f.state.titleReads++;titleStarted=true;return titles.promise;};
 f.evidence.sourceSpreadDistribution=async sample=>{f.state.distributionReads++;f.state.samples.push(sample);distributionStarted=true;return distribution.promise;};
 const pending=prepareCorpusIdentityMetadata(f.evidence);await new Promise(r=>setImmediate(r));expect(titleStarted&&distributionStarted).toBe(true);expect(corpusIdentitySignals()).toBeUndefined();
 titles.resolve({revision:"1",sourceTitles:1});distribution.resolve(f.state.distribution);
 expect(await pending).toEqual({sourceTitles:1,concentration:concentrationThreshold(f.state.distribution,100)});expect(f.state.samples).toEqual([400]);expect(f.state.arbitrationReads).toBe(0);
 await primeCorpusIdentityForTurn({requestText:"alpha",closedClass:new Set(),evidence:f.evidence});
 expect(f.state.distributionReads).toBe(1);expect(f.state.titleReads).toBe(1);expect(corpusIdentitySignals()?.identities).toEqual(new Set(["alpha"]));
 expect(corpusIdentitySignals()?.concentration).toBe(concentrationThreshold(f.state.distribution,100));
});
it("reports a failed preparation and retries the unchanged threshold measurement",async()=>{
 const f=fixture();let first=true;f.evidence.sourceSpreadDistribution=async sample=>{f.state.samples.push(sample);if(first){first=false;throw Error("unavailable");}return f.state.distribution;};
 await expect(prepareCorpusIdentityMetadata(f.evidence)).rejects.toThrow("spread distribution preparation failed");expect(corpusIdentitySignals()).toBeUndefined();await prepareCorpusIdentityMetadata(f.evidence);expect(f.state.samples).toEqual([400,400]);
});
it("rechecks durable revisions before direct preturn subject cache hits and isolates other stores",async()=>{
 const a=fixture(),b=fixture();b.state.identity="beta";
 expect((await measureRequestCorpusSubject({requestText:"alpha beta",evidence:a.evidence})).identities).toEqual(["alpha"]);
 expect((await measureRequestCorpusSubject({requestText:"alpha beta",evidence:b.evidence})).identities).toEqual(["beta"]);
 a.state.revision="2";a.state.identity="beta";expect((await measureRequestCorpusSubject({requestText:"alpha beta",evidence:a.evidence})).identities).toEqual(["beta"]);
 expect(a.state.arbitrationReads).toBe(2);expect(b.state.arbitrationReads).toBe(1);
});
it("cannot let an old preparation threshold overwrite a newer publication",async()=>{
 const f=fixture(),old=deferred<number[]>();let first=true;
 f.evidence.sourceSpreadDistribution=async()=>{f.state.distributionReads++;return first?(first=false,old.promise):[3,3,300,300];};
 const stale=prepareCorpusIdentityMetadata(f.evidence);await new Promise(r=>setImmediate(r));f.state.revision="2";const fresh=await prepareCorpusIdentityMetadata(f.evidence);old.resolve([1,1,100,100]);expect(await stale).toEqual(fresh);
 await primeCorpusIdentityForTurn({requestText:"alpha",closedClass:new Set(),evidence:f.evidence});expect(corpusIdentitySignals()?.concentration).toBe(concentrationThreshold([3,3,300,300],300));expect(f.state.distributionReads).toBe(2);
});
