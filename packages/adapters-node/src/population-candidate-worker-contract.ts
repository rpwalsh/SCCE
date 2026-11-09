// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { PreparedPagedPopulationWorkspace, SegmentationPageBounds } from "@scce/kernel";
import type { PostgresStorageOptions } from "./postgres.js";
export interface PopulationWorkerInitialization {
  schema:"scce.population_candidate_worker.v1";storage:PostgresStorageOptions;runId:string;bounds:SegmentationPageBounds;
  prepared:PreparedPagedPopulationWorkspace;bundleDigest:string;directory:string;
}
/** Pin the complete executable modules, including transitive math and storage helpers, before accepting jobs. */
export async function populationWorkerBundleDigest():Promise<string>{
  const roots=[path.dirname(fileURLToPath(import.meta.resolve("@scce/kernel"))),path.dirname(fileURLToPath(import.meta.url))];
  const hash=createHash("sha256");
  for(let index=0;index<roots.length;index++){
    const root=roots[index]!,files=(await readdir(root,{recursive:true})).filter(name=>name.endsWith(".js")).sort();
    if(!files.length)throw Error("Population worker executable bundle is unavailable; build before execution");
    for(const file of files){hash.update(`${index}:${file.replaceAll(path.sep,"/")}\0`);for await(const chunk of createReadStream(path.join(root,file)))hash.update(chunk);hash.update("\0");}
  }
  return hash.digest("hex");
}
