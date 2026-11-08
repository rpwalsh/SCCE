// Public native-validation permission: declarations and resource scope only, never implementation bodies.
export function nativeValidationPermission({language,target,tools,protectedPaths,maxFiles,maxBytes}) {
 const testPath={javascript:'test/program.test.mjs',typescript:'test/program.test.mjs',python:'test/program_test.py',go:`${target.split('/').slice(0,-1).map(part=>`${part}/`).join('')}program_test.go`,rust:'test/program_test.rs'}[language];
 const runtime={javascript:['program.runtime.node-esm.v1','node','node'],typescript:['program.runtime.node-typescript.v1','node','node'],python:['program.runtime.python-stdlib.v1','python','python'],go:['program.runtime.go-stdlib.v1','go','go'],rust:['program.runtime.rust-stdlib.v1','rustc','rust']}[language];
 if(!runtime||!tools[runtime[2]]?.path)throw Error('Declared native tool inventory is unavailable');
 const [id,commandName,toolId]=runtime;
 const buildArgs=language==='javascript'?['--check',target]:language==='typescript'?['--input-type=module','-e',"import {readFileSync} from 'node:fs';import {stripTypeScriptTypes} from 'node:module';stripTypeScriptTypes(readFileSync(process.argv[1],'utf8'),{mode:'strip',sourceUrl:process.argv[1]});",target]:language==='python'?['-m','py_compile',target]:language==='go'?['test','-run','^$',target,testPath]:['--edition','2021','--test',testPath,'-o','program_test.exe'];
 const test=language==='rust'?{command:'./program_test.exe',args:[],cwd:'.'}:language==='go'?{command:'go',args:['test',target,testPath],cwd:'.'}:{command:commandName,args:[testPath],cwd:'.'};
 return {schema:'scce.blind-native-validation-permission.v1',provider:{id,languageId:language,commandName},toolId,tool:tools[toolId],workingDirectory:'ephemeral_program_workspace',
  build:{command:commandName,args:buildArgs,cwd:'.'},test,targetPaths:[target],protectedPaths:[...protectedPaths].filter(path=>path!==target).sort(),allowNewFiles:true,maxFiles,maxBytes};
}
