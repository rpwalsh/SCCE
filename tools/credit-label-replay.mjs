// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Replays the 46 live credit episodes through the outcome label. Offline: the signals are the values
// scce3_runtime.calibration_observations held on 2026-09-16, pasted as data. Reads no database.
import { runtimeRewardTerms } from "../packages/kernel/dist/cognitive-credit.js";
import { creditRewardClasses } from "../packages/kernel/dist/calibration-spine.js";

// ep, obligations, unresolved, contradictionMass, replannedAsRecorded, evidenceCount, storedOutcome
const LIVE = [
  ["episode_00mu4j0zbb", 8, 8, 0, false, 0, false],
  ["episode_00mu4j1n5p", 10, 6, 0.6, false, 2, false],
  ["episode_00mu4j2h1s", 10, 6, 0.4, false, 2, false],
  ["episode_00mu4j2pte", 9, 9, 0.17999999999999994, false, 0, false],
  ["episode_00mu4j2y4d", 10, 6, 0.4, false, 2, false],
  ["episode_00mu4j3nu0", 10, 6, 0.4, true, 2, false],
  ["episode_00mu4j5agl", 29, 10, 0.15853738237638682, false, 2, false],
  ["episode_00mu4jewxs", 10, 6, 0.4, false, 2, false],
  ["episode_00mu4jfwde", 29, 10, 0.15853738237638682, false, 2, false],
  ["episode_00mu4jg76c", 8, 8, 0, true, 0, false],
  ["episode_00mu4jgcfm", 10, 5, 0.6, false, 2, false],
  ["episode_00mu4jgp4v", 10, 6, 0.4, false, 2, false],
  ["episode_00mu4jgzyj", 9, 9, 0.17999999999999994, false, 0, false],
  ["episode_00mu4jh9tp", 10, 6, 0.4, false, 2, false],
  ["episode_00mu4jj65y", 8, 8, 0, true, 0, false],
  ["episode_00mu4jje5h", 10, 5, 0.6, true, 2, false],
  ["episode_00mu4jji97", 10, 6, 0.4, true, 2, false],
  ["episode_00mu4jjmgf", 9, 9, 0.17999999999999994, true, 0, false],
  ["episode_00mu4jjr8b", 10, 6, 0.4, true, 2, false],
  ["episode_00mu4k2wyn", 4, 4, 0, false, 0, false],
  ["episode_00mu4k33c0", 8, 8, 0, false, 0, false],
  ["episode_00mu4k3dx7", 8, 8, 0.17999999999999994, false, 0, false],
  ["episode_00mu4k3tps", 8, 8, 0.17999999999999994, false, 0, false],
  ["episode_00mu4k44zs", 9, 9, 0.17999999999999994, false, 0, false],
  ["episode_00mu4k4l8s", 8, 8, 0.17999999999999994, false, 0, false],
  ["episode_00mu4k4vw4", 8, 8, 0.17999999999999994, false, 0, false],
  ["episode_00mu4k5a4x", 56, 11, 0.15872814201094998, false, 2, false],
  ["episode_00mu4k5j9q", 12, 8, 0, false, 2, false],
  ["episode_00mu4k77yi", 8, 8, 0, false, 0, false],
  ["episode_00mu4k7fca", 8, 8, 0.17999999999999994, true, 0, false],
  ["episode_00mu4k7jn1", 8, 8, 0.17999999999999994, true, 0, false],
  ["episode_00mu4k7npl", 9, 9, 0.17999999999999994, true, 0, false],
  ["episode_00mu4k7rqs", 8, 8, 0.17999999999999994, true, 0, false],
  ["episode_00mu4k7von", 8, 8, 0.17999999999999994, true, 0, false],
  ["episode_00mu4k82bm", 56, 11, 0.15872814201094998, true, 2, false],
  ["episode_00mu4k853y", 12, 8, 0, false, 2, false],
  ["episode_00mu4lh2vk", 3, 3, 0, false, 0, false],
  ["episode_00mu4liw97", 56, 11, 0.15872814201094998, false, 2, false],
  ["episode_00mu4mcvvp", 3, 3, 0, false, 0, false],
  ["episode_00mu4mdp63", 28, 16, 0.13510350645795988, false, 2, false],
  ["episode_00mu4me44d", 10, 5, 0.5, false, 2, false],
  ["episode_00mu4me5no", 56, 11, 0.15872814201094998, false, 2, false],
  ["episode_00mu4mfl1k", 62, 1, 0.1308147911996026, false, 1, false],
  ["episode_00mu4mfudf", 56, 11, 0.15872814201094998, true, 2, false],
  ["episode_00mu4mfvwh", 49, 0, 0.28, false, 2, true],
  ["episode_00mu4mfztw", 10, 10, 0.17999999999999994, false, 1, false]
];

// The requests these episodes answered, where conversation_turns recorded the pair.
const REQUEST = {
  episode_00mu4liw97: ["What is the capital of Albania?", "correct + cited"],
  episode_00mu4me5no: ["What is the capital of Albania?", "correct + cited"],
  episode_00mu4mfudf: ["What is the capital of Albania?", "correct + cited"],
  episode_00mu4mfvwh: ["Who was Ada Lovelace?", "correct + cited"],
  episode_00mu4mfl1k: ["What is the program planner?", "correct + specific"],
  episode_00mu4mdp63: ["What is the program planner?", "thin"],
  episode_00mu4me44d: ["What is the melting point of tungsten?", "WRONG (code prose)"],
  episode_00mu4lh2vk: ["warmup two", "filler"],
  episode_00mu4mcvvp: ["warmup two", "filler"]
};

const rewards = new Map();
for (const [ep, obligationCount, unresolvedObligationCount, contradictionMass] of LIVE) {
  const terms = runtimeRewardTerms({
    spoke: true, withheld: false, replanned: false, revised: false, corrected: false,
    contradictionMass, obligationCount, unresolvedObligationCount, budgetExceededCount: 3, evidenceCount: 2
  });
  const values = Object.values(terms);
  rewards.set(ep, values.reduce((sum, value) => sum + value, 0) / values.length);
}

const storedPositive = LIVE.filter(row => row[6]).length;
const classes = creditRewardClasses(rewards);
if (!classes) {
  console.log("REFUSED: the reward population carries no two-class structure");
  process.exit(1);
}

console.log(`episodes ${LIVE.length}  stored outcome=true ${storedPositive}  otsu threshold ${classes.threshold.toFixed(6)}  positive ${classes.positive.size}`);
console.log("");
console.log("reward   class     obl  unres  contra   episode                 request");
for (const [ep, obligationCount, unresolvedObligationCount, contradictionMass] of [...LIVE].sort((a, b) => rewards.get(b[0]) - rewards.get(a[0]))) {
  const note = REQUEST[ep] ? `${REQUEST[ep][0]}  [${REQUEST[ep][1]}]` : "";
  console.log(
    `${rewards.get(ep).toFixed(4)}   ${classes.positive.has(ep) ? "POSITIVE" : "negative"}  ` +
    `${String(obligationCount).padStart(3)}  ${String(unresolvedObligationCount).padStart(5)}  ${contradictionMass.toFixed(3)}   ${ep.padEnd(22)}  ${note}`
  );
}

// The replan signal as recorded against what a motion that actually changed the turn's basis would be.
// Every motion on this instance is `disabled_explicitly` with ingestedEvidenceCount 0.
console.log("");
console.log(`replanned as recorded: ${LIVE.filter(row => row[4]).length}/${LIVE.length}   motions that added evidence: 0/${LIVE.length}`);
