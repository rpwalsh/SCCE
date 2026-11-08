// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {codeLanguageForPath} from "./code-request.js";
import type {EmittedProgramRuntime} from "./code-learning.js";

export function bindNativeRuntimePath(runtime:EmittedProgramRuntime,requestedPath?:string):EmittedProgramRuntime {
  if(!requestedPath) return runtime;
  if(!relativeNativePath(requestedPath) || codeLanguageForPath(requestedPath)!==runtime.languageId
    || runtime.languageId==="go" && requestedPath.endsWith("_test.go")) throw new Error("program.emission.native_target_path_invalid");
  if(requestedPath===runtime.sourcePath) return runtime;
  const folder=requestedPath.split("/").slice(0,-1).join("/");
  const testPath=runtime.languageId==="go" ? `${folder?`${folder}/`:""}program_test.go` : runtime.testPath;
  if(requestedPath===testPath) throw new Error("program.emission.native_target_path_collision");
  return {...runtime,sourcePath:requestedPath,testPath,...(runtime.languageId==="go"?{syntaxCheckArgs:["test","-run","^$",requestedPath,testPath]}:{})};
}
export function relativeNativeSourcePath(testPath:string,sourcePath:string):string {
 const from=testPath.split("/").slice(0,-1),to=sourcePath.split("/");
 while(from.length&&to.length&&from[0]===to[0]){from.shift();to.shift();}
 return `${"../".repeat(from.length)}${to.join("/")}`;
}
function relativeNativePath(value:string):boolean {
 return value.length>0 && !/[\\:\u0000-\u001f\u007f]/u.test(value) && value.split("/").every(part=>part!=="" && part!=="." && part!=="..");
}
