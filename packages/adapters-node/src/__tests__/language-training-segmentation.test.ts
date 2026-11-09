// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it, vi } from "vitest";
import {joinInformationLabels,type InformationLabel,type ScceStorage} from "@scce/kernel";
import { corpusSegmentationInputRecipe } from "../corpus-segmentation-producer.js";
import { rawCorpusSegmentationFixture } from "../../../kernel/src/__tests__/fixtures/raw-corpus-segmentation.js";
import { prepareLanguageTrainingSegmentationInput, languageTrainingSegmentationLoader, languageTrainingSegmentationLabel, type LanguageTrainingSegmentationDeclaration } from "../language-training-segmentation.js";
import { prepareLanguageCorpusTraining } from "../language-corpus-trainer.js";

const declaration: LanguageTrainingSegmentationDeclaration = {
  scope: { informationLabel: { tenantId: "fixture", principals: [], compartments: [], exportClass: "public", mergePolicy: "isolated" }, sourceVersionIds: ["owned.a", "owned.b"] },
  recipeId: corpusSegmentationInputRecipe(4096), normalizationContractId: "declared.normalization", bounds: { pageRows: 3, maxPageBytes: 65536 }
};
it("keeps a private source label exact when learning from an unrestricted public same-owner population",()=>{
  const source:InformationLabel={tenantId:"private.owner",principals:["owner"],compartments:["private"],exportClass:"restricted",mergePolicy:"isolated"};
  const corpus:InformationLabel={tenantId:"public.corpus",principals:[],compartments:[],exportClass:"public",mergePolicy:"same_owner"};
  expect(languageTrainingSegmentationLabel(source,corpus)).toEqual(source);expect(corpus.tenantId).toBe("public.corpus");
  expect(()=>joinInformationLabels([source,corpus])).toThrow("cross-tenant");
  for(const changed of [{principals:["other"]},{compartments:["licensed"]},{exportClass:"restricted" as const,principals:["other"]},{mergePolicy:"explicit" as const},{mergePolicy:"isolated" as const}]){
    expect(()=>languageTrainingSegmentationLabel(source,{...corpus,...changed})).toThrow(/cross-tenant|isolated|explicit/);
  }
});

it("declares bootstrap explicitly and refuses a configured missing snapshot before any source compiler runs", async () => {
  const readActive = vi.fn(async () => null);
  const storage = { corpusSegmentation: { readActive } } as unknown as ScceStorage;
  const bootstrap = await prepareLanguageTrainingSegmentationInput(storage);
  expect(bootstrap.identity).toMatchObject({ mode: "local_bootstrap", declaration: null, population: null, transition: "new_derived_compilation_required" });
  expect(await languageTrainingSegmentationLoader(storage, undefined, bootstrap)).toBeUndefined(); expect(readActive).not.toHaveBeenCalled();
  await expect(prepareLanguageCorpusTraining({ storage, corpusSegmentation: declaration, sourceSystem: "wikipedia", streamUri: "fixture://new", text: "oma vela." }))
    .rejects.toThrow("run scce db consolidate-segmentation");
  expect(readActive).toHaveBeenCalledTimes(1);
});

it("binds exact declarations and propagates stale dependency failures at the locked commit check", async () => {
  const corpus = await rawCorpusSegmentationFixture();
  const readActive = vi.fn(async (..._args: Parameters<NonNullable<ScceStorage["corpusSegmentation"]>["readActive"]>) => ({ inference: corpus.model, loader: corpus.loader }));
  const storage = { corpusSegmentation: { readActive } } as unknown as ScceStorage;
  const selected = await prepareLanguageTrainingSegmentationInput(storage, declaration);
  expect(selected.identity.mode).toBe("corpus_snapshot");
  expect(await languageTrainingSegmentationLoader(storage, declaration, selected)).toBe(corpus.loader);
  await languageTrainingSegmentationLoader(storage, declaration, selected, true);
  expect(readActive.mock.calls.at(-1)?.[3]).toEqual({ lockForCommit: true });
  await expect(languageTrainingSegmentationLoader(storage, { ...declaration, recipeId: "different" }, selected)).rejects.toThrow("preparation changed");
  const failure = new Error("source dependencies changed"); readActive.mockRejectedValueOnce(failure);
  await expect(languageTrainingSegmentationLoader(storage, declaration, selected, true)).rejects.toBe(failure);
  selected.identity.declaration!.scope.sourceVersionIds = ["foreign"];
  await expect(languageTrainingSegmentationLoader(storage, declaration, selected)).rejects.toThrow("preparation changed");
});
