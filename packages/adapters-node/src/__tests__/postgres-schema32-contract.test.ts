// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect,it } from "vitest";
import { createPostgresContract,renderPostgresContractSql,verifyPostgresContract } from "@scce/kernel";
import { requiredHydrationColumns,schemaStatements } from "../postgres-schema.js";

function fields(body:string):string[]{
  const result:string[]=[];let depth=0,quoted=false,start=0;
  for(let i=0;i<body.length;i++){const ch=body[i];if(ch==="'"){if(quoted&&body[i+1]==="'"){i++;continue;}quoted=!quoted;}
    if(quoted)continue;if(ch==='(')depth++;if(ch===')')depth--;if(ch===','&&depth===0){result.push(body.slice(start,i).trim());start=i+1;}}
  result.push(body.slice(start).trim());return result;
}
function declaration(sql:string){
  const body=sql.slice(sql.indexOf('(')+1,sql.lastIndexOf(')')),columns=[],primary:string[]=[];
  for(const field of fields(body)){
    const key=field.match(/^PRIMARY KEY\s*\(([^)]+)\)/u);
    if(key){primary.push(...key[1]!.split(',').map(value=>value.trim().replaceAll('"','')));continue;}
    const column=field.match(/^"?([a-z_]+)"?\s+(TEXT\[\]|BYTEA\[\]|TEXT|JSONB|TIMESTAMPTZ|BYTEA)(?=\s|$)/u);
    if(!column)throw new Error(`Unrecognized schema field: ${field}`);
    const reference=field.match(/REFERENCES\s+"?fixture"?\."?([a-z_]+)"?\s*\("?([a-z_]+)"?\)(?:\s+ON DELETE (CASCADE|RESTRICT|SET NULL|NO ACTION))?/u);
    const inlinePrimary=field.includes('PRIMARY KEY');if(inlinePrimary)primary.push(column[1]!);
    columns.push({name:column[1]!,scalar:column[2]!,collation:field.includes('COLLATE "C"')?"C":undefined,nullable:!inlinePrimary&&!field.includes('NOT NULL'),references:reference?{table:reference[1]!,column:reference[2]!,onDelete:reference[3]??'NO ACTION'}:undefined});
  }
  return {columns,primary};
}
it("declares actual source storage columns, keys and foreign keys instead of generic payload tables",()=>{
  const contract=createPostgresContract({schema:'fixture'}),actual=schemaStatements('"fixture"'),rendered=renderPostgresContractSql(contract);
  const names=Object.keys(requiredHydrationColumns()).filter(name=>name.startsWith('segmentation_consolidation_')||name.startsWith('creative_event_')||name==='construction_source_decision_pages');
  expect(names).toHaveLength(9);
  for(const name of names){
    const sql=actual.find(value=>value.startsWith(`CREATE TABLE IF NOT EXISTS "fixture".${name} (`));expect(sql).toBeDefined();
    const expected=declaration(sql!),table=contract.tables.find(value=>value.name===name)!;
    expect(table.columns.map(({name,scalar,collation,nullable,references})=>({name,scalar,collation,nullable,references})),name).toEqual(expected.columns);
    const declaredKey=table.primaryKey??table.columns.filter(column=>column.primary).map(column=>column.name);
    expect(declaredKey,name).toEqual(expected.primary);
    expect(table.columns.map(column=>column.name),name).toEqual(requiredHydrationColumns()[name]);
    const emitted=rendered.find(value=>value.startsWith(`CREATE TABLE IF NOT EXISTS "fixture"."${name}" (`));
    expect(declaration(emitted!),name).toEqual(expected);
  }
  expect(verifyPostgresContract(contract).filter(check=>!check.passed)).toEqual([]);
});
it("declares one canonical evidence reference without a duplicate body or digest",()=>{
  const statements=schemaStatements('"fixture"');
  expect(statements.some(value=>value.includes('DROP COLUMN IF EXISTS text_content'))).toBe(true);
  expect(statements.some(value=>value.includes('DROP COLUMN IF EXISTS text_sha256'))).toBe(true);
  const names=createPostgresContract().tables.find(table=>table.name==='evidence_spans')!.columns.map(column=>column.name);
  expect(names).not.toContain('text');expect(names).not.toContain('text_sha256');
  expect(requiredHydrationColumns().evidence_spans).not.toContain('text_content');
  expect(requiredHydrationColumns().evidence_spans).not.toContain('text_sha256');
});
