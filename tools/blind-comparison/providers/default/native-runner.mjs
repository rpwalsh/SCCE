import { readFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

async function run(argv, input, budget, {cwd,environment}) {
  if(budget.timeMs<=0||budget.outputBytes<=0)return {code:null,failure:budget.timeMs<=0?"native-time-budget":"native-output-budget",stdout:"",stderr:"",bytes:0};
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd,env:environment,shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = []; let bytes = 0, failure;
    const stop = reason => { failure ??= reason; child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('native-time-budget'), budget.timeMs);
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', chunk => { bytes += chunk.length; if (bytes > budget.outputBytes) stop('native-output-budget'); else chunks.push(chunk); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdin.on('error', () => {});
    child.on('close', code => { clearTimeout(timer); resolve({ code, failure, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'),bytes }); });
    child.stdin.end(input);
  });
}
export async function checkVectors(file) {
  return checkNativeVectors({vectors:JSON.parse(await readFile(file,'utf8'))});
}
/** Expected results stay in the checker process; children receive only operations on stdin. */
export async function checkNativeVectors({vectors,cwd=process.cwd(),environment=process.env,timeMs,outputBytes}) {
  const started=performance.now();
  const config = JSON.parse(await readFile(path.join(cwd,'native-tools.json'), 'utf8'));
  const { language, tools } = config;
  if (!tools[language]?.available) throw new Error(`Missing preregistered native toolchain: ${language}`);
  const native = tools[language], budget = native.budget;
  if(!Array.isArray(vectors)||!Number.isFinite(budget?.timeMs)||budget.timeMs<=0||!Number.isSafeInteger(budget.outputBytes)||budget.outputBytes<=0)throw Error('Invalid native verification budget');
  const totalTime=Math.min(timeMs??budget.timeMs,budget.timeMs),totalBytes=Math.min(outputBytes??budget.outputBytes,budget.outputBytes);
  let consumedBytes=0,recordIndex=0;
  const transcript=createHash('sha256');
  const measurement=()=>({vectors:vectors.length,elapsedMs:performance.now()-started,outputBytes:consumedBytes,transcriptHash:transcript.copy().digest('hex')});
  const execute=async(argv,input)=>{
    const result=await run(argv,input,{timeMs:totalTime-(performance.now()-started),outputBytes:totalBytes-consumedBytes},{cwd,environment});
    consumedBytes+=result.bytes;
    transcript.update(JSON.stringify([recordIndex++,result.code,result.failure??null,result.stdout,result.stderr])+"\n");
    return result;
  };
  const binary = path.resolve(cwd,'.native-build', process.platform === 'win32' ? 'case.exe' : 'case');
  await mkdir(path.join(cwd,'.native-build'), { recursive: true });
  let build, command;
  if (language === 'typescript') { build = [tools.node.path, native.compilerPath, '-p', 'tsconfig.json']; command = [tools.node.path, config.driver]; }
  else if (language === 'javascript') { build = [tools.node.path, '--check', config.target]; command = [tools.node.path, config.driver]; }
  else if (language === 'python') { build = [native.path, '-X', 'utf8', '-m', 'py_compile', config.target]; command = [native.path, '-X', 'utf8', config.driver]; }
  else if (language === 'rust') { build = [native.path, '--edition=2021', config.driver, '-o', binary]; command = [binary]; }
  else if (language === 'go') { build = [native.path, 'build', '-o', binary, '.']; command = [binary]; }
  else throw new Error(`Missing native validator provider: ${language}`);
  try{
  const built = await execute(build, '');
  assert.equal(built.failure, undefined, 'Native build exceeded budget');
  assert.equal(built.code, 0, `Native build failed\n${built.stderr}`);
  for (const vector of vectors) {
    const input = vector.operations.map(row => row.join('\t')).join('\n') + '\n';
    const result = await execute(command, input);
    assert.equal(result.failure, undefined, 'Native execution exceeded budget');
    assert.equal(result.code, 0, `Native execution failed\n${result.stderr}`);
    const actual = result.stdout.replace(/\r\n/gu, '\n').split('\n');
    if (actual.at(-1) === '') actual.pop();
    assert.deepEqual(actual, vector.expected, 'Stateful contract mismatch');
  }
  return measurement();
  }catch(error){if(error&&typeof error==='object')error.nativeVerification=measurement();throw error;}
}
