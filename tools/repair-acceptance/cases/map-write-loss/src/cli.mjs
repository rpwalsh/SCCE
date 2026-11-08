// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
// Test-authored application wrapper; never ingested as training data.
import { estimateClassEffectLCB } from "./paired-evaluation-statistics.ts";
const records = JSON.parse(process.argv[2]);
const result = estimateClassEffectLCB(records, { confidenceLevel: 0.95, bootstrapSamples: 32, randomSource: () => 0 });
process.stdout.write(JSON.stringify(result));
