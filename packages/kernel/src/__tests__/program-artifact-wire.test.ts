// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {it,expect} from "vitest";
import {readFile} from "node:fs/promises";
import {createHasher,encodeProgramArtifactWire,decodeProgramArtifactWire,FILE_ARTIFACT_CONTENT_REF_SCHEMA} from "../index.js";
const hash=(content:string)=>`sha256_${createHasher().digestHex(content)}`;
const artifact=(name:string,content:string)=>({artifactId:`artifact:${name}`,path:name,mediaType:"text/javascript",role:"source",contentHash:hash(content),content});
const cold=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T;
function fixture(){
 const final=artifact("final.mjs",`export const value=41;/*${"\u03bb\ud83e\udded".repeat(90000)}*/`),probe=artifact("final.mjs","export const value=null;"),only=artifact("attempt-only.txt","opaque independent probe file");
 const build={code:0,stdout:"complete output",stderr:"complete diagnostic",durationMs:31};
 return {programArtifacts:[final],buildTest:{artifacts:[final],passed:true,repairApplied:true,repairAttempted:true,build,test:build,
  testExecutionReceipt:{status:"executed",command:"node",args:["--test","test/program.mjs"],cwd:"."},
  attempts:[{build,test:build,artifacts:[probe,only]},{build,test:build,artifacts:[final]}]},
  events:[{id:"event.owned",hash:"original-payload-ledger-hash",parents:["parent.exact"],payload:{result:{artifacts:[final,probe]},inputHash:"input.exact",ownerId:"owner.exact"}}]};
}
it("transports every content once without changing final files, attempts, events, receipts or Unicode",()=>{
 const original=fixture(),before=Buffer.byteLength(JSON.stringify(original));expect(before).toBeGreaterThan(2*1024*1024);
 const encoded=cold(encodeProgramArtifactWire(original));expect(Buffer.byteLength(JSON.stringify(encoded))).toBeLessThan(2*1024*1024);
 expect(encoded.programArtifacts).toEqual(original.programArtifacts);
 const header=encoded.artifactContents as {additional:Record<string,string>};expect(Object.keys(header.additional)).toHaveLength(2);
 expect(header.additional).not.toHaveProperty(original.programArtifacts[0]!.contentHash);
 expect(decodeProgramArtifactWire(encoded)).toEqual(cold(original));
 expect(JSON.stringify(decodeProgramArtifactWire(encoded))).toBe(JSON.stringify(cold(original)));
 expect((encoded.events as typeof original.events)[0]!.hash).toBe(original.events[0]!.hash);
});
it.each(["missing-header","missing-content","wrong-content","wrong-ref-hash","wrong-id","changed-id","changed-path","conflicting-content","unknown-ref-field","unknown-header-field"])("rejects %s without applying an ambiguous file",mode=>{
 const encoded=cold(encodeProgramArtifactWire(fixture()));
 const row=(encoded.buildTest as {artifacts:Array<Record<string,unknown>>}).artifacts[0]!;
 const ref=row.contentRef as Record<string,unknown>;
 if(mode==="missing-header")delete encoded.artifactContents;
 if(mode==="missing-content")encoded.programArtifacts=[];
 if(mode==="wrong-content")(encoded.programArtifacts as Array<{content:string}>)[0]!.content+="changed";
 if(mode==="wrong-ref-hash")ref.contentHash=hash("foreign");
 if(mode==="wrong-id")row.artifactId="";
 if(mode==="changed-id")row.artifactId="artifact:foreign";
 if(mode==="changed-path")row.path="other-known-file.mjs";
 if(mode==="conflicting-content")row.content="conflicting";
 if(mode==="unknown-ref-field")ref.undeclared="foreign";
 if(mode==="unknown-header-field")(encoded.artifactContents as Record<string,unknown>).undeclared="foreign";
 expect(()=>decodeProgramArtifactWire(encoded)).toThrow();
});
it("rejects encoder identity/hash collisions and preserves unrelated ordinary JSON",()=>{
 const original=fixture();original.buildTest.artifacts[0]={...original.programArtifacts[0]!,content:"different bytes"};
 expect(()=>encodeProgramArtifactWire(original)).toThrow("hash collision");
 expect(()=>encodeProgramArtifactWire({artifactContents:{schema:"caller.owned"}})).toThrow("header collision");
 const ordinary={answer:"hello",buildTest:{stdout:"not an artifact"},unknown:{content:"untyped content",contentRef:{schema:"caller.owned"}}};
 expect(cold(encodeProgramArtifactWire(ordinary))).toEqual(ordinary);expect(decodeProgramArtifactWire(cold(encodeProgramArtifactWire(ordinary)))).toEqual(ordinary);
 const dangling={artifactId:"known",path:"a",mediaType:"text/plain",role:"doc",contentHash:hash("x"),contentRef:{schema:FILE_ARTIFACT_CONTENT_REF_SCHEMA,contentHash:hash("x")}};
 expect(()=>decodeProgramArtifactWire({buildTest:{artifacts:[dangling]}})).toThrow("missing");
});
it.runIf(Boolean(process.env.SCCE_ARTIFACT_WIRE_CAPTURE))("reconstructs the actual captured native API response within its unchanged 2MiB budget",async()=>{
 const capture=JSON.parse(await readFile(process.env.SCCE_ARTIFACT_WIRE_CAPTURE!,"utf8")) as {result:Record<string,unknown>};
 const encoded=cold(encodeProgramArtifactWire(capture.result));
 expect(Buffer.byteLength(JSON.stringify(capture.result))).toBeGreaterThan(2*1024*1024);
 expect(Buffer.byteLength(JSON.stringify(encoded))).toBeLessThan(2*1024*1024);
 expect(decodeProgramArtifactWire(encoded)).toEqual(cold(capture.result));
 expect(JSON.stringify(decodeProgramArtifactWire(encoded))).toBe(JSON.stringify(capture.result));
 console.log(JSON.stringify({beforeBytes:Buffer.byteLength(JSON.stringify(capture.result)),afterBytes:Buffer.byteLength(JSON.stringify(encoded))}));
});
