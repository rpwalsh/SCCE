import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { ensureDir, sha256Text, stableStringify } from "./util.mjs";
export async function appendCustody({ file, actor, event, details={} }) {
  let rows=[]; try { rows=(await readFile(path.resolve(file),"utf8")).split(/\r?\n/u).filter(Boolean).map(JSON.parse); } catch {}
  const previous=rows.at(-1); const base={schemaVersion:"1.0",sequence:rows.length+1,timestamp:new Date().toISOString(),actor,event,details,previousHash:previous?.recordHash ?? "GENESIS"};
  const record={...base,recordHash:sha256Text(stableStringify(base))}; await ensureDir(path.dirname(path.resolve(file))); await appendFile(path.resolve(file),`${JSON.stringify(record)}\n`,"utf8"); return record;
}
export function verifyCustody(rows){let prev="GENESIS";const errors=[];for(const r of rows){const {recordHash,...base}=r;const expected=sha256Text(stableStringify(base));if(r.previousHash!==prev)errors.push({sequence:r.sequence,error:"previousHash",expected:prev,actual:r.previousHash});if(recordHash!==expected)errors.push({sequence:r.sequence,error:"recordHash",expected,actual:recordHash});prev=recordHash;}return {ok:errors.length===0,records:rows.length,errors};}
