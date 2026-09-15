import { afterEach, describe, expect, it } from "vitest";
import { clearCorpusIdentitySignals, primeCorpusIdentitySignals } from "../corpus-identity.js";
import { properNounEntityAnchors } from "../creative-section-realization.js";

afterEach(() => clearCorpusIdentitySignals());

describe("properNounEntityAnchors decides names from the corpus, not sentence position", () => {
  it("keeps a corpus identity that opens a sentence and drops an ordinary opener", () => {
    primeCorpusIdentitySignals({ closedClass: new Set(["was", "a", "the", "about", "of"]), identities: new Set(["einstein"]), spread: new Map(), concentration: 0 });
    expect(properNounEntityAnchors("Einstein was a physicist.")).toEqual(["einstein"]);
    expect(properNounEntityAnchors("Write about Einstein.")).toEqual(["einstein"]);
    expect(properNounEntityAnchors("The end of Einstein.")).toEqual(["einstein"]);
  });

  it("keeps a sentence-opening identity in a non-Latin script", () => {
    primeCorpusIdentitySignals({ closedClass: new Set(["είναι", "μια"]), identities: new Set(["αθήνα"]), spread: new Map(), concentration: 0 });
    expect(properNounEntityAnchors("Αθήνα είναι μια πόλη.")).toEqual(["αθήνα"]);
  });

  it("keeps a sentence-opening identity in an uncased script", () => {
    primeCorpusIdentitySignals({ closedClass: new Set(["היא"]), identities: new Set(["תל אביב"]), spread: new Map(), concentration: 0 });
    expect(properNounEntityAnchors("תל אביב היא עיר.")).toEqual(["תל אביב"]);
  });
});
