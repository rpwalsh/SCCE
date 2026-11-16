// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {readFile} from "node:fs/promises";
import {Pool,type PoolClient} from "pg";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {createPostgresStorageAdapter} from "../postgres.js";

const label={tenantId:"owner.fixture",principals:["reader.fixture"],compartments:[],exportClass:"restricted",mergePolicy:"isolated"};
const adapters:ReturnType<typeof createPostgresStorageAdapter>[]=[];
afterAll(async()=>{await Promise.all(adapters.map(adapter=>adapter.close()));});
async function capture(){
 const adapter=createPostgresStorageAdapter({url:"postgres://unused:unused@127.0.0.1/unused",schema:"fixture",informationAccess:{tenantId:label.tenantId,principalId:"reader.fixture",compartments:[],maximumExportClass:"restricted"}});
 adapters.push(adapter);const calls:Array<{sql:string;params:unknown[]}>=[];
 adapter.query=async<T>(sql:string,params:unknown[]=[])=>{calls.push({sql,params});return[] as T[];};
 expect(await adapter.evidence.sourceVersionsForEvidence([])).toEqual([]);expect(calls).toHaveLength(0);
 await adapter.evidence.sourceVersionsForEvidence(["a","b","a"] as never[]);return calls[0]!;
}
it("deduplicates narrow authorized source identities before exact correlated owner hydration",async()=>{
 const {sql,params}=await capture();
 expect(sql).toContain("evidence_owners AS MATERIALIZED");expect(sql).toContain("SELECT DISTINCT e.source_id,e.source_version_id");
 expect(sql).toContain("e.id=ANY($1::text[])");expect(sql).toContain("sv.id=owner.source_version_id AND sv.source_id=owner.source_id");
 expect(sql).toContain("OFFSET 0");expect(sql).not.toContain("SELECT DISTINCT sv.*");
 expect(sql).toContain("e.information_label");expect(sql).toContain("sv.information_label");expect(sql).not.toContain("status='promoted'");
 expect(params[0]).toEqual(["a","b","a"]);
});
const configPath=process.env.SCCE_MEMBERSHIP_READONLY_CONFIG;
describe.skipIf(!configPath)("read-only source owner production query",()=>{
 let pool:Pool,client:PoolClient;
 beforeAll(async()=>{const config=JSON.parse(await readFile(configPath!,"utf8"));pool=new Pool({connectionString:config.database.url,ssl:config.database.ssl,max:1});
  client=await pool.connect();await client.query("BEGIN READ ONLY");await client.query("SET LOCAL statement_timeout='15s'");expect((await client.query("SHOW transaction_read_only")).rows[0]!.transaction_read_only).toBe("on");});
 afterAll(async()=>{if(client){await client.query("ROLLBACK");client.release();}if(pool)await pool.end();});
 const tables=`evidence_rows AS MATERIALIZED (SELECT * FROM jsonb_to_recordset($10::jsonb) e(id text,source_id text,source_version_id text,status text,information_label jsonb)),
  version_rows AS MATERIALIZED (SELECT * FROM jsonb_to_recordset($11::jsonb) sv(id text,source_id text,metadata_json jsonb,information_label jsonb)),
  source_rows AS MATERIALIZED (SELECT * FROM jsonb_to_recordset($12::jsonb) s(id text,namespace text,canonical_uri text))`;
 function sqlFor(sql:string){return sql.replace("WITH ",`WITH ${tables},`).replaceAll('"fixture"."evidence_spans"',"evidence_rows").replaceAll('"fixture"."source_versions"',"version_rows").replaceAll('"fixture"."sources"',"source_rows");}
 it.each(["none","denied-evidence","denied-version","foreign-source","missing-source","missing-version","quarantined"])("retains exact identity and ACL admission: %s",async damage=>{
  const query=await capture(),evidence=[{id:"a",source_id:"source.a",source_version_id:"version.a",status:"promoted",information_label:label},{id:"b",source_id:"source.a",source_version_id:"version.a",status:"promoted",information_label:label}];
  const versions=[{id:"version.a",source_id:"source.a",metadata_json:{wide:"x".repeat(65536)},information_label:label}],sources=[{id:"source.a",namespace:"fixture",canonical_uri:"fixture:owner"}];
  if(damage==="denied-evidence")for(const row of evidence)row.information_label={...label,tenantId:"denied"};
  if(damage==="denied-version")versions[0]!.information_label={...label,tenantId:"denied"};
  if(damage==="foreign-source")for(const row of evidence)row.source_id="foreign";
  if(damage==="missing-source")sources.pop();if(damage==="missing-version")versions.pop();if(damage==="quarantined")for(const row of evidence)row.status="quarantined";
  const rows=(await client.query(sqlFor(query.sql),[...query.params,JSON.stringify(evidence),JSON.stringify(versions),JSON.stringify(sources)])).rows;
  expect(rows.map(row=>row.id)).toEqual(damage==="none"||damage==="quarantined"?["version.a"]:[]);
  if(rows.length)expect(rows[0]!.metadata_json).toEqual(versions[0]!.metadata_json);
 });
 it("hydrates one full owner per distinct valid identity despite duplicate evidence and duplicate input IDs",async()=>{
  const query=await capture(),evidence=Array.from({length:1024},(_,i)=>({id:`e.${i}`,source_id:i%2?"source.a":"source.b",source_version_id:i%2?"version.a":"version.b",status:"promoted",information_label:label}));
  const versions=["a","b"].map(id=>({id:`version.${id}`,source_id:`source.${id}`,metadata_json:{wide:id.repeat(65536)},information_label:label}));
  const sources=["a","b"].map(id=>({id:`source.${id}`,namespace:"fixture",canonical_uri:`fixture:${id}`}));
  query.params[0]=[...evidence.map(row=>row.id),"e.0","e.0","absent"];
  const params=[...query.params,JSON.stringify(evidence),JSON.stringify(versions),JSON.stringify(sources)],sql=sqlFor(query.sql),rows=(await client.query(sql,params)).rows;
  expect(rows.map(row=>row.id).sort()).toEqual(["version.a","version.b"]);
  expect(rows.map(row=>row.metadata_json.wide).sort()).toEqual(versions.map(row=>row.metadata_json.wide).sort());
  const plan=(await client.query(`EXPLAIN (ANALYZE,FORMAT JSON) ${sql}`,params)).rows[0]["QUERY PLAN"];
  const nodes=(node:any):any[]=>[node,...(node.Plans??[]).flatMap(nodes)],all=nodes(plan[0].Plan);
  const owners=all.find(node=>node["Subplan Name"]==="CTE evidence_owners");expect(owners["Actual Rows"]).toBe(2);
  const versionsRead=all.filter(node=>node["CTE Name"]==="version_rows");expect(versionsRead.length).toBeGreaterThan(0);
  expect(versionsRead.every(node=>node["Actual Loops"]<=2)).toBe(true);
 });
});
