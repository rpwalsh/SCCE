import { describe, expect, it } from "vitest";
import { splitSurfaceSentences, tidySurfaceText } from "../surface-linguistics.js";

describe("surface sentence boundaries", () => {
  it("does not split after a single-letter personal initial", () => {
    const text = "The crew are led by Captain James T. Kirk, Science Officer Spock, and Chief Medical Officer Leonard H. \"Bones\" McCoy. The series aired on NBC.";

    expect(splitSurfaceSentences(text)).toEqual([
      "The crew are led by Captain James T. Kirk, Science Officer Spock, and Chief Medical Officer Leonard H. \"Bones\" McCoy.",
      "The series aired on NBC."
    ]);
  });

  it("keeps non-Latin initials inside the same sentence", () => {
    const text = "The source names Л. Толстой in the first sentence. The next sentence is separate.";

    expect(splitSurfaceSentences(text)).toEqual([
      "The source names Л. Толстой in the first sentence.",
      "The next sentence is separate."
    ]);
  });

  it("recognizes source sentence boundaries that are not followed by whitespace", () => {
    expect(splitSurfaceSentences("첫째 문장이다.둘째 문장이다。第三句。")).toEqual([
      "첫째 문장이다.",
      "둘째 문장이다。",
      "第三句。"
    ]);
    expect(splitSurfaceSentences("المقطع الأول؟المقطع الثاني!")).toEqual([
      "المقطع الأول؟",
      "المقطع الثاني!"
    ]);
  });
});

describe("tidySurfaceText", () => {
  // This is the canonical space mouth.ts's source-excerpt verification
  // compares answers to evidence text in; answer plans build windows in the
  // same space so verification holds by construction. These tests pin the
  // exact semantics both sides depend on.
  it("collapses ASCII whitespace runs and trims", () => {
    expect(tidySurfaceText("  The  series\n aired\ton \r\nNBC.  ")).toBe("The series aired on NBC.");
  });

  it("collapses consecutive boundary and inline-only glyphs", () => {
    expect(tidySurfaceText("It ended.. Then,, it began!! Again:: yes")).toBe("It ended. Then, it began! Again: yes");
  });

  it("is idempotent, so a window sliced from tidy text re-tidies to itself", () => {
    const tidy = tidySurfaceText("A first  sentence. A second,, one!  ");
    expect(tidySurfaceText(tidy)).toBe(tidy);
  });

  it("splitSurfaceSentences of tidy ASCII text rejoins to a verbatim substring", () => {
    const tidy = tidySurfaceText("The crew includes Kirk. Spock serves as science officer. McCoy is the doctor. The ship is the Enterprise.");
    const sentences = splitSurfaceSentences(tidy);
    expect(sentences.length).toBe(4);
    expect(tidy.includes(sentences.slice(0, 3).join(" "))).toBe(true);
  });
});
