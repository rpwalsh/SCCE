import { readFile } from "node:fs/promises";
import { readJson, sha256File, sha256Text, stableStringify, treeManifest, writeJson } from "./util.mjs";

export async function createSeal({ evaluationId, prereg, corpus, questions, source, build, brain, out }) {
  const hashes = {
    preregistration: await sha256File(prereg),
    corpusManifest: await sha256File(corpus),
    questions: await sha256File(questions)
  };
  const corpusObj = await readJson(corpus);
  hashes.corpusDocumentSet = sha256Text(stableStringify(corpusObj.documents ?? []));
  if (source) hashes.sourceTree = (await treeManifest(source)).treeHash;
  if (build) hashes.buildTree = (await treeManifest(build)).treeHash;
  if (brain) hashes.brainManifest = await sha256File(brain);
  const body = { schemaVersion:"1.0", evaluationId, createdAt:new Date().toISOString(), hashes, metadata:{ tool:"yopp-sealed-eval-kit", version:"1.0.0" } };
  const sealHash = sha256Text(stableStringify(body));
  const seal = { ...body, sealHash };
  await writeJson(out, seal); return seal;
}
export async function verifySeal(opts) {
  const existing = await readJson(opts.seal);
  const tmp = `${opts.seal}.verification.tmp.json`;
  const current = await createSeal({ ...opts, evaluationId: existing.evaluationId, out: tmp });
  const mismatches=[];
  for(const [k,v] of Object.entries(existing.hashes)) if(current.hashes[k] !== v) mismatches.push({field:k,expected:v,actual:current.hashes[k]});
  const ok = mismatches.length===0;
  return { schemaVersion:"1.0", verifiedAt:new Date().toISOString(), ok, sealHash:existing.sealHash, mismatches };
}
