import { shuffled, writeJson, writeJsonl } from "./util.mjs";
export async function blindAnswers({ rows, seed, out, mapPath }) {
  const identities=[...new Set(rows.map(r=>`${r.systemId}::${r.conditionId}`))].sort();
  const aliases=shuffled(identities,seed).map((id,i)=>[id,`SYS-${String.fromCharCode(65+i)}`]); const map=Object.fromEntries(aliases);
  const blinded=rows.map(r=>({schemaVersion:"1.0",questionId:r.questionId,attempt:r.attempt,status:r.status,answerAlias:map[`${r.systemId}::${r.conditionId}`],answer:r.answer,citations:r.citations??[],support:r.support??{},metadata:{elapsedMs:r.elapsedMs}}));
  const ordered=shuffled(blinded,`${seed}:rows`); await writeJsonl(out,ordered); await writeJson(mapPath,{schemaVersion:"1.0",createdAt:new Date().toISOString(),mapping:map}); return {count:ordered.length,identities:identities.length};
}
