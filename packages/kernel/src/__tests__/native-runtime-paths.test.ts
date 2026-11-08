// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {describe,it,expect} from "vitest";
import {bindNativeRuntimePath,relativeNativeSourcePath} from "../native-runtime-paths.js";
import {emittedProgramRuntimeForLanguage,observedProgramFormalLanguages,UnsupportedProgramLanguageError} from "../code-learning.js";
import {codeRequestSignal} from "../code-request.js";

describe("native runtime owner path and truthful availability",()=>{
 it.each(["cobol","lisp","cpp","opaque-formal-\u03bb"])("does not substitute JavaScript for explicit %s even through the former permissive selector",language=>{
  expect(()=>emittedProgramRuntimeForLanguage(language,{requireNativeBackend:false})).toThrow(UnsupportedProgramLanguageError);
  expect(codeRequestSignal(`\`\`\`${language}\nopaque()\n\`\`\``).language).toBe(language);
 });
 it("uses the default runtime only when formal language is absent",()=>{
  expect(emittedProgramRuntimeForLanguage("").languageId).toBe("javascript");
 });
 it.each(["typescript","javascript","python","go","rust"])("retains the installed %s native backend",language=>{
  expect(emittedProgramRuntimeForLanguage(language).languageId).toBe(language);
 });
 it.each(["../escape.py","/absolute.py","C:/absolute.py","a/../escape.py","a\\escape.py","a//escape.py","test/program_test.py","wrong.rs"])("refuses unsafe, colliding or foreign-language native path %s",target=>{
  expect(()=>bindNativeRuntimePath(emittedProgramRuntimeForLanguage("python"),target)).toThrow(/native_target_path/u);
 });
 it("rejects a Go test artifact as an externally requested library source",()=>{
  expect(()=>bindNativeRuntimePath(emittedProgramRuntimeForLanguage("go"),"opaque_test.go")).toThrow(/native_target_path/u);
 });
 it("binds build and test to the same requested Go package and keeps Rust relative source coordinates",()=>{
  const runtime=bindNativeRuntimePath(emittedProgramRuntimeForLanguage("go"),"opaque/\u03bb.go");
  expect(runtime.sourcePath).toBe("opaque/\u03bb.go");expect(runtime.testPath).toBe("opaque/program_test.go");expect(runtime.syntaxCheckArgs).toEqual(["test","-run","^$","./opaque"]);
  expect(relativeNativeSourcePath("test/program_test.rs","opaque/\u03bb.rs")).toBe("../opaque/\u03bb.rs");
 });
 it("resolves actual source grammar labels through owned file identity without treating a repository envelope as a language",()=>{
  const graph={languages:[{language:"source.repository",weight:10,evidenceIds:[]},{language:"parser:typescript-compiler-api",weight:2,evidenceIds:[]}],repositoryShape:{files:[{pathHint:"src/module.ts",language:"parser:typescript-compiler-api",role:"source.role.module",evidenceIds:[],confidence:1}],hasTests:false,hasConfig:true,hasApiSurface:false,hasUiSurface:false}};
  expect(observedProgramFormalLanguages(graph).map(row=>row.language)).toEqual(["typescript"]);
  expect(observedProgramFormalLanguages({...graph,languages:[{language:"source.capability",weight:10,evidenceIds:[]},...graph.languages],repositoryShape:{...graph.repositoryShape,files:[]},
    signals:[{kind:"file",language:"parser:typescript-compiler-api",text:"src/module.ts"}]}).map(row=>row.language)).toEqual(["typescript"]);
  expect(observedProgramFormalLanguages({...graph,languages:[{language:"extension:csv",weight:1,evidenceIds:[]}],repositoryShape:{...graph.repositoryShape,files:[{...graph.repositoryShape.files[0]!,pathHint:"input.csv",language:"extension:csv"}]}})).toEqual([]);
  const foreign={...graph,languages:[{language:"parser:opaque-frontend",weight:1,evidenceIds:[]}],repositoryShape:{...graph.repositoryShape,files:[{...graph.repositoryShape.files[0]!,pathHint:"module.opaque",language:"parser:opaque-frontend"}]}};
  const language=observedProgramFormalLanguages(foreign)[0]!.language;
  expect(language).toBe("parser:opaque-frontend");expect(()=>emittedProgramRuntimeForLanguage(language)).toThrow(UnsupportedProgramLanguageError);
 });

});
