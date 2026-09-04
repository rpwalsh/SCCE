import { describe, expect, it } from "vitest";
import { featureSet, type ContentHash, type EvidenceId, type EvidenceSpan, type SourceId, type SourceVersionId } from "../index.js";
import {
  localEvidenceAnswerClaimSurface,
  localEvidenceAnswerIsQuotationRecall,
  localEvidenceAnswerSurface,
  proposeSourceExactEvidenceAnswer
} from "../local-evidence-runtime.js";

const article = [
  "Star Trek: Deep Space Nine is an American science fiction television series created by Rick Berman and Michael Piller.",
  "Jeffrey Combs played the Ferengi liquidator Brunt and the Vorta Weyoun across many episodes of the series.",
  "In \"The Dogs of War\", he became one of the few Star Trek actors to play two unrelated roles (Brunt and Weyoun) in the same episode.",
  "He would later play the recurring role of Shran on Star Trek: Enterprise.",
  "In addition to Quark and his brother Rom, several other Ferengi had recurring roles, including their shrewd mother Ishka, who eventually engineers a social revolution on Ferenginar."
].join(" ");

function span(): EvidenceSpan {
  const sourceVersionId = "source-version:ds9" as SourceVersionId;
  return {
    id: "evidence:ds9-cast" as EvidenceId,
    sourceId: "source:ds9" as SourceId,
    sourceVersionId,
    chunkId: "chunk:ds9-cast" as EvidenceSpan["chunkId"],
    contentHash: "hash:ds9-cast" as ContentHash,
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: article.length,
    charStart: 0,
    charEnd: article.length,
    text: article,
    textPreview: article,
    languageHints: { language: "fixture" },
    scriptHints: { script: "Latn" },
    trustVector: { trust: 0.94, sourceTrust: 0.94, structuralConfidence: 0.94, forceClass: "direct_evidence" },
    provenance: { namespace: "local", source: "quotation-recall-test", title: "Star Trek: Deep Space Nine", uri: "local://ds9", canonicalUri: "local://ds9", sourceVersionId, byteRange: [0, article.length], charRange: [0, article.length] },
    features: featureSet(article, 256),
    status: "promoted",
    alpha: 0.9,
    observedAt: 1000
  };
}

const quotation = "In \"____ of War\", he became one of the few Star Trek actors to play two unrelated roles (Brunt and Weyoun) in the same episode.";

describe("quotation recall", () => {
  it("answers a quoted sentence with that sentence alone even under an enumeration sentence budget", () => {
    const proposal = proposeSourceExactEvidenceAnswer({ requestText: quotation, selectedEvidence: [span()], responseSentenceBudget: 4 });
    expect(proposal).toBeDefined();
    expect(proposal!.plan.maxSentences).toBe(1);
    expect(localEvidenceAnswerClaimSurface(proposal!)).toContain("The Dogs of War");
    expect(localEvidenceAnswerClaimSurface(proposal!)).not.toContain("Shran");
    expect(localEvidenceAnswerIsQuotationRecall(proposal)).toBe(true);
  });

  it("keeps the enumeration window for a request that quotes nothing", () => {
    const proposal = proposeSourceExactEvidenceAnswer({ requestText: "List the recurring Ferengi roles on Deep Space Nine", selectedEvidence: [span()], responseSentenceBudget: 3 });
    expect(proposal).toBeDefined();
    expect(proposal!.plan.maxSentences).toBeGreaterThan(1);
    expect(localEvidenceAnswerIsQuotationRecall(proposal)).toBe(false);
    expect(localEvidenceAnswerIsQuotationRecall(undefined)).toBe(false);
  });

  it("limits the richer plan to the quoted sentence as well", () => {
    const rich = localEvidenceAnswerSurface({ requestText: quotation, selectedEvidence: [span()] });
    expect(rich).toBeDefined();
    expect(localEvidenceAnswerClaimSurface(rich!)).toContain("The Dogs of War");
    expect(localEvidenceAnswerClaimSurface(rich!)).not.toContain("Shran");
    expect(localEvidenceAnswerIsQuotationRecall(rich)).toBe(true);
  });
});

describe("request coverage", () => {
  it("refuses a passage that shares none of the request's content units, and admits one whose title carries them", async () => {
    const { answerCoversRequest } = await import("../local-evidence-runtime.js");
    const units = ["current", "chief", "executive", "company", "makes", "graphics", "cards"];
    expect(answerCoversRequest(["Poison Ivy is a character appearing in American comic books."], span(), units)).toBe(false);
    expect(answerCoversRequest(["Benjamin Sisko commands the station."], span(), ["commands", "deep", "space", "nine"])).toBe(true);
    expect(answerCoversRequest(["anything"], span(), [])).toBe(true);
    const proposal = proposeSourceExactEvidenceAnswer({ requestText: "Who is the current chief executive of the company that makes the Arc graphics cards?", selectedEvidence: [span()] });
    expect(proposal).toBeUndefined();
  });
});
