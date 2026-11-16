// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { readWorkspaceOwnedProgramContracts, resolveWorkspaceSourceOwnership, type SourceVersion } from "@scce/kernel";
import { ordinaryWorkspaceProgramFixture } from "./fixtures/ordinary-workspace-program.js";
import { publishWorkspaceOwnedContracts } from "../workspace-owned-contracts.js";

const access={tenantId:"workspace-contract-test",principalId:"owner",compartments:[],maximumExportClass:"restricted" as const};
async function fixture(){
 const root=await mkdtemp(path.join(tmpdir(),"scce-owner-lineage-"));
 const raw=`const marker="${String.fromCodePoint(0x1f9ed)}Cafe\u0301";\r\nexport function first(x:number):number { return x + marker.length; }\r\nexport function second(x:number):number { return first(x*2); }\r\n`;
 await writeFile(path.join(root,"subject.ts"),raw);
 const f=ordinaryWorkspaceProgramFixture(root),ingested=await f.runtime.ingest(root,{maxFiles:5,maxFileBytes:100000});expect(ingested.failed).toBe(0);
 const workspace=(await f.storage.workspace.latestWorkspace())!,records=await f.storage.workspace.listSourceFiles({workspaceId:workspace.id});
 const original=f.versions.find(row=>row.role==="original")!,derivative=f.versions.find(row=>row.role==="evidence-derivative")!;
 expect(original).toBeDefined();expect(derivative).toBeDefined();expect(original.contentHash).not.toBe(derivative.contentHash);
 const context={schema:"scce.workspace.program-context.v1",workspaceId:workspace.id,expectedWorkspaceUpdatedAt:workspace.updatedAt};
 return {...f,root,raw,workspace,records,original,derivative,context,read:()=>readWorkspaceOwnedProgramContracts({storage:f.storage,context,informationAccess:access})};
}
async function cleanup(root:string){
 const resolved=path.resolve(root);if(path.dirname(resolved)!==path.resolve(tmpdir())||!path.basename(resolved).startsWith("scce-owner-lineage-"))throw Error("invalid fixture cleanup target");
 await rm(resolved,{recursive:true,force:true});
}

it("publishes and cold-reads exact original ownership while retaining derivative evidence coordinates and one hash validation per blob",async()=>{
 const f=await fixture();
 try{
  const spans=structuredClone(f.spans),get=vi.spyOn(f.storage.blobs,"get"),lookup=vi.spyOn(f.storage.evidence,"sourceVersionById");
  const read=await f.read();expect(read.status).toBe("available");if(read.status!=="available")throw Error(read.reasonId);
  expect(read.sourceVersionIds).toContain(String(f.original.sourceVersionId));expect(read.sourceVersionIds).not.toContain(String(f.derivative.sourceVersionId));
  const derivedSpans=read.evidence.filter(span=>span.sourceVersionId===f.derivative.sourceVersionId);expect(derivedSpans.length).toBeGreaterThan(0);
  expect(f.spans.some(span=>span.sourceVersionId===f.original.sourceVersionId)).toBe(false);expect(f.spans).toEqual(spans);
  const actual=derivedSpans[0]!;expect(Buffer.from(f.raw,"utf8").subarray(actual.byteStart,actual.byteEnd).toString("utf8")).not.toBe(actual.text);
  for(const version of [f.original,f.derivative])expect(get.mock.calls.filter(([hash])=>hash===version.contentHash)).toHaveLength(1);
  expect(lookup).toHaveBeenCalledTimes(1);
  const receipt=(f.workspace.metadata as Record<string,any>).sourceContracts,projection=JSON.parse(Buffer.from(await f.storage.blobs.get(receipt.blobHash)).toString("utf8"));
  expect(projection.owners).toEqual([expect.objectContaining({sourceVersionId:f.original.sourceVersionId,contentHash:f.original.contentHash,byteLength:Buffer.byteLength(f.raw),
   lineage:{schema:"scce.workspace.source_lineage.v1",targetCoordinateSpace:"original-source-bytes",evidenceCoordinateSpace:"per-source-version-bytes",chains:[expect.objectContaining({evidenceSourceVersionId:f.derivative.sourceVersionId,hops:[expect.objectContaining({sourceVersionId:f.derivative.sourceVersionId,parentSourceVersionId:f.original.sourceVersionId}),expect.objectContaining({sourceVersionId:f.original.sourceVersionId,role:"original"})]})]}})]);
  expect(f.records[0]!.sourceVersionId).toBe(f.original.sourceVersionId);
  expect(await readFile(path.join(f.root,"subject.ts"),"utf8")).toBe(f.raw);
  const allowed=await readWorkspaceOwnedProgramContracts({storage:f.storage,context:f.context,informationAccess:access,sourceVersionAllowlist:[String(f.original.sourceVersionId),String(f.derivative.sourceVersionId)]});expect(allowed.status).toBe("available");
  for(const only of [f.original,f.derivative])expect((await readWorkspaceOwnedProgramContracts({storage:f.storage,context:f.context,informationAccess:access,sourceVersionAllowlist:[String(only.sourceVersionId)]})).status).toBe("unavailable");
  get.mockClear();
  const bindings=await resolveWorkspaceSourceOwnership({storage:f.storage,records:f.records,verifyBytes:false});
  expect(get).not.toHaveBeenCalled();expect(bindings.get("subject.ts")).toMatchObject({verificationLevel:"metadata"});
  expect(bindings.get("subject.ts")!.sourceBytes).toBeUndefined();
  expect(await publishWorkspaceOwnedContracts({storage:f.storage,workspace:{...f.workspace,metadata:{}},root:f.root,records:f.records,bindings,complete:true,maxFileBytes:100000})).toMatchObject({status:"compiled"});
  for(const version of [f.original,f.derivative])expect(get.mock.calls.filter(([hash])=>hash===version.contentHash)).toHaveLength(1);
  expect(f.spans).toEqual(spans);
 }finally{await cleanup(f.root);}
});

