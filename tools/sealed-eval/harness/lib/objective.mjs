import { coherenceFindings } from "./coherence.mjs";
function norm(s){return String(s??"").normalize("NFC").toLocaleLowerCase("en-US").replace(/\s+/gu," ").trim();}
export function objectiveScores(answers, questions){const qmap=new Map(questions.map(q=>[q.questionId,q]));return answers.map(a=>{const q=qmap.get(a.questionId);const gold=q?.gold??{};const text=norm(a.answer);const accepted=(gold.acceptedAnswers??[]).some(v=>text.includes(norm(v)));const req=(gold.requiredStrings??[]);const forbid=(gold.forbiddenStrings??[]);const requiredHits=req.filter(v=>text.includes(norm(v))).length;const forbiddenHits=forbid.filter(v=>text.includes(norm(v))).length;const abstained=a.status==="abstained"||/not (?:in|supported|available)|cannot determine|insufficient evidence/iu.test(a.answer??"");let exact=null;if(gold.unanswerable===true) exact=abstained?1:0;else if((gold.acceptedAnswers??[]).length||req.length) exact=(accepted||requiredHits===req.length)&&forbiddenHits===0?1:0;
// Structural coherence (see coherence.mjs) is reported ALONGSIDE the
// required-string score, never blended into it: exactScore keeps its
// original meaning across historical runs, and a reader can see at a
// glance when an answer hit the strings but reads as stitched fragments.
const coherence=coherenceFindings(a.answer);
return{schemaVersion:"1.0",questionId:a.questionId,systemId:a.systemId,conditionId:a.conditionId,attempt:a.attempt,objectiveAvailable:exact!==null,exactScore:exact,requiredHits,requiredCount:req.length,forbiddenHits,abstentionCorrect:gold.unanswerable===undefined?null:(gold.unanswerable===abstained),coherent:coherence.coherent,coherenceDefects:coherence.defects};});}
