import { describe, expect, it } from "vitest";
import { speakableAnswerText } from "../speech.js";

describe("speakableAnswerText", () => {
  it("replaces fenced code with a spoken placeholder", () => {
    expect(speakableAnswerText("Run this:\n```js\nconsole.log(1)\n```\nDone.")).toBe("Run this: Code block. Done.");
  });

  it("drops source attribution lines", () => {
    expect(speakableAnswerText("Answer text.\n\nSource: Star Trek DS9 (1999)")).toBe("Answer text.");
  });

  it("strips markdown tokens and collapses whitespace", () => {
    expect(speakableAnswerText("**Bold** and `code`   words")).toBe("Bold and code words");
  });

  it("caps very long answers at a sentence boundary", () => {
    const spoken = speakableAnswerText("A sentence here. ".repeat(400));
    expect(spoken.length).toBeLessThan(2700);
    expect(spoken.endsWith("The rest is on screen.")).toBe(true);
  });

  it("passes short plain text through unchanged", () => {
    expect(speakableAnswerText("Quark is played by Armin Shimerman.")).toBe("Quark is played by Armin Shimerman.");
  });
});
