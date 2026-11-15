import {expect,it,vi} from "vitest";
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