it("keeps unchanged derivative-owned reingestion free of blob reads, retraining and publication",async()=>{
 const f=await fixture();
 try{
  const spans=structuredClone(f.spans),versions=structuredClone(f.versions),get=vi.spyOn(f.storage.blobs,"get"),put=vi.spyOn(f.storage.blobs,"put"),ingest=vi.spyOn(f.kernel,"ingest");
  for(let replay=0;replay<2;replay++)expect((await f.runtime.ingest(f.root,{maxFiles:5,maxFileBytes:100000})).sourceContracts).toMatchObject({status:"current"});
  expect(get).not.toHaveBeenCalled();expect(put).not.toHaveBeenCalled();expect(ingest).not.toHaveBeenCalled();
  expect(f.spans).toEqual(spans);expect(f.versions).toEqual(versions);
 }finally{await cleanup(f.root);}
});

it.each(["missing-parent","cycle","foreign-source","foreign-uri","foreign-path","label","raw-blob","derivative-blob","length","span-coordinate","span-content"] as const)("refuses %s in both producer and reader without creating original evidence",async kind=>{
 const f=await fixture();
 try{
  expect((await f.read()).status).toBe("available");
  const declared=await resolveWorkspaceSourceOwnership({storage:f.storage,records:f.records});
  const leaf=f.derivative as SourceVersion;
  if(kind==="missing-parent")leaf.derivation!.derivedFromSourceVersionId="missing" as never;
  if(kind==="cycle")leaf.derivation!.derivedFromSourceVersionId=leaf.sourceVersionId;
  if(kind==="foreign-source")leaf.sourceId="foreign-owner" as never;
  if(kind==="foreign-uri")leaf.canonicalUri="unrelated.ts";
  if(kind==="foreign-path")(leaf.metadata as any).workspaceFile.path="unrelated.ts";
  if(kind==="label")leaf.informationLabel={...leaf.informationLabel!,principals:["someone-else"]};
  if(kind==="length")leaf.byteLength++;
  if(kind==="raw-blob"||kind==="derivative-blob"){
   const target=kind==="raw-blob"?f.original:leaf,read=f.storage.blobs.get.bind(f.storage.blobs);
   f.storage.blobs.get=async hash=>hash===target.contentHash?new Uint8Array(target.byteLength):read(hash);
  }
  const span=f.spans.find(row=>row.sourceVersionId===leaf.sourceVersionId)!;
  if(kind==="span-coordinate")span.byteEnd=leaf.byteLength+1;
  if(kind==="span-content")span.text="forged text";
  const afterTampering=structuredClone(f.spans);
  expect((await f.read()).status).toBe("unavailable");
  expect(await publishWorkspaceOwnedContracts({storage:f.storage,workspace:{...f.workspace,metadata:{}},root:f.root,records:f.records,bindings:declared,complete:true,maxFileBytes:100000})).toMatchObject({status:"unavailable"});
  expect(f.spans).toEqual(afterTampering);expect(f.spans.some(row=>row.sourceVersionId===f.original.sourceVersionId)).toBe(false);
  expect(await readFile(path.join(f.root,"subject.ts"),"utf8")).toBe(f.raw);
 }finally{await cleanup(f.root);}
});
