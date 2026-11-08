import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { canonical } from '../../protocol.mjs';

export const NATIVE_LANGUAGES = ['typescript', 'javascript', 'python', 'rust', 'go'];
export function statefulSource(language, names, defect = null) {
  const { write: w, read: r, remove: d } = names;
  const write = defect === 'lost_write' ? 'key' : 'value';
  const deletion = defect === 'lost_delete';
  const missing = defect === 'missing_value';
  if (language === 'typescript') return `const records: Record<string,string> = Object.create(null);\nexport function ${w}(key:string,value:string):void { records[key] = ${write}; }\nexport function ${r}(key:string):string { return records[key] ?? ${missing ? '""' : '"~"'}; }\nexport function ${d}(key:string):void { ${deletion ? 'void records[key]' : 'delete records[key]'}; }\n`;
  if (language === 'javascript') return `const records = Object.create(null);\nexports.${w} = (key,value) => { records[key] = ${write}; };\nexports.${r} = key => records[key] ?? ${missing ? '""' : '"~"'};\nexports.${d} = key => { ${deletion ? 'void records[key]' : 'delete records[key]'}; };\n`;
  if (language === 'python') return `records = {}\ndef ${w}(key, value):\n    records[key] = ${write}\ndef ${r}(key):\n    return records.get(key, ${missing ? '""' : '"~"'})\ndef ${d}(key):\n    ${deletion ? 'records.get(key)' : 'records.pop(key, None)'}\n`;
  if (language === 'rust') return `use std::collections::HashMap;\npub fn ${w}(records: &mut HashMap<String,String>, key: &str, value: &str) { records.insert(key.to_string(), ${write}.to_string()); }\npub fn ${r}(records: &HashMap<String,String>, key: &str) -> String { records.get(key).cloned().unwrap_or_else(|| ${missing ? '""' : '"~"'}.to_string()) }\npub fn ${d}(records: &mut HashMap<String,String>, key: &str) { ${deletion ? 'records.get(key)' : 'records.remove(key)'}; }\n`;
  if (language === 'go') return `package main\nvar records = map[string]string{}\nfunc ${w}(key string, value string) { records[key] = ${write} }\nfunc ${r}(key string) string { value, ok := records[key]; if ok { return value }; return ${missing ? '""' : '"~"'} }\nfunc ${d}(key string) { ${deletion ? '_ = records[key]' : 'delete(records,key)'} }\n`;
  throw new Error(`No native fixture provider: ${language}`);
}
export function statefulDriver(language, n) {
  if (['typescript', 'javascript'].includes(language)) return `const fs=require('node:fs');const m=require(${JSON.stringify(language === 'typescript' ? './.native-build/module.js' : './module.cjs')});for(const line of fs.readFileSync(0,'utf8').trimEnd().split(${JSON.stringify('\n')})){if(!line)continue;const p=line.split(${JSON.stringify('\t')});if(p[0]==='W')m.${n.write}(p[1],p[2]);else if(p[0]==='D')m.${n.remove}(p[1]);else if(p[0]==='R')console.log(m.${n.read}(p[1]));else throw Error('invalid public operation');}\n`;
  if (language === 'python') return `import sys\nimport module\nfor line in sys.stdin:\n    p=line.rstrip('\\n').split('\\t')\n    if p[0]=='W': module.${n.write}(p[1],p[2])\n    elif p[0]=='D': module.${n.remove}(p[1])\n    elif p[0]=='R': print(module.${n.read}(p[1]))\n    else: raise ValueError('invalid public operation')\n`;
  if (language === 'rust') return `mod module;\nuse std::io::{self,Read};\nuse std::collections::HashMap;\nfn main(){let mut input=String::new();io::stdin().read_to_string(&mut input).unwrap();let mut state=HashMap::new();for line in input.lines(){let p:Vec<&str>=line.split('\\t').collect();match p[0]{"W"=>module::${n.write}(&mut state,p[1],p[2]),"D"=>module::${n.remove}(&mut state,p[1]),"R"=>println!("{}",module::${n.read}(&state,p[1])),_=>panic!("invalid public operation")}}}\n`;
  if (language === 'go') return `package main\nimport("bufio";"fmt";"os";"strings")\nfunc main(){scanner:=bufio.NewScanner(os.Stdin);for scanner.Scan(){p:=strings.Split(scanner.Text(),"\\t");switch p[0]{case "W":${n.write}(p[1],p[2]);case "D":${n.remove}(p[1]);case "R":fmt.Println(${n.read}(p[1]));default:panic("invalid public operation")}};if err:=scanner.Err();err!=nil{panic(err)}}\n`;
  throw new Error(`No native driver provider: ${language}`);
}
export function expectedReads(operations) {
  const records = new Map(), result = [];
  for (const [op, key, value] of operations) {
    if (op === 'W') records.set(key, value);
    else if (op === 'D') records.delete(key);
    else if (op === 'R') result.push(records.get(key) ?? '~');
    else throw new Error('Unknown test operation');
  }
  return result;
}
export async function nativeFiles({ language, names, tools, repair, defect, publicVectors }) {
  if (!NATIVE_LANGUAGES.includes(language)) return null;
  const target = { typescript: 'module.ts', javascript: 'module.cjs', python: 'module.py', rust: 'module.rs', go: 'module.go' }[language];
  const driver = { typescript: 'driver.cjs', javascript: 'driver.cjs', python: 'driver.py', rust: 'driver.rs', go: 'driver.go' }[language];
  const files = {
    [driver]: statefulDriver(language, names),
    'native-runner.mjs': await readFile(fileURLToPath(new URL('./native-runner.mjs', import.meta.url)), 'utf8'),
    'native-tools.json': canonical({ language, tools, target, driver }),
    'public-vectors.json': canonical(publicVectors.map(operations => ({ operations, expected: expectedReads(operations) }))),
    'public-check.mjs': "import {checkVectors} from './native-runner.mjs';await checkVectors('public-vectors.json');\n",
    'package.json': canonical({ private: true, type: 'commonjs' })
  };
  if (language === 'typescript') files['tsconfig.json'] = canonical({ compilerOptions: { target: 'ES2020', module: 'CommonJS', strict: true, skipLibCheck: true, types: [], outDir: '.native-build' }, include: ['module.ts'] });
  if (language === 'go') files['go.mod'] = 'module example.invalid/blind-case\n\ngo 1.20\n';
  if (repair) files[target] = statefulSource(language, names, defect);
  return { files, target };
}
