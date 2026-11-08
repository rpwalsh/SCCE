// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {it,expect} from "vitest";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import {compileSourceOwnedContracts} from "../source-owned-contract-compiler.js";
const hash=(bytes:Uint8Array)=>`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
it("compiles owned assertions from exact canonical bytes after the live filesystem changes",async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"scce-owned-contract-snapshot-"));
 try{
  const source={"tsconfig.json":JSON.stringify({compilerOptions:{target:"ES2022",module:"NodeNext",moduleResolution:"NodeNext",strict:true,skipLibCheck:true},include:["*.ts"]}),
   "provider.ts":"export function f0(value:number){return value+1;}\n",
   "checks.ts":"import {test} from 'node:test';import assert from 'node:assert/strict';import {f0} from './provider.js';test('values',()=>{assert.strictEqual(f0(1),2);assert.strictEqual(f0(2),3);});\n"};
  const files=Object.entries(source).map(([name,text])=>{const bytes=Buffer.from(text);return {path:name,bytes,sourceHash:hash(bytes),sourceVersionId:`owned:${name}`};});
  for(const [name,text] of Object.entries(source))await writeFile(path.join(root,name),text);
  await writeFile(path.join(root,"provider.ts"),"export function f9(value:number){return value-1;}\n");
  const input={root,files,sourceUriBase:"fixture://verified-canonical",knownPaths:files.map(file=>file.path),complete:true,maxFileBytes:4096,maxTotalBytes:16384};
  const compiled=await compileSourceOwnedContracts(input);
  expect(compiled.get("provider.ts")).toHaveLength(1);
  expect(compiled.get("provider.ts")![0]).toMatchObject({targetName:"f0",sourceHash:files[1]!.sourceHash,cases:[{expectedResult:2},{expectedResult:3}]});
  await expect(compileSourceOwnedContracts({...input,files:files.map(file=>file.path==="provider.ts"?{...file,sourceHash:hash(Buffer.from("foreign bytes"))}:file)})).rejects.toThrow(/exact UTF-8 bytes/u);
 }finally{await rm(root,{recursive:true,force:true});}
});
