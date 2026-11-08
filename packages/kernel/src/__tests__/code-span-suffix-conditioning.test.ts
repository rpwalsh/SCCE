// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { composeSpanFillings } from "../code-span-repair.js";
import { codeSurfaceTokens } from "../code-surface.js";
import { trainKneserNey } from "../kneser-ney.js";

it("conditions the same source-owned hole on the preserved suffix within the learned Markov dependency", () => {
  const corpus = "balances.merge();\namount.parse();\nbalances.merge();\namount.parse();\n";
  const model = trainKneserNey(codeSurfaceTokens(corpus), { order: 4, discount: 0.75 });
  const filling = (suffixText: string) => composeSpanFillings({ corpusModels: [model], localModel: model, corpusWeight: 0.5,
    prefixText: "\n", suffixText, originalText: "missing", beamWidth: model.vocabulary.length, boost: new Map(), limit: 1 })[0]?.text;
  expect(filling(".merge();")).toBe("balances");
  expect(filling(".parse();")).toBe("amount");
});
