// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codeSurfaceTokens, trainKneserNey, toJsonValue } from "@scce/kernel";
import { findCodeVerifierCapability, trustedHostPatchValidationProvider, type StructuredPatchValidationPolicy } from "@scce/adapters-node";
import { handleRequest, type ApiContext } from "../routes.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) {
  expect(path.dirname(root)).toBe(path.resolve(tmpdir()));
  expect(path.basename(root)).toMatch(/^scce-native-application-/u);
  await rm(root, { recursive: true, force: true });
} });

const go = "C:/Users/react/toolchains/go/bin/go.exe";
const javac = "C:/Program Files/Java/jdk-25/bin/javac.exe";
const java = "C:/Program Files/Java/jdk-25/bin/java.exe";
const cargo = "C:/Users/react/.cargo/bin/cargo.exe";
const cpp = "C:/Users/react/toolchains/mingw64/bin/g++.exe";
const dotnet = "C:/Program Files/dotnet/dotnet.exe";
const python = "C:/Python314/python.exe";
const binary = process.platform === "win32" ? "ledger.exe" : "ledger";
const unitBinary = process.platform === "win32" ? "ledger-unit.exe" : "ledger-unit";
const e2e = `import {execFileSync} from 'node:child_process';
const [command,...args]=process.argv.slice(2);
const actual=execFileSync(command,args,{input:'food,12\\ntravel,-3\\nfood,-8\\n',encoding:'utf8'}).replaceAll('\\r','');
if(actual!=='food=4\\ntravel=-3\\n')throw Error('CLI result: '+actual);
console.log('E2E passed: grouped signed ledger entries through stdin/stdout');
`;
const nativeBuild = `import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
for(const job of JSON.parse(readFileSync('native-build.json','utf8'))){
 const result=spawnSync(job.command,job.args,{encoding:'utf8',windowsHide:true});
 process.stdout.write(result.stdout??''); process.stderr.write(result.stderr??'');
 if(result.error)throw result.error;
 if(result.status!==0)process.exit(result.status??1);
}
`;

const goSource = `package main
import("fmt";"strconv";"strings")
func totals(input string) (map[string]int,error) {
 balances := make(map[string]int)
 for _, line := range strings.Split(strings.TrimSpace(input), "\\n") {
  cells := strings.Split(line, ",")
  if len(cells) != 2 { return nil, fmt.Errorf("invalid entry: %s", line) }
  amount, err := strconv.Atoi(cells[1])
  if err != nil { return nil, err }
  balances[cells[0]] += amount
 }
 return balances,nil
}
`;
const javaSource = `import java.util.Map;
import java.util.TreeMap;
public class Ledger {
 public static Map<String,Integer> totals(String input) {
  Map<String,Integer> balances = new TreeMap<>();
  for (String line : input.strip().split("\\n")) {
   String[] cells = line.split(",", -1);
   if (cells.length != 2) throw new IllegalArgumentException("invalid entry");
   int amount = Integer.parseInt(cells[1]);
   balances.merge(cells[0], amount, Integer::sum);
  }
  return balances;
 }
}
`;
const rustSource = `use std::collections::BTreeMap;
pub fn totals(input: &str) -> Result<BTreeMap<String, i64>, String> {
 let mut balances = BTreeMap::new();
 for line in input.lines().filter(|line| !line.is_empty()) {
  let (label, amount) = line.split_once(',').ok_or("invalid entry")?;
  let amount: i64 = amount.parse().map_err(|error| format!("{}", error))?;
  *balances.entry(label.to_owned()).or_insert(0) += amount;
 }
 Ok(balances)
}
`;
const cppSource = `#include "ledger.hpp"
#include <sstream>
#include <stdexcept>
std::map<std::string,int> totals(const std::string& input) {
 std::map<std::string,int> balances;
 std::istringstream stream(input);
 std::string line;
 while (std::getline(stream,line)) {
  auto comma = line.find(',');
  if (comma == std::string::npos) throw std::invalid_argument("invalid entry");
  auto label = line.substr(0,comma);
  int amount = std::stoi(line.substr(comma+1));
  balances[label] += amount;
 }
 return balances;
}
`;
const csharpSource = `using System;
using System.Collections.Generic;
public static class Ledger {
 public static SortedDictionary<string,int> Totals(string input) {
  var balances = new SortedDictionary<string,int>();
  foreach (var line in input.Trim().Split('\\n')) {
   var cells = line.Split(',');
   if (cells.Length != 2) throw new FormatException("invalid entry");
   int amount = int.Parse(cells[1]);
   int previous;
   balances.TryGetValue(cells[0], out previous);
   balances[cells[0]] = previous + amount;
  }
  return balances;
 }
}
`;
const pythonSource = `import csv
import io
def totals(source):
    balances = {}
    for cells in csv.reader(io.StringIO(source)):
        if len(cells) != 2:
            raise ValueError("invalid entry")
        amount = int(cells[1])
        balances[cells[0]] = balances.get(cells[0], 0) + amount
    return balances
`;

