import { describe, expect, it } from "vitest";
import { splitSurfaceSentences } from "../surface-linguistics.js";

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
