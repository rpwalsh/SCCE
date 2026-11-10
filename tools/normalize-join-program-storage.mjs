#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from 'node:assert/strict';
import {mkdir,writeFile,appendFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {readScceRuntimeConfig,createPostgresStorageAdapter} from '../packages/adapters-node/dist/index.js';
import {encodeDurableJoinPrograms,decodeDurableJoinPrograms} from '../packages/adapters-node/dist/durable-join-program-storage.js';
import {canonicalDigestHex,createHasher} from '../packages/kernel/dist/index.js';

const args=new Map(process.argv.slice(2).map(arg=>{
 const separator=arg.indexOf('=');
 return separator<0?[arg,true]:[arg.slice(0,separator),arg.slice(separator+1)];
}));
const allowed=new Set(['--apply','--config','--limit','--out','--help']);
for(const arg of args.keys()) if(!allowed.has(arg)) throw new Error(`Unknown option: ${arg}`);
if(args.has('--help')){
 console.log('Usage: node --max-old-space-size=1024 tools/normalize-join-program-storage.mjs [--config=scce.config.json] [--limit=N] [--out=receipt.json] [--apply]');
 console.log('Dry run by default. Apply after installing the matching durable storage readers. Reads one row at a time; preserves decoded values, record identities, timestamps, and event hashes.');
 process.exit(0);
}
const apply=args.get('--apply')===true;
const limit=args.has('--limit')?Number(args.get('--limit')):Infinity;
if(!(limit===Infinity||Number.isSafeInteger(limit)&&limit>0)) throw new Error('--limit must be a positive integer');
const out=String(args.get('--out')??`.scce/maintenance/join-storage-${Date.now()}.json`);
await mkdir(dirname(out),{recursive:true});
const journal=`${out}.jsonl`;
await writeFile(journal,'',{flag:'wx'});
const config=await readScceRuntimeConfig(String(args.get('--config')??'scce.config.json'));
const storage=createPostgresStorageAdapter({...config.database,informationAccess:config.security.informationAccess});
const hasher=createHasher();
const digest=value=>canonicalDigestHex(value,hasher);
const started=performance.now();
const report={schema:'scce.join_storage_normalization.v1',startedAt:new Date().toISOString(),databaseSchema:config.database.schema,mode:apply?'apply':'dry_run',examined:0,changed:0,applied:0,immutableRowsRetained:0,oldJsonBytes:0,newJsonBytes:0,oldStoredBytes:0,newStoredBytes:0,tables:[]};
const families=[['language_patterns','pattern_json'],['induced_language_models','model_json'],['events','payload_json']];
const rawMixturePath='strict $.** ? (@.schema == "scce.join_program_mixture.v3" && exists(@.components[*].program.conditionedIndex))';
try{
 for(const [tableName,column] of families){
  const table=storage.table(tableName);
  const before=await storage.query('SELECT pg_total_relation_size($1::regclass)::text AS bytes',[table]);
  const family={table:tableName,examined:0,changed:0,applied:0,allocatedBytesBefore:before[0].bytes};
  report.tables.push(family);
  let cursor='';
  while(report.examined<limit){
   const rows=await storage.query(`SELECT id,${column} AS body,pg_column_size(${column})::int AS stored_bytes,to_jsonb(t)-$3::text AS metadata FROM ${table} t WHERE id>$1 AND jsonb_path_exists(${column},$2::jsonpath) ORDER BY id LIMIT 1`,[cursor,rawMixturePath,column]);
   const row=rows[0];
   if(!row) break;
   cursor=row.id;
   report.examined++;family.examined++;
   const encoded=encodeDurableJoinPrograms(row.body);
   if(encoded===row.body) continue;
   const logicalDigest=digest(decodeDurableJoinPrograms(row.body));
   assert.equal(digest(decodeDurableJoinPrograms(encoded)),logicalDigest,`Decoded value changed for ${tableName}/${row.id}`);
   const originalJson=JSON.stringify(row.body),newJson=JSON.stringify(encoded);
   const immutable=tableName==='events';
   const item={table:tableName,id:row.id,logicalDigest,oldJsonBytes:Buffer.byteLength(originalJson),newJsonBytes:Buffer.byteLength(newJson),oldStoredBytes:row.stored_bytes,applied:false,...(immutable?{status:'immutable_event_retained'}:{})};
   report.changed++;family.changed++;
   report.oldJsonBytes+=item.oldJsonBytes;report.newJsonBytes+=item.newJsonBytes;report.oldStoredBytes+=item.oldStoredBytes;
   if(immutable) report.immutableRowsRetained++;
   if(apply&&!immutable){
    await storage.transaction(async()=>{
     const updated=await storage.query(`UPDATE ${table} AS t SET ${column}=$2::jsonb WHERE id=$1 AND ${column}=$3::jsonb RETURNING id,to_jsonb(t)-$4::text AS metadata`,[row.id,newJson,originalJson,column]);
     assert.equal(updated.length,1,`Concurrent modification of ${tableName}/${row.id}; no overwrite`);
     assert.equal(digest(updated[0].metadata),digest(row.metadata),`Record metadata changed for ${tableName}/${row.id}`);
     const [persisted]=await storage.query(`SELECT ${column} AS body,pg_column_size(${column})::int AS stored_bytes FROM ${table} WHERE id=$1`,[row.id]);
     assert.equal(digest(decodeDurableJoinPrograms(persisted.body)),logicalDigest,`Persisted logical value changed for ${tableName}/${row.id}`);
     item.newStoredBytes=persisted.stored_bytes;
    });
    item.applied=true;report.applied++;family.applied++;report.newStoredBytes+=item.newStoredBytes;
   }
   await appendFile(journal,JSON.stringify(item)+'\n');
   console.log(JSON.stringify(item));
  }
  const after=await storage.query('SELECT pg_total_relation_size($1::regclass)::text AS bytes',[table]);
  family.allocatedBytesAfter=after[0].bytes;
  if(report.examined>=limit) break;
 }
 report.complete=true;
}catch(error){
 report.complete=false;report.error=String(error?.message??error);process.exitCode=1;
}finally{
 report.elapsedMs=Math.round(performance.now()-started);
 report.peakNodeRssMiB=Math.round(process.resourceUsage().maxRSS/1024);
 report.note='Historical events are audited and retained under append-only enforcement; new event writes use the normalized codec. Allocated relations include reusable MVCC space; successful updates do not imply immediate file shrinkage. Journal contains per-record decoded digests; no source text or connection settings.';
 await writeFile(out,JSON.stringify(report,null,2)+'\n');
 await storage.close();
 console.log(JSON.stringify({receipt:out,...report}));
}
