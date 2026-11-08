// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {describe,it,expect} from "vitest";
import {bindNativeRuntimePath,relativeNativeSourcePath} from "../native-runtime-paths.js";
import {emittedProgramRuntimeForLanguage,UnsupportedProgramLanguageError} from "../code-learning.js";
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
});
