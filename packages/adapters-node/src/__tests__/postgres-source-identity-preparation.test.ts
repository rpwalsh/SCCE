// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {afterEach,expect,it} from "vitest";
import {clearSourceTitleCache,createPostgresStorageAdapter,type PostgresStorageAdapter} from "../postgres.js";
const adapters:PostgresStorageAdapter[]=[];
afterEach(async()=>{clearSourceTitleCache();await Promise.all(adapters.splice(0).map(a=>a.close()));});
function deferred<T>(){let resolve!:(v:T)=>void;return{promise:new Promise<T>(r=>{resolve=r;}),get resolve(){return resolve;}};}
function fixture(titles:string[]=["Alpha: Beta","alpha beta","\u6e2f"]){
 const adapter=createPostgresStorageAdapter({url:"postgres://offline.invalid/none",schema:"identity_metadata",informationAccess:{tenantId:"tenant",principalId:"owner",compartments:[],maximumExportClass:"restricted"}});adapters.push(adapter);
 const state={revision:"1",titles,reads:0,queries:[]as Array<{sql:string;params:unknown[]}>,load:undefined as undefined|(()=>Promise<string[]>)};
 adapter.languageMemory.readRevision=async()=>state.revision;
 adapter.query=async<T>(sql:string,params:unknown[]=[])=>{state.queries.push({sql,params});if(!sql.startsWith("SELECT DISTINCT evidence.source_title AS title"))throw Error("unexpected title query");state.reads++;return(await(state.load?.()??Promise.resolve(state.titles))).map(title=>({title}))as T[];};
 return{adapter,state,prepare:()=>adapter.evidence.prepareSourceIdentityMetadata!(),names:(text:string)=>adapter.evidence.sourceIdentityArbitration!({text,runs:[]})};
}
it("prepares the complete unchanged title query once and shares cold in-flight work with ordinary arbitration",async()=>{
 const f=fixture(),pending=deferred<string[]>();f.state.load=()=>pending.promise;
 const preparing=f.prepare(),ordinary=f.names("Alpha Beta");await new Promise(r=>setImmediate(r));expect(f.state.reads).toBe(1);pending.resolve(f.state.titles);
 expect(await preparing).toMatchObject({sourceTitles:2});expect((await ordinary).identities).toEqual(["alpha beta"]);
 await f.prepare();await f.names("\u6e2f");expect(f.state.reads).toBe(1);
 const q=f.state.queries[0]!;expect(q.sql).toContain("WHERE evidence.source_title <> '' AND");expect(q.sql).not.toContain("status");
 for(const key of["tenantId","principals","compartments","exportClass"])expect(q.sql).toContain(key);expect(q.params).toEqual(f.adapter.informationAccessPredicate("evidence",1).params);
});
it("isolates stores and changed effective access even when durable revisions match",async()=>{
 const a=fixture(["alpha"]),b=fixture(["beta"]);expect((await a.names("alpha beta")).identities).toEqual(["alpha"]);expect((await b.names("alpha beta")).identities).toEqual(["beta"]);
 const old=await a.prepare();Object.assign(a.adapter.informationAccess!,{principalId:"other"});a.state.titles=["gamma"];
 const changed=await a.prepare();expect(changed.revision).not.toBe(old.revision);expect((await a.names("alpha gamma")).identities).toEqual(["gamma"]);expect(a.state.reads).toBe(2);expect(b.state.reads).toBe(1);
});
it("propagates a refresh failure instead of serving an old revision and retries the same canonical loader",async()=>{
 const f=fixture(["old"]);await f.prepare();f.state.revision="2";f.state.load=async()=>{throw Error("read failed");};await expect(f.names("old")).rejects.toThrow("read failed");
 f.state.load=undefined;f.state.titles=["new"];expect((await f.names("old new")).identities).toEqual(["new"]);expect(f.state.reads).toBe(3);
});
it("fences a publication during an in-flight read and cannot replace a newer cache with old titles",async()=>{
 const f=fixture(),old=deferred<string[]>();let first=true;f.state.load=async()=>first?(first=false,old.promise):["new"];
 const stale=f.prepare();await new Promise(r=>setImmediate(r));f.state.revision="2";const fresh=await f.prepare();old.resolve(["old"]);expect(await stale).toEqual(fresh);
 expect((await f.names("old new")).identities).toEqual(["new"]);expect(f.state.reads).toBe(2);
});
it("fences cache reset while a loader is pending",async()=>{
 const f=fixture(),old=deferred<string[]>();let first=true;f.state.load=async()=>first?(first=false,old.promise):["new"];
 const stale=f.prepare();await new Promise(r=>setImmediate(r));clearSourceTitleCache();const fresh=await f.prepare();old.resolve(["old"]);expect(await stale).toEqual(fresh);expect(f.state.reads).toBe(2);
});
it("never publishes uncommitted titles, including rollback followed by reuse of the same durable revision",async()=>{
 const f=fixture(["committed"]);let active=false,txTitles:string[]=[],txRevision="1",committedRevision="1",committedTitles=["committed"];
 f.adapter.languageMemory.readRevision=async()=>active?txRevision:committedRevision;
 f.state.load=async()=>f.adapter.sourceIdentityTransactionScope()!==undefined?txTitles:committedTitles;
 const client={query:async(sql:string)=>{if(sql==="BEGIN")active=true;if(sql==="ROLLBACK")active=false;if(sql==="COMMIT"){committedRevision=txRevision;committedTitles=txTitles;active=false;}return{rows:[]};},release:()=>undefined};
 Object.defineProperty(f.adapter.pool,"connect",{value:async()=>client});
 const initial=await f.prepare();let rolledBackRevision="";
 await expect(f.adapter.transaction(async()=>{txTitles=["uncommitted"];txRevision="2";const pending=await f.prepare();rolledBackRevision=pending.revision;expect(pending.revision).not.toBe(initial.revision);throw Error("rollback");})).rejects.toThrow("rollback");
 expect((await f.names("committed uncommitted")).identities).toEqual(["committed"]);
 await f.adapter.transaction(async()=>{txTitles=["legitimate"];txRevision="2";const result=await f.prepare();expect(result.revision).not.toBe(rolledBackRevision);});
 expect((await f.names("committed uncommitted legitimate")).identities).toEqual(["legitimate"]);expect(f.state.reads).toBe(4);
});

it("fences an effective-access change while a title read is in flight",async()=>{
 const f=fixture(),old=deferred<string[]>();let first=true;f.state.load=async()=>first?(first=false,old.promise):["visible-new"];
 const pending=f.prepare();await new Promise(r=>setImmediate(r));Object.assign(f.adapter.informationAccess!,{principalId:"new-owner"});
 const fresh=await f.prepare();old.resolve(["old-private"]);expect(await pending).toEqual(fresh);
 expect((await f.names("old-private visible-new")).identities).toEqual(["visible-new"]);expect(f.state.reads).toBe(2);
});
