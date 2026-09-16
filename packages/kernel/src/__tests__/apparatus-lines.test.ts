// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { measureApparatusRuns, stripApparatusLines } from "../apparatus-lines.js";
import { isStructuralResidueSurface, structuralResidueScore } from "../structural-residue.js";

/**
 * Verbatim from enwiki-latest-pages-articles-multistream, block 2317911, page 880 ABBA, read through the wiki
 * normalizer's markup stages: six paragraphs of the article's own prose and the external-links list whose middle
 * entry a 2026-09-13 chat probe served as an answer for five turns.
 *
 * The prose is not decoration. The measure asks how much more of its length a run spends on symbols than the
 * document around it does, so the document has to be a document: with one paragraph of prose in front of the list
 * the same list measures 0.0592 and is kept, and that is the honest limit of a within-document baseline.
 */
const ABBA_PROSE = [
  "'ABBA' were a Swedish pop group formed in Stockholm in 1972 by Agnetha Fältskog, Björn Ulvaeus, Benny Andersson, "
    + "and Anni-Frid Lyngstad. They are among the most renowned and commercially successful musical groups in history.",
  "In, ABBA won the Eurovision Song Contest for with their song \"Waterloo\". In 2005, \"Waterloo\" was chosen as the "
    + "best song in the competition's history during its 50th anniversary celebration. During their peak, ABBA "
    + "comprised two married couples: Fältskog and Ulvaeus, and Lyngstad and Andersson. As their fame grew, their "
    + "personal lives suffered, leading to the dissolution of both marriages.",
  "ABBA have sold an estimated 150 million records worldwide, making them one of the best-selling acts in the history "
    + "of popular music. The group are ranked as the third best-selling singles artist in the United Kingdom, with a "
    + "total of 11.3 million singles sold as of 3 November 2012.",
  "In 2016, the group reunited and started working on a digital avatar concert tour. Newly recorded songs were "
    + "announced in 2018. 'Voyage', their first new album in 40 years, was released on 5 November 2021, to positive "
    + "critical reviews and strong sales.",
  "Agnetha Fältskog (born 5 April 1950 in Jönköping, Sweden) sang with a local dance band headed by Bernt Enghardt, "
    + "who sent a demo recording of their music to Karl-Gerhard Lundkvist. The demo tape featured a song written and "
    + "sung by Fältskog: \"Jag var så kär\" (\"I Was So in Love\"). Lundkvist was impressed by her voice and believed "
    + "she had the potential to become a star.",
  "Björn Ulvaeus (born 25 April 1945 in Gothenburg, Sweden) also began his musical career at the age of 18, as a "
    + "singer and guitarist, when he fronted the Hootenanny Singers, a popular Swedish folk-skiffle group. Ulvaeus "
    + "began composing English-language songs for his group and concurrently pursued a brief solo career. In June "
    + "1966, Ulvaeus and Andersson decided to write a song together."
].join("\n");

const ABBA_ENTRY =
  "* [https://www.npr.org/sections/therecord/2015/05/23/408844375/abbas-essential-influential-melancholy ABBA's "
  + "Essential, Influential Melancholy]. NPR, 23 May 2015";

const ABBA_PAGE = [
  ABBA_PROSE,
  "== External links ==",
  "* [https://variety.com/2018/film/columns/abba-were-the-feminine-pop-opera-of-their-time-1202880565/ The Secret "
    + "Majesty of ABBA]. Variety, 22 July 2018",
  ABBA_ENTRY,
  "* [https://www.smithsonianmag.com/arts-culture/whats-behind-abbas-staying-power-180969709/ What's Behind ABBA's "
    + "Staying Power?]. Smithsonian, 20 July 2018",
  "* [https://abbaarticles.blogspot.com/ ABBA – The Articles] – ABBA news from throughout the world"
].join("\n");

/** Verbatim from corpus/gutenberg/jane-eyre.txt: lines dense in symbols that are not apparatus. */
const BOOK_DIALOGUE = [
  "“Do you say your prayers night and morning?” continued my interrogator.",
  "“Yes, sir.”",
  "“Do you read your Bible?”",
  "“Sometimes.”",
  "“With pleasure? Are you fond of it?”",
  "“I like Revelations, and the book of Daniel, and Genesis and Samuel.”"
].join("\n");

describe("apparatus at ingest is measured over line runs", () => {
  it("refuses the bibliography run that a surface-at-a-time measure lets through", () => {
    // The regression: structural residue reads one surface, and this one stays under its cut; split into sentences
    // as the derivation tool splits them, the entry repeats no bigram at all and scores exactly 0 (T20).
    expect(isStructuralResidueSurface(ABBA_ENTRY)).toBe(false);
    expect(structuralResidueScore("-essential-influential-melancholy ABBA's Essential, Influential Melancholy].")).toBe(0);
    const bibliography = measureApparatusRuns(ABBA_PAGE).find(run => run.text.includes("Essential, Influential Melancholy"));
    expect(bibliography?.apparatus).toBe(true);
    expect(stripApparatusLines(ABBA_PAGE)).not.toContain("Essential, Influential Melancholy");
  });

  it("keeps the article's prose, which is the line the reader asked for", () => {
    const cleaned = stripApparatusLines(ABBA_PAGE);
    expect(cleaned).toContain("'ABBA' were a Swedish pop group formed in Stockholm in 1972");
    expect(cleaned).toContain("ABBA have sold an estimated 150 million records worldwide");
  });

  it("keeps quoted dialogue, which is symbol-dense without being apparatus", () => {
    // Measured over 15 Gutenberg books: dialogue runs sit at 0.178 to 0.209 excess symbol density, under the cut.
    expect(stripApparatusLines(BOOK_DIALOGUE)).toContain("“I like Revelations, and the book of Daniel");
    for (const run of measureApparatusRuns(BOOK_DIALOGUE)) expect(run.apparatus).toBe(false);
  });

  it("never calls a single line apparatus, however dense in symbols it is", () => {
    const paragraph = "Initial experiments yielded four americium isotopes: 241 Am, 242 Am, 239 Am and 238 Am.";
    const runs = measureApparatusRuns(paragraph);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.apparatus).toBe(false);
  });
});
