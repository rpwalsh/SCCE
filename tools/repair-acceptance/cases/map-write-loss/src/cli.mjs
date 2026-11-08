// Test-authored application wrapper around the frozen repository source; never ingested as training data.
import { estimateClassEffectLCB } from "./paired-evaluation-statistics.ts";
const records = JSON.parse(process.argv[2]);
const result = estimateClassEffectLCB(records, { confidenceLevel: 0.95, bootstrapSamples: 32, randomSource: () => 0 });
process.stdout.write(JSON.stringify(result));
