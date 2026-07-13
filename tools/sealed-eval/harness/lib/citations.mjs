import { readFile } from "node:fs/promises";
import path from "node:path";
import { readJson, sha256Bytes } from "./util.mjs";
export async function verifyCitations(rows, corpusManifestPath) {
  const manifest=await readJson(corpusManifestPath); const base=path.dirname(path.resolve(corpusManifestPath)); const docs=new Map(manifest.documents.map(d=>[d.documentId,d])); const cache=new Map(); const results=[];
  for(const row of rows){for(let index=0;index<(row.citations??[]).length;index++){const c=row.citations[index];const doc=docs.get(c.documentId);let result={questionId:row.questionId,systemId:row.systemId,conditionId:row.conditionId,citationIndex:index,documentId:c.documentId,startByte:c.startByte,endByte:c.endByte,ok:false};
    if(!doc){result.error="unknown-document";results.push(result);continue;} let bytes=cache.get(doc.documentId); if(!bytes){bytes=await readFile(path.resolve(base,doc.path));cache.set(doc.documentId,bytes);} if(!Number.isInteger(c.startByte)||!Number.isInteger(c.endByte)||c.startByte<0||c.endByte<c.startByte||c.endByte>bytes.length){result.error="invalid-range";results.push(result);continue;} const slice=bytes.subarray(c.startByte,c.endByte); const text=slice.toString("utf8"); const hash=sha256Bytes(slice); result={...result,ok:(!c.sha256||c.sha256===hash)&&(!c.quotedText||c.quotedText===text),actualSha256:hash,actualText:text,hashMatches:!c.sha256||c.sha256===hash,textMatches:!c.quotedText||c.quotedText===text}; results.push(result); }}
  return results;
}
