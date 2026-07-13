import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

export function argsMap(argv = process.argv.slice(2)) {
  const out = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--")) continue;
    const eq = value.indexOf("=");
    if (eq >= 0) out.set(value.slice(2, eq), value.slice(eq + 1));
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) out.set(value.slice(2), argv[++i]);
    else out.set(value.slice(2), "true");
  }
  return out;
}
export function required(map, key) { const v = map.get(key); if (!v) throw new Error(`Missing --${key}`); return v; }
export async function ensureDir(p) { await mkdir(p, { recursive: true }); }
export async function readJson(p) { return JSON.parse(await readFile(path.resolve(p), "utf8")); }
export async function writeJson(p, value) { await ensureDir(path.dirname(path.resolve(p))); await writeFile(path.resolve(p), `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
export async function readJsonl(p) { const text = await readFile(path.resolve(p), "utf8"); return text.split(/\r?\n/u).map(v => v.trim()).filter(Boolean).map((line, index) => { try { return JSON.parse(line); } catch (e) { throw new Error(`${p}:${index + 1}: ${e.message}`); } }); }
export async function writeJsonl(p, rows) { await ensureDir(path.dirname(path.resolve(p))); await writeFile(path.resolve(p), rows.map(row => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), "utf8"); }
export function stable(value) { if (Array.isArray(value)) return value.map(stable); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])); return value; }
export function stableStringify(value) { return JSON.stringify(stable(value)); }
export function sha256Bytes(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
export function sha256Text(text) { return sha256Bytes(Buffer.from(text, "utf8")); }
export async function sha256File(p) { return sha256Bytes(await readFile(path.resolve(p))); }
export async function treeManifest(root, ignores = [".git", "node_modules", "dist", ".scce", ".tmp"]) {
  const base = path.resolve(root); const rows = [];
  async function walk(dir) {
    for (const name of (await readdir(dir)).sort()) {
      if (ignores.includes(name)) continue;
      const abs = path.join(dir, name); const info = await stat(abs);
      if (info.isDirectory()) await walk(abs);
      else if (info.isFile()) rows.push({ path: path.relative(base, abs).split(path.sep).join("/"), sizeBytes: info.size, sha256: await sha256File(abs) });
    }
  }
  await walk(base);
  return { root: base, files: rows, treeHash: sha256Text(rows.map(r => `${r.path}\0${r.sizeBytes}\0${r.sha256}`).join("\n")) };
}
export function seeded(seedText) { let x = 2166136261 >>> 0; for (const c of seedText) { x ^= c.codePointAt(0); x = Math.imul(x, 16777619) >>> 0; } return () => { x += 0x6D2B79F5; let t = x; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function shuffled(values, seedText) { const a = [...values]; const rng = seeded(seedText); for (let i = a.length - 1; i > 0; i -= 1) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
export function mean(values) { return values.length ? values.reduce((a,b)=>a+b,0)/values.length : null; }
export function bootstrapMean(values, seedText, iterations=5000, level=0.95) { if (!values.length) return { mean:null, low:null, high:null, n:0 }; const rng=seeded(seedText); const sims=[]; for(let i=0;i<iterations;i++){let s=0;for(let j=0;j<values.length;j++)s+=values[Math.floor(rng()*values.length)];sims.push(s/values.length);} sims.sort((a,b)=>a-b); const alpha=(1-level)/2; return {mean:mean(values),low:sims[Math.floor(alpha*iterations)],high:sims[Math.min(iterations-1,Math.ceil((1-alpha)*iterations)-1)],n:values.length}; }
