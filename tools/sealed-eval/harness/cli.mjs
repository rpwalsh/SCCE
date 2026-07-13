#!/usr/bin/env node
import { rm } from "node:fs/promises";
import path from "node:path";
import { argsMap, readJson, readJsonl, required, treeManifest, writeJson, writeJsonl } from "./lib/util.mjs";
import { createSeal, verifySeal } from "./lib/seal.mjs";
import { appendCustody, verifyCustody } from "./lib/custody.mjs";
import { blindAnswers } from "./lib/blind.mjs";
import { verifyCitations } from "./lib/citations.mjs";
import { objectiveScores } from "./lib/objective.mjs";
import { aggregate } from "./lib/aggregate.mjs";
import { ablationReport } from "./lib/ablation.mjs";
import { runSystems } from "./lib/run-systems.mjs";
const [command,...rest]=process.argv.slice(2);const args=argsMap(rest);
try{
 if(command==="verify-kit") await verifyKit();
 else if(command==="hash-tree") await writeJson(required(args,"out"),await treeManifest(required(args,"root")));
 else if(command==="seal") await createSeal({evaluationId:required(args,"evaluation-id"),prereg:required(args,"prereg"),corpus:required(args,"corpus"),questions:required(args,"questions"),source:args.get("source"),build:args.get("build"),brain:args.get("brain"),out:required(args,"out")});
 else if(command==="verify-seal"){const result=await verifySeal({seal:required(args,"seal"),prereg:required(args,"prereg"),corpus:required(args,"corpus"),questions:required(args,"questions"),source:args.get("source"),build:args.get("build"),brain:args.get("brain")});if(args.get("out"))await writeJson(args.get("out"),result);else console.log(JSON.stringify(result,null,2));await rm(`${required(args,"seal")}.verification.tmp.json`,{force:true});if(!result.ok)process.exitCode=1;}
 else if(command==="custody-append") console.log(JSON.stringify(await appendCustody({file:required(args,"file"),actor:required(args,"actor"),event:required(args,"event"),details:args.get("details")?JSON.parse(args.get("details")): {}})));
 else if(command==="custody-verify"){const result=verifyCustody(await readJsonl(required(args,"file")));console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;}
 else if(command==="run-systems") await runSystems(required(args,"plan"));
 else if(command==="blind") await blindAnswers({rows:await readJsonl(required(args,"answers")),seed:required(args,"seed"),out:required(args,"out"),mapPath:required(args,"map")});
 else if(command==="verify-citations") await writeJsonl(required(args,"out"),await verifyCitations(await readJsonl(required(args,"answers")),required(args,"corpus")));
 else if(command==="score-objective") await writeJsonl(required(args,"out"),objectiveScores(await readJsonl(required(args,"answers")),await readJsonl(required(args,"questions"))));
 else if(command==="aggregate") await aggregate({judgmentsPath:required(args,"judgments"),objectivePath:args.get("objective"),mapPath:args.get("map"),out:required(args,"out"),seed:args.get("seed")??"aggregate"});
 else if(command==="ablation-report") await ablationReport({aggregatePath:required(args,"aggregate"),manifestPath:required(args,"manifest"),out:required(args,"out")});
 else usage();
}catch(error){process.stderr.write(`${error.stack??error.message}\n`);process.exitCode=1;}
async function verifyKit(){const requiredFiles=["README_FIRST.md","docs/08_PUBLIC_REVIEW_REPORTING.md","security/PUBLIC_REVIEW_OBSERVER_CHECKLIST.md","package.json","templates/preregistration.example.json","templates/ablation-manifest.example.json","harness/lib/util.mjs","harness/adapters/reference-bm25.mjs"];for(const f of requiredFiles)await readJsonOrStat(f);for(const f of ["schemas/corpus-manifest.schema.json","schemas/question.schema.json","schemas/system-manifest.schema.json","schemas/answer-record.schema.json","schemas/judgment.schema.json","schemas/ablation-manifest.schema.json","schemas/preregistration.schema.json","schemas/seal.schema.json","schemas/custody-record.schema.json","schemas/run-plan.schema.json"])await readJson(f);console.log("Public review kit structure and JSON schemas verified.");}
async function readJsonOrStat(f){if(f.endsWith(".json"))return readJson(f);return treeManifest(path.dirname(path.resolve(f)),[]);}
function usage(){console.log("Use: verify-kit | hash-tree | seal | verify-seal | custody-append | custody-verify | run-systems | blind | verify-citations | score-objective | aggregate | ablation-report");}
