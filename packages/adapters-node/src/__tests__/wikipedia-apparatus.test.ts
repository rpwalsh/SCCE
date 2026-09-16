// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { normalizeWikiText } from "../wikipedia.js";

/**
 * Raw wikitext, verbatim from enwiki-latest-pages-articles-multistream block 2317911, page 880 ABBA: the lead, two
 * body paragraphs and the external-links section whose middle entry the 2026-09-13 chat probe answered with for
 * five turns. The ingestor, not the mouth, is what has to refuse it: by the time a turn sees the span the line is
 * indistinguishable from a sentence, which is what T20 measured.
 */
const ABBA_WIKITEXT = [
  "'''ABBA''' were a Swedish pop group formed in Stockholm in 1972 by [[Agnetha Fältskog]], [[Björn Ulvaeus]], "
    + "[[Benny Andersson]], and [[Anni-Frid Lyngstad]]. They are among the most renowned and commercially successful "
    + "musical groups in history.",
  "",
  "In 1974, ABBA won the [[Eurovision Song Contest]] with their song \"[[Waterloo (song)|Waterloo]]\". In 2005, "
    + "\"Waterloo\" was chosen as the best song in the competition's history. During their peak, ABBA comprised two "
    + "married couples: Fältskog and Ulvaeus, and Lyngstad and Andersson. As their fame grew, their personal lives "
    + "suffered, leading to the dissolution of both marriages.",
  "",
  "ABBA have sold an estimated 150 million records worldwide, making them one of the best-selling acts in the "
    + "history of popular music.<ref name=\"sales\">{{cite web|url=http://example.invalid|title=Sales}}</ref> The "
    + "group are ranked as the third best-selling singles artist in the United Kingdom, with a total of 11.3 million "
    + "singles sold as of 3 November 2012.",
  "",
  "Agnetha Fältskog (born 5 April 1950 in [[Jönköping]], Sweden) sang with a local dance band headed by Bernt "
    + "Enghardt, who sent a demo recording of their music to Karl-Gerhard Lundkvist. The demo tape featured a song "
    + "written and sung by Fältskog. Lundkvist was impressed by her voice and believed she had the potential to "
    + "become a star.",
  "",
  "Björn Ulvaeus (born 25 April 1945 in [[Gothenburg]], Sweden) also began his musical career at the age of 18, as "
    + "a singer and guitarist, when he fronted the [[Hootenanny Singers]], a popular Swedish folk-skiffle group. "
    + "Ulvaeus began composing English-language songs for his group and concurrently pursued a brief solo career. In "
    + "June 1966, Ulvaeus and Andersson decided to write a song together.",
  "",
  "In 2016, the group reunited and started working on a digital avatar concert tour. Newly recorded songs were "
    + "announced in 2018. ''Voyage'', their first new album in 40 years, was released on 5 November 2021, to "
    + "positive critical reviews and strong sales.",
  "",
  "== External links ==",
  "<!-- Per [[WP:ELMINOFFICIAL]], choose one official website only -->",
  "{{Commons and category|ABBA}}",
  "* {{Official website}}",
  "* {{Rockhall}}",
  "* [https://variety.com/2018/film/columns/abba-were-the-feminine-pop-opera-of-their-time-1202880565/ The Secret "
    + "Majesty of ABBA]. Variety, 22 July 2018",
  "* [https://www.npr.org/sections/therecord/2015/05/23/408844375/abbas-essential-influential-melancholy ABBA's "
    + "Essential, Influential Melancholy]. NPR, 23 May 2015",
  "* [https://www.smithsonianmag.com/arts-culture/whats-behind-abbas-staying-power-180969709/ What's Behind ABBA's "
    + "Staying Power?]. Smithsonian, 20 July 2018",
  "* [https://abbaarticles.blogspot.com/ ABBA – The Articles] – ABBA news from throughout the world",
  "* {{IMDb name|1755868}}"
].join("\n");

describe("the wikipedia ingestor emits the article and not its apparatus", () => {
  const normalized = normalizeWikiText(ABBA_WIKITEXT);

  it("does not emit the bibliography entry that was served as an answer", () => {
    expect(normalized).not.toContain("Essential, Influential Melancholy");
    expect(normalized).not.toContain("npr.org");
    expect(normalized).not.toContain("Staying Power");
  });

  it("emits the article's own prose, lead first", () => {
    expect(normalized).toContain("ABBA' were a Swedish pop group formed in Stockholm in 1972");
    expect(normalized).toContain("ABBA have sold an estimated 150 million records worldwide");
    expect(normalized).toContain("Ulvaeus and Andersson decided to write a song together");
  });
});