interface ApplicationCase {
 language: string;
 executable: string;
 target: string;
 source: string;
 broken: string;
 behaviorBroken: string;
 files: Record<string, string>;
 commands: StructuredPatchValidationPolicy["commands"];
 prepare?: () => Promise<{ files: Record<string, string>; commands: StructuredPatchValidationPolicy["commands"] }>;
}
const applications: ApplicationCase[] = [{
 language: "go", executable: go, target: "ledger.go", source: goSource,
 broken: goSource.replace("balances[cells[0]] += amount", "balnces[cells[0]] += amount"),
 behaviorBroken: goSource.replace("+= amount", "-= amount"),
 files: {
  "go.mod": "module example.invalid/ledger\n\ngo 1.24\n",
  "main.go": `package main
import("fmt";"io";"os";"sort")
func main(){ input,err:=io.ReadAll(os.Stdin); if err!=nil { panic(err) }; rows,err:=totals(string(input)); if err!=nil { panic(err) }; keys:=make([]string,0,len(rows)); for key:=range rows { keys=append(keys,key) }; sort.Strings(keys); for _,key:=range keys { fmt.Printf("%s=%d\\n",key,rows[key]) } }
`,
  "ledger_test.go": `package main
import "testing"
func TestTotals(t *testing.T){ got,err:=totals("rent,19\\nrent,-7\\nfood,5"); if err!=nil || got["rent"]!=12 || got["food"]!=5 { t.Fatalf("%v %v",got,err) }; if _,err:=totals("bad");err==nil { t.Fatal("invalid entry accepted") }; if _,err:=totals("rent,NaN");err==nil { t.Fatal("invalid amount accepted") } }
`,
  "e2e.mjs": e2e
 },
 commands: [
  { executable: go, argv: ["build", "-o", binary, "."], checkIds: ["compiler"] },
  { executable: go, argv: ["test", "-count=1", "./..."], checkIds: ["tests"] },
  { executable: process.execPath, argv: ["e2e.mjs", `./${binary}`] }
 ]
}, {
 language: "java", executable: javac, target: "Ledger.java", source: javaSource,
 broken: javaSource.replace("balances.merge", "balnces.merge"),
 behaviorBroken: javaSource.replace("Integer::sum", "Integer::max"),
 files: {
  "Main.java": `import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.util.stream.Collectors;
public class Main { public static void main(String[] args) { String input = new BufferedReader(new InputStreamReader(System.in)).lines().collect(Collectors.joining("\\n")); Ledger.totals(input).forEach((key,value)->System.out.println(key+"="+value)); } }
`,
  "LedgerTest.java": `public class LedgerTest { public static void main(String[] args) { var got=Ledger.totals("rent,19\\nrent,-7\\nfood,5"); assert got.get("rent")==12; assert got.get("food")==5; boolean rejected=false; try {Ledger.totals("bad");}catch(IllegalArgumentException e){rejected=true;} assert rejected; rejected=false; try {Ledger.totals("rent,NaN");}catch(NumberFormatException e){rejected=true;} assert rejected; System.out.println("Unit tests passed"); } }
`,
  "e2e.mjs": e2e
 },
 commands: [
  { executable: javac, argv: ["-proc:none", "-d", "classes", "Ledger.java", "Main.java", "LedgerTest.java"], checkIds: ["compiler"] },
  { executable: java, argv: ["-ea", "-cp", "classes", "LedgerTest"], checkIds: ["tests"] },
  { executable: process.execPath, argv: ["e2e.mjs", java, "-cp", "classes", "Main"] }
 ]
}, {
 language: "rust", executable: cargo, target: "src/ledger.rs", source: rustSource,
 broken: rustSource.replace("*balances.entry", "*balnces.entry"),
 behaviorBroken: rustSource.replace("+= amount", "-= amount"),
 files: {
  "Cargo.toml": '[package]\nname = "ledger"\nversion = "0.1.0"\nedition = "2021"\n',
  "src/main.rs": `mod ledger;
use std::io::{self, Read};
fn main() { let mut input=String::new(); io::stdin().read_to_string(&mut input).unwrap(); for (key,value) in ledger::totals(&input).unwrap() {println!("{}={}",key,value);} }
`,
  "tests/ledger.rs": `#[path = "../src/ledger.rs"] mod ledger;
#[test] fn grouped_entries() { let got=ledger::totals("rent,19\\nrent,-7\\nfood,5").unwrap(); assert_eq!(got["rent"],12); assert_eq!(got["food"],5); assert!(ledger::totals("bad").is_err()); assert!(ledger::totals("rent,NaN").is_err()); }
`,
  "e2e.mjs": e2e
 },
 commands: [
  { executable: cargo, argv: ["build", "--quiet", "--offline", "--target-dir", "out"], checkIds: ["compiler"] },
  { executable: cargo, argv: ["test", "--quiet", "--offline", "--target-dir", "out"], checkIds: ["tests"] },
  { executable: process.execPath, argv: ["e2e.mjs", `./out/debug/${binary}`] }
 ]
}, {
 language: "cpp", executable: cpp, target: "ledger.cxx", source: cppSource,
 broken: cppSource.replace("balances[label] += amount", "balnces[label] += amount"),
 behaviorBroken: cppSource.replace("+= amount", "-= amount"),
 files: {
  "ledger.hpp": "#pragma once\n#include <map>\n#include <string>\nstd::map<std::string,int> totals(const std::string& input);\n",
  "main.cpp": '#include "ledger.hpp"\n#include <iostream>\n#include <iterator>\nint main(){std::string input((std::istreambuf_iterator<char>(std::cin)),{});for(const auto& row:totals(input))std::cout<<row.first<<"="<<row.second<<"\\n";}\n',
  "ledger_test.cpp": '#include "ledger.hpp"\n#include <stdexcept>\n#include <iostream>\nint main(){auto got=totals("rent,19\\nrent,-7\\nfood,5");if(got["rent"]!=12||got["food"]!=5){std::cerr<<"grouping contract";return 1;}bool rejected=false;try{totals("bad");}catch(const std::exception&){rejected=true;}if(!rejected)return 2;rejected=false;try{totals("rent,NaN");}catch(const std::exception&){rejected=true;}if(!rejected)return 3;}\n',
  "native-build.mjs": nativeBuild,
  "native-build.json": JSON.stringify([
   { command: cpp, args: ["-std=c++20", "-static", "ledger.cxx", "main.cpp", "-o", binary] },
   { command: cpp, args: ["-std=c++20", "-static", "ledger.cxx", "ledger_test.cpp", "-o", unitBinary] }
  ]),
  "e2e.mjs": e2e
 },
 commands: [
  { executable: process.execPath, argv: ["native-build.mjs"], checkIds: ["compiler"] },
  { executable: `./${unitBinary}`, argv: [], checkIds: ["tests"] },
  { executable: process.execPath, argv: ["e2e.mjs", `./${binary}`] }
 ]
}, {
 language: "csharp", executable: dotnet, target: "Ledger.cs", source: csharpSource,
 broken: csharpSource.replace("balances[cells[0]] =", "balnces[cells[0]] ="),
 behaviorBroken: csharpSource.replace("previous + amount", "previous - amount"),
 files: {
  "Program.cs": 'using System;\npublic static class Program {public static void Main(){foreach(var row in Ledger.Totals(Console.In.ReadToEnd()))Console.WriteLine(row.Key+"="+row.Value);}}\n',
  "LedgerTest.cs": 'using System;\npublic static class LedgerTest {public static void Main(){var got=Ledger.Totals("rent,19\\nrent,-7\\nfood,5");if(got["rent"]!=12||got["food"]!=5)throw new Exception("grouping contract");bool rejected=false;try{Ledger.Totals("bad");}catch(FormatException){rejected=true;}if(!rejected)throw new Exception("invalid entry accepted");rejected=false;try{Ledger.Totals("rent,NaN");}catch(FormatException){rejected=true;}if(!rejected)throw new Exception("invalid amount accepted");}}\n',
  "native-build.mjs": nativeBuild,
  "e2e.mjs": e2e
 },
 commands: [],
 prepare: async () => {
  const capability = await findCodeVerifierCapability("csharp");
  if (capability.status !== "available") throw Error(capability.reason);
  const check = capability.verifier.check;
  expect(check.args[0]).toBe("exec");
  const compiler = check.args[1]!;
  const framework = check.args.map(arg => /\/ref\/(net[\d.]+)\//u.exec(arg.replaceAll("\\", "/"))?.[1]).find(Boolean);
  if(!framework) throw Error("installed C# reference pack has no target framework");
  const runtime = JSON.stringify({ runtimeOptions: { tfm: framework, framework: { name: "Microsoft.NETCore.App", version: `${framework.slice(3)}.0` }, rollForward: "LatestPatch" } });
  const references = check.args.slice(2).filter(arg => !arg.startsWith("-target:") && !arg.startsWith("-out:") && arg !== "{artifact}");
  const response = (entry: string, output: string) => [...references, "-target:exe", `-main:${entry}`, `-out:${output}`, "Ledger.cs", "Program.cs", "LedgerTest.cs"]
    .map(arg => `"${arg.replaceAll('"', '\\"')}"`).join("\n");
  return { files: {
    "application.rsp": response("Program", "Ledger.dll"),
    "tests.rsp": response("LedgerTest", "LedgerTest.dll"),
    "Ledger.runtimeconfig.json": runtime,
    "LedgerTest.runtimeconfig.json": runtime,
    "native-build.json": JSON.stringify(["application.rsp", "tests.rsp"].map(file => ({ command: check.command, args: ["exec", compiler, `@${file}`] })))
   }, commands: [
    { executable: process.execPath, argv: ["native-build.mjs"], checkIds: ["compiler"] },
    { executable: check.command, argv: ["LedgerTest.dll"], checkIds: ["tests"] },
    { executable: process.execPath, argv: ["e2e.mjs", check.command, "Ledger.dll"] }
   ] };
 }
}, {
 language: "python", executable: python, target: "ledger.py", source: pythonSource,
 broken: pythonSource.replace("balances[cells[0]] =", "balnces[cells[0]] ="),
 behaviorBroken: pythonSource.replace("0) + amount", "0) - amount"),
 files: {
  "main.py": "import sys\nfrom ledger import totals\nfor label,amount in sorted(totals(sys.stdin.read()).items()):\n    print(f'{label}={amount}')\n",
  "ledger_test.py": "import unittest\nfrom ledger import totals\nclass LedgerTest(unittest.TestCase):\n    def test_grouping(self):\n        self.assertEqual(totals('rent,19\\nrent,-7\\nfood,5'), {'rent':12,'food':5})\n    def test_invalid(self):\n        with self.assertRaises(ValueError): totals('bad')\n        with self.assertRaises(ValueError): totals('rent,NaN')\nif __name__ == '__main__': unittest.main()\n",
  "e2e.mjs": e2e
 },
 commands: [
  { executable: python, argv: ["-m", "py_compile", "ledger.py", "main.py", "ledger_test.py"], checkIds: ["compiler"] },
  { executable: python, argv: ["ledger_test.py"], checkIds: ["tests"] },
  { executable: process.execPath, argv: ["e2e.mjs", python, "main.py"] }
 ]
}];

describe("test-authored reference applications through the production workspace HTTP seam", () => {
 for (const app of applications) for (const defect of ["binding", "behavior"] as const) it.skipIf(!existsSync(app.executable))(`${app.language} learns the ${defect} repair from source and passes native application, unit and E2E gates`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "scce-native-application-"));
  roots.push(root);
  const prepared = await app.prepare?.();
  const files = { ...app.files, ...(prepared?.files ?? {}), [app.target]: defect === "binding" ? app.broken : app.behaviorBroken };
  for (const [relative, content] of Object.entries(files)) {
   await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
   await writeFile(path.join(root, relative), content);
  }
  const before = await fileTree(root);
  const policy: StructuredPatchValidationPolicy = { schemaVersion: "scce.patch-validation-policy.v1", id: `test-authored-${app.language}-application.v1`, commands: prepared?.commands ?? app.commands,
   timeoutMs: 120_000, maxOutputBytes: 1_000_000, maxWorkspaceFiles: 64, maxWorkspaceBytes: 1_000_000,
   environment: { RUSTC: "C:/Users/react/.cargo/bin/rustc.exe" } };
  const model = trainKneserNey(codeSurfaceTokens(app.source), { order: 5, discount: 0.75, vocabularyLimit: 8192 });
  const record = { id: `test-authored-training-reference:ledger:${app.language}`, streamId: `oss_code:${app.target}`, languageHint: app.language, maxOrder: model.order, discount: model.discount, updatedAt: 1,
   modelJson: toJsonValue({ sourceSystem: "oss_code", formalLanguage: app.language, sourceOrigin: "test-authored-training-reference", model }) };
  const events: Array<{ typeId: string; payload: unknown }> = [];
  const context = { runtime: {
   storage: { languageMemory: { listNgramModels: async () => [record] }, evidence: { searchEvidence: async () => [] }, events: { append: async (event: { typeId: string; payload: unknown }) => { events.push(event); } } },
   approvals: { isApproved: () => true }
  }, config: { server: { url: "http://127.0.0.1:0" }, runtime: { workspaceRoot: root }, policy: { allowMutation: true }, security: {} },
   patchValidation: { provider: trustedHostPatchValidationProvider, resolvePolicy: (id: string) => { if(id !== policy.id) throw Error("unregistered policy"); return policy; } }
  } as unknown as ApiContext;
  const response = await post(context, { path: app.target, request: "balnces", attempts: 5, validationPolicyId: policy.id });
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result, JSON.stringify(result)).toMatchObject({ outcome: "resolved", finalDiagnostics: [],
   projectVerification: { buildSucceeded: true, testsRun: true, testsSucceeded: true, projectEvidence: { schemaVersion: "scce.workspace-validation-evidence.v1", stagedFileCount: Object.keys(files).length,
    commands: [{ code: 0, checkIds: ["compiler"] }, { code: 0, checkIds: ["tests"] }, { code: 0, stdout: expect.stringContaining("E2E passed") }] } } });
  expect(result.attempts).toBeGreaterThan(0);
  expect(result.attempts).toBeLessThanOrEqual(5);
  expect(result.proposalSources).toEqual(Array.from({ length: result.attempts }, () => "learned_construction"));
  expect(result.proposalAudits.at(-1)).toMatchObject({ source: "learned_construction", audit: { sourceModelKeys: [record.id] } });
  expect(events.find(event => event.typeId === "CodePatchApplied")?.payload).toMatchObject({ proposalAudits: result.proposalAudits });
  expect(await readFile(path.join(root, app.target), "utf8")).toBe(app.source);
  expect(await fileTree(root)).toEqual(before);
  for (const [relative, content] of Object.entries(files)) expect(await readFile(path.join(root, relative), "utf8")).toBe(relative === app.target ? app.source : content);
 }, 120_000);
});

async function post(context: ApiContext, body: unknown): Promise<Response> {
 const server = createServer((request, response) => { void handleRequest(request, response, context); });
 await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
 try {
  const address = server.address();
  if(!address || typeof address === "string") throw Error("missing fixture port");
  return await fetch(`http://127.0.0.1:${address.port}/api/workspace/code`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
 } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

async function fileTree(root: string, prefix = ""): Promise<string[]> {
 const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
 const files: string[] = [];
 for(const entry of entries) {
  const relative = path.posix.join(prefix, entry.name);
  files.push(...entry.isDirectory() ? await fileTree(root, relative) : [relative]);
 }
 return files.sort();
}
