// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {afterAll,expect,it} from "vitest";
import {CAPABILITY_CONSTRUCTION_SCHEMA,SOURCE_REQUEST_EDIT_SCHEMA,type LanguageMemoryStore} from "@scce/kernel";
import {createPostgresStorageAdapter} from "../postgres.js";
type Query=Parameters<LanguageMemoryStore["listLanguagePatterns"]>[0];
const adapters:ReturnType<typeof createPostgresStorageAdapter>[]=[];
afterAll(async()=>{await Promise.all(adapters.map(adapter=>adapter.close()));});
function fixture(owners:Array<{profile_id:string;source_system:string|null}>=[]){
 const adapter=createPostgresStorageAdapter({url:"postgres://unused:unused@127.0.0.1/unused",schema:"typed_scope",informationAccess:{tenantId:"owner",principalId:"reader",compartments:[],maximumExportClass:"restricted"}});
 adapters.push(adapter);const calls:Array<{sql:string;params:unknown[]}>=[];
 adapter.query=async<T>(sql:string,params:unknown[]=[])=>{calls.push({sql,params});return(sql.startsWith("SELECT DISTINCT pattern.profile_id,pattern.source_system")?owners:[])as T[];};return{adapter,calls};
}
const scopes:Array<[string,Query]>=[
 ["exact capability schema",{patternSchemas:[CAPABILITY_CONSTRUCTION_SCHEMA]}],
 ["source edit features",{sourceEditRequestFeatures:["lex:what"]}],
 ["requirement features",{requestRequirementFeatures:[{anchor:"any",surface:"opaque"}]}],
 ["unknown explicit schema",{patternSchemas:["fixture.unknown.v1"]}]
];
it.each(scopes)("skips all compilation/body reads when the complete authorized %s candidate set is empty",async(_name,query)=>{
 const {adapter,calls}=fixture();expect(await adapter.languageMemory.listLanguagePatterns({...query,limit:512,maxTotalJsonBytes:8388608,requireComplete:true})).toEqual([]);
 expect(calls).toHaveLength(1);const call=calls[0]!;
 expect(call.sql).toContain("SELECT DISTINCT pattern.profile_id,pattern.source_system");
 for(const field of["tenantId","principals","compartments","exportClass"])expect(call.sql).toContain(`pattern.information_label->${field==="tenantId"||field==="exportClass"?">":""}'${field}'`);
 expect(call.sql).not.toMatch(/LIMIT|ORDER BY.*support|pattern_json AS/iu);
});
it.each(scopes)("limits compilation and projection proofs to every exact authorized %s owner without ranking first",async(_name,query)=>{
 const owners=[{profile_id:"Profile.opaque",source_system:"workspace"},{profile_id:"profile.opaque",source_system:null}],{adapter,calls}=fixture(owners);
 await adapter.languageMemory.listLanguagePatterns({...query,limit:512,maxTotalJsonBytes:8388608,requireComplete:true});
 const discovery=calls[0]!,compilation=calls.find(call=>call.sql.includes("AS model_metadata"))!,body=calls.find(call=>call.sql.includes("candidate_pool AS MATERIALIZED"))!;
 expect(discovery.sql).not.toContain("LIMIT");expect(compilation).toBeDefined();expect(body).toBeDefined();
 expect(JSON.parse(compilation.params[0] as string)).toEqual(owners.map(row=>({profileId:row.profile_id,sourceSystem:row.source_system})));
 expect(compilation.sql).toContain('model.profile_id=requested_owner."profileId"');expect(compilation.sql).toContain('model.source_system IS NOT DISTINCT FROM requested_owner."sourceSystem"');
 expect(compilation.sql).toContain("OFFSET 0");
 for(const alias of["model","profile","version"])expect(compilation.sql).toContain(`${alias}.information_label`);
 expect(body.sql).toContain("pattern.has_source_compilation");expect(body.sql).toContain('current_compilation."compilationId"=pattern.source_compilation_id');
 expect(body.sql).toContain('current_compilation."sourceVersionId"=pattern.owned_source_version_id');
});
it.each([{}, {sourceSystem:"workspace"}, {view:"request_seed" as const}])("retains unfiltered/default compilation and NULL-schema inventory scope: %j",async query=>{
 const {adapter,calls}=fixture();await adapter.languageMemory.listLanguagePatterns({...query,limit:8});
 expect(calls.some(call=>call.sql.startsWith("SELECT DISTINCT pattern.profile_id,pattern.source_system"))).toBe(false);
 const compilation=calls.find(call=>call.sql.includes("AS model_metadata"))!,body=calls.find(call=>call.sql.includes("candidate_pool AS MATERIALIZED"))!;
 expect(compilation.sql).not.toContain('requested_owner("profileId"');expect(body.sql).toContain("pattern.pattern_schema IS NULL");
});
it("recomputes a changed authorized owner scope and does not retain empty state across fresh canonical readers",async()=>{
 const owners:Array<{profile_id:string;source_system:string|null}>=[],{adapter,calls}=fixture(owners);
 const query={patternSchemas:[SOURCE_REQUEST_EDIT_SCHEMA],limit:512,maxTotalJsonBytes:8388608,requireComplete:true};
 expect(await adapter.languageMemory.listLanguagePatterns(query)).toEqual([]);expect(calls).toHaveLength(1);
 owners.push({profile_id:"profile.newly-visible",source_system:"workspace"});
 expect(await adapter.languageMemory.listLanguagePatterns(query)).toEqual([]);expect(calls).toHaveLength(4);
 expect(JSON.parse(calls[2]!.params[0] as string)).toEqual([{profileId:"profile.newly-visible",sourceSystem:"workspace"}]);
 const fresh=fixture(owners);expect(await fresh.adapter.languageMemory.listLanguagePatterns(query)).toEqual([]);
 expect(fresh.calls).toHaveLength(3);expect(fresh.calls[0]!.sql).toMatch(/^SELECT DISTINCT pattern\.profile_id,pattern\.source_system/u);
});
