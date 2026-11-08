import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { canonical } from '../../protocol.mjs';

export function numericSource(language, name, defect = false) {
  if (language === 'typescript') return `export function ${name}(value:number,lower:number,upper:number):number { return ${defect ? 'value' : 'Math.max(lower,Math.min(upper,value))'}; }\n`;
  if (language === 'javascript') return `exports.${name} = (value,lower,upper) => ${defect ? 'value' : 'Math.max(lower,Math.min(upper,value))'};\n`;
  if (language === 'python') return `def ${name}(value, lower, upper):\n    return ${defect ? 'value' : 'max(lower,min(upper,value))'}\n`;
  if (language === 'rust') return `pub fn ${name}(value:i64, lower:i64, upper:i64) -> i64 { ${defect ? 'value' : 'std::cmp::max(lower,std::cmp::min(upper,value))'} }\n`;
  if (language === 'go') return `package main\nfunc ${name}(value int, lower int, upper int) int { ${defect ? 'return value' : 'if value < lower { return lower }; if value > upper { return upper }; return value'} }\n`;
  throw new Error(`Missing numeric fixture provider: ${language}`);
}
export function numericDriver(language, name) {
  if (['typescript', 'javascript'].includes(language)) return `const fs=require('node:fs');const m=require(${JSON.stringify(language === 'typescript' ? './.native-build/module.js' : './module.cjs')});for(const line of fs.readFileSync(0,'utf8').trimEnd().split(${JSON.stringify('\n')})){if(!line)continue;const p=line.split(${JSON.stringify('\t')}).slice(1).map(Number);console.log(m.${name}(...p));}\n`;
  if (language === 'python') return `import sys\nimport module\nfor line in sys.stdin:\n    p=[int(x) for x in line.rstrip('\\n').split('\\t')[1:]]\n    print(module.${name}(*p))\n`;
  if (language === 'rust') return `mod module;use std::io::{self,Read};fn main(){let mut input=String::new();io::stdin().read_to_string(&mut input).unwrap();for line in input.lines(){let p:Vec<i64>=line.split('\\t').skip(1).map(|s|s.parse().unwrap()).collect();println!("{}",module::${name}(p[0],p[1],p[2]));}}\n`;
  if (language === 'go') return `package main\nimport("bufio";"fmt";"os";"strconv";"strings")\nfunc main(){scanner:=bufio.NewScanner(os.Stdin);for scanner.Scan(){p:=strings.Split(scanner.Text(),"\\t");a,_:=strconv.Atoi(p[1]);b,_:=strconv.Atoi(p[2]);c,_:=strconv.Atoi(p[3]);fmt.Println(${name}(a,b,c))};if err:=scanner.Err();err!=nil{panic(err)}}\n`;
  throw new Error(`Missing numeric driver provider: ${language}`);
}
export function numericExpected(operations) { return operations.map(([, value, lower, upper]) => String(Math.max(lower, Math.min(upper, value)))); }
export async function numericFiles({ language, name, tools, repair, publicVectors }) {
  const target = { typescript: 'module.ts', javascript: 'module.cjs', python: 'module.py', rust: 'module.rs', go: 'module.go' }[language];
  if (!target) return null;
  const driver = { typescript: 'driver.cjs', javascript: 'driver.cjs', python: 'driver.py', rust: 'driver.rs', go: 'driver.go' }[language];
  const files = { [driver]: numericDriver(language, name), 'native-runner.mjs': await readFile(fileURLToPath(new URL('./native-runner.mjs', import.meta.url)), 'utf8'), 'native-tools.json': canonical({ language, tools, target, driver }), 'public-vectors.json': canonical(publicVectors.map(operations => ({ operations, expected: numericExpected(operations) }))), 'public-check.mjs': "import {checkVectors} from './native-runner.mjs';await checkVectors('public-vectors.json');\n", 'package.json': canonical({ private: true, type: 'commonjs' }) };
  if (language === 'typescript') files['tsconfig.json'] = canonical({ compilerOptions: { target: 'ES2020', module: 'CommonJS', strict: true, skipLibCheck: true, types: [], outDir: '.native-build' }, include: ['module.ts'] });
  if (language === 'go') files['go.mod'] = 'module example.invalid/blind-case\n\ngo 1.20\n';
  if (repair) files[target] = numericSource(language, name, true);
  return { files, target };
}
