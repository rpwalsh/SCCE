// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codeSurfaceTokens, trainKneserNey, toJsonValue } from "@scce/kernel";
import { trustedHostPatchValidationProvider, type StructuredPatchValidationPolicy } from "@scce/adapters-node";
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
const binary = process.platform === "win32" ? "ledger.exe" : "ledger";
const e2e = `import {execFileSync} from 'node:child_process';
const [command,...args]=process.argv.slice(2);
const actual=execFileSync(command,args,{input:'food,12\\ntravel,-3\\nfood,-8\\n',encoding:'utf8'}).replaceAll('\\r','');
if(actual!=='food=4\\ntravel=-3\\n')throw Error('CLI result: '+actual);
console.log('E2E passed: grouped signed ledger entries through stdin/stdout');
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

interface ApplicationCase {
 language: string;
 executable: string;
 target: string;
 source: string;
 broken: string;
 files: Record<string, string>;
 commands: StructuredPatchValidationPolicy["commands"];
}
const applications: ApplicationCase[] = [{
 language: "go", executable: go, target: "ledger.go", source: goSource,
 broken: goSource.replace("balances[cells[0]] += amount", "balnces[cells[0]] += amount"),
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
}];

describe("multilingual application repair through the production workspace HTTP seam", () => {
 for (const app of applications) it.skipIf(!existsSync(app.executable))(`${app.language} learns the repair token from source and passes native application, unit and E2E gates`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "scce-native-application-"));
  roots.push(root);
  const files = { ...app.files, [app.target]: app.broken };
  for (const [relative, content] of Object.entries(files)) {
   await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
   await writeFile(path.join(root, relative), content);
  }
  const before = await fileTree(root);
  const policy: StructuredPatchValidationPolicy = { schemaVersion: "scce.patch-validation-policy.v1", id: `native-${app.language}-application.v1`, commands: app.commands,
   timeoutMs: 120_000, maxOutputBytes: 1_000_000, maxWorkspaceFiles: 64, maxWorkspaceBytes: 1_000_000,
   environment: { RUSTC: "C:/Users/react/.cargo/bin/rustc.exe" } };
  const model = trainKneserNey(codeSurfaceTokens(app.source), { order: 5, discount: 0.75, vocabularyLimit: 8192 });
  const record = { id: `source-ledger-${app.language}`, streamId: `oss_code:${app.target}`, languageHint: app.language, maxOrder: model.order, discount: model.discount, updatedAt: 1,
   modelJson: toJsonValue({ sourceSystem: "oss_code", formalLanguage: app.language, model }) };
  const context = { runtime: {
   storage: { languageMemory: { listNgramModels: async () => [record] }, evidence: { searchEvidence: async () => [] }, events: { append: async () => undefined } },
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
  expect(await readFile(path.join(root, app.target), "utf8")).toBe(app.source);
  expect(await fileTree(root)).toEqual(before);
  for (const [relative, content] of Object.entries(app.files)) expect(await readFile(path.join(root, relative), "utf8")).toBe(content);
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
