// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";
import {arithmeticAnswerForText} from "../local-evidence-runtime.js";
import {createScceKernel,createClock,createHasher,createIdFactory,createInMemoryDialogueMemoryStore} from "../index.js";
import {storageFixtureForEvaluation} from "./evidence-promotion-evaluation-fixture.js";
const transcript=JSON.parse(readFileSync(new URL("./fixtures/oasst-human-russian-creative-pair.json",import.meta.url),"utf8")) as {turns:Array<{surface:string}>};
const reviewedRussianPrompt=transcript.turns[0]!.surface;
describe("formal arithmetic request ownership",()=>{
 it("does not turn the exact reviewed human Russian comic request into subtraction",()=>{
  expect(reviewedRussianPrompt).toContain("7-10");expect(arithmeticAnswerForText(reviewedRussianPrompt)).toBeUndefined();
 });
 it.each([
  "Escriu un text de 7-10 frases.",
  "Escribe un texto de 7\u201310 frases.",
  "Racontez une histoire en 7 - 10 phrases.",
  "\u66f8\u3044\u3066 7-10 \u6587\u3002",
  "7-10 frases",
  "frases: 7-10?",
  "7\u221210 frases",
  "Crea 2+2 frases.",
  "2019-05-02",
  "(7-10]",
  "[7-10)",
  "{7-10]",
  "2+2? 3+3?"
 ])("does not extract a calculation from non-formal or invalid request %s",text=>expect(arithmeticAnswerForText(text)).toBeUndefined());
 it.each([
  {text:"7-10",answer:"7 - 10 = -3."},
  {text:"7 - 10",answer:"7 - 10 = -3."},
  {text:"7\u221210?",answer:"7 - 10 = -3."},
  {text:"7\u221210\uFF1F",answer:"7 - 10 = -3."},
  {text:"7\u221210\u061F",answer:"7 - 10 = -3."},
  {text:"2+2?",answer:"2 + 2 = 4."},
  {text:"(2 + 3) \u00d7 4",answer:"(2 + 3) * 4 = 20."},
  {text:"[12 \u00f7 3]",answer:"[12 / 3] = 4."},
  {text:"{7-10}",answer:"{7 - 10} = -3."},
  {text:"-7 - -10",answer:"- 7 - - 10 = 3."}
 ])("preserves complete formal arithmetic $text",({text,answer})=>expect(arithmeticAnswerForText(text)?.answer).toBe(answer));
 it("leaves the unsupported factual human request outside the early computation route",async()=>{
  const clock=createClock({fixedTime:1,stepMs:1}),hasher=createHasher(),fixture=storageFixtureForEvaluation({evidence:[],clockNow:()=>clock.now()});
  fixture.storage.userModelClaims={putClaim:async()=>undefined,listClaims:async()=>[]};
  fixture.storage.taskResumption={putSnapshot:async()=>undefined,getLatestSnapshot:async()=>null};
  fixture.storage.documentGeneration={putSession:async()=>undefined,getSession:async()=>null,compareAndPutSession:async()=>({stored:true,currentUpdatedAt:null})};
  fixture.storage.dialogueMemory=createInMemoryDialogueMemoryStore();
  const kernel=createScceKernel({storage:fixture.storage,files:{streamPath:async function*(){}},buildTest:{executeProgram:async()=>{throw new Error("Arithmetic request must not execute a program");}},clock,idFactory:createIdFactory({clock,hasher,deterministicReplay:true}),deterministicReplay:true});
  const result=await kernel.turn({text:reviewedRussianPrompt,requestedAuthority:"factual"});
  expect(result.answer).not.toBe("7 - 10 = -3.");expect(result.events.some(event=>event.typeId==="ComputationEvaluated")).toBe(false);
  expect(JSON.stringify(result.actionGraph)).not.toContain("deterministic_arithmetic");
  const genuine=await kernel.turn({text:"7\u221210?",requestedAuthority:"factual"});expect(genuine.answer).toBe("7 - 10 = -3.");expect(genuine.events.some(event=>event.typeId==="ComputationEvaluated")).toBe(true);
 });
});
