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
});
