#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
// READY activation delegates atomic replacement and revision coherence to the existing lifecycle API; dry-run unless --apply.
import path from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";

export function parseActivationArguments(args){
  const options={apply:false};
  for(let index=0;index<args.length;index++){
    const arg=args[index];
    if(arg==="--apply"){if(options.apply)throw Error("duplicate --apply");options.apply=true;continue;}
    const match=/^--(schema|config)(?:=(.*))?$/u.exec(arg);
    if(match){const key=match[1],value=match[2]??args[++index];
      if(options[key]!==undefined||typeof value!=="string"||!value.trim()||value.startsWith("--"))throw Error(`invalid --${key}`);
      options[key]=value;continue;}
    if(arg.startsWith("--")||options.importRunId!==undefined||!arg.trim()||arg.includes("\0"))throw Error("invalid brain activation arguments");
    options.importRunId=arg;
  }
  if(!options.importRunId)throw Error("usage: node tools/activate-brain-import.mjs <importRunId> [--apply] [--schema=NAME] [--config=PATH]");
  if(options.schema!==undefined&&!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(options.schema))throw Error("unsafe schema");
  return options;
}

export async function activateBrainImport(options,dependencies={}){
  const readConfig=dependencies.readScceRuntimeConfig??(await import("../packages/adapters-node/dist/config.js")).readScceRuntimeConfig;
  const createStorage=dependencies.createPostgresStorageAdapter??(await import("../packages/adapters-node/dist/postgres.js")).createPostgresStorageAdapter;
  const configPath=options.config??process.env.SCCE_CONFIG??fileURLToPath(new URL("../scce.config.json",import.meta.url));
  const config=await readConfig(configPath);
  if(!config.security?.informationAccess)throw Error("brain activation requires security.informationAccess in the runtime config");
  const schema=options.schema??config.database.schema;
  if(!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(schema))throw Error("unsafe schema");
  const storage=createStorage({...config.database,schema,informationAccess:config.security.informationAccess});
  let failed=false,primary;
  try{
    const [target,active]=await Promise.all([storage.brainImports.getLifecycle(options.importRunId),storage.brainImports.active()]);
    const inspection={active,target:target?{importRunId:target.importRunId,brainVersion:target.brainVersion,state:target.state,rootPath:target.rootPath}:null};
    if(!target)throw Error(`no lifecycle row for ${options.importRunId}`);
    if(target.state==="ACTIVE")return {...inspection,status:"already_active",applied:false};
    if(target.state!=="READY")throw Error(`activation requires READY, found ${target.state}`);
    if(!options.apply)return {...inspection,status:"dry_run",applied:false};
    const activated=await storage.brainImports.activateReady({importRunId:target.importRunId,brainVersion:target.brainVersion,updatedAt:(dependencies.now??Date.now)()});
    return {...inspection,active:activated,status:"activated",applied:true};
  }catch(error){failed=true;primary=error;throw error;}
  finally{try{await storage.close();}catch(cleanup){if(failed)throw new AggregateError([primary,cleanup],"Brain activation and storage close failed");throw cleanup;}}
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const result=await activateBrainImport(parseActivationArguments(process.argv.slice(2)));
  console.log(JSON.stringify(result,null,2));
}
