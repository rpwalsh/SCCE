// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {expect,it,vi} from "vitest";
import {readFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {PostgresStorageAdapter} from "../postgres.js";

it("reserves workspace actions with one revision- and policy-bound conditional update",async()=>{
 const store=new PostgresStorageAdapter({url:"postgres://offline.invalid/none",schema:"fixture"});
 try{
  const query=vi.spyOn(store,"query").mockResolvedValue([{id:"workspace.test"}]);
  const input={workspaceId:"workspace.test",expectedWorkspaceUpdatedAt:1200,policyId:"workspace_action_pinned",maxCalls:2};
  expect(await store.workspace.claimActionCall!(input)).toBe(true);
  expect(query).toHaveBeenCalledTimes(1);
  const [sql,params]=query.mock.calls[0]!;
  expect(sql).toMatch(/^UPDATE /u);expect(sql).toContain("updated_at=TO_TIMESTAMP($2/1000.0)");expect(sql).toContain("'actionPolicies'->$3::text->>'maxCalls'");expect(sql).toContain("< $5".replace(" ",""));expect(sql).toContain("RETURNING id");
  expect(params).toEqual([input.workspaceId,1200,input.policyId,`${input.policyId}:1200`,2]);
  query.mockResolvedValue([]);expect(await store.workspace.claimActionCall!(input)).toBe(false);
  query.mockResolvedValue([{id:"workspace.test"}]);
  expect(await store.workspace.registerActionPolicy!({workspaceId:input.workspaceId,expectedWorkspaceUpdatedAt:1200,policyId:input.policyId,policy:{maxCalls:2}})).toBe(true);
  const registration=query.mock.calls.at(-1)![0];expect(registration).toContain("jsonb_set(metadata_json,'{actionPolicies}'");expect(registration).not.toContain("SET metadata_json=$");
 }finally{await store.close();}
});

it.skipIf(!process.env.SCCE_LIVE_CONFIG_PATH)("preserves quota and policy identity in PostgreSQL through idempotent registration and rollback",async()=>{
 const config=JSON.parse(await readFile(process.env.SCCE_LIVE_CONFIG_PATH!,"utf8"));
 const store=new PostgresStorageAdapter({...config.database,informationAccess:config.security?.informationAccess});
 const id=`workspace.quota-qualification.${randomUUID()}`,updatedAt=Date.now(),policyId="workspace_action_qualification";
 const rollback=new Error("qualification rollback");
 try{
  await expect(store.transaction(async()=>{
   await store.workspace.putWorkspace({id,rootPath:process.cwd(),rootUri:`qualification://${id}`,corpusId:id,status:"archived",metadata:{},createdAt:updatedAt,updatedAt});
   const registration={workspaceId:id,expectedWorkspaceUpdatedAt:updatedAt,policyId,policy:{maxCalls:2}};
   const call={workspaceId:id,expectedWorkspaceUpdatedAt:updatedAt,policyId,maxCalls:2};
   expect(await store.workspace.registerActionPolicy!(registration)).toBe(true);
   expect(await store.workspace.claimActionCall!(call)).toBe(true);
   expect(await store.workspace.registerActionPolicy!(registration)).toBe(true);
   expect(await store.workspace.registerActionPolicy!({...registration,policy:{maxCalls:3}})).toBe(false);
   expect(await store.workspace.claimActionCall!({...call,expectedWorkspaceUpdatedAt:updatedAt+1})).toBe(false);
   expect(await store.workspace.claimActionCall!({...call,maxCalls:3})).toBe(false);
   expect(await store.workspace.claimActionCall!(call)).toBe(true);
   expect(await store.workspace.claimActionCall!(call)).toBe(false);
   expect((await store.workspace.getWorkspace(id))?.metadata).toMatchObject({actionPolicies:{[policyId]:{maxCalls:2}},actionPolicyUsage:{[`${policyId}:${updatedAt}`]:2}});
   throw rollback;
  })).rejects.toBe(rollback);
  expect(await store.workspace.getWorkspace(id)).toBeNull();
 }finally{await store.close();}
});
