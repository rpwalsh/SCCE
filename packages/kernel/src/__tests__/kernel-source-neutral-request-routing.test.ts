import { describe, expect, it } from "vitest";
import { requestContentPriorUnits, requestContentSurface } from "../kernel.js";

describe("source-neutral request routing", () => {
  it.each([
    {
      shape: "question-initial",
      text: "which quartz actuator rotates?",
      firstObservedUnit: "which",
      topicUnit: "quartz"
    },
    {
      shape: "question-final",
      text: "quartz actuator rotates ka?",
      firstObservedUnit: "quartz",
      topicUnit: "quartz"
    },
    {
      shape: "non-Latin",
      text: "石英执行器 如何旋转?",
      firstObservedUnit: "石英执行器",
      topicUnit: "石英执行器"
    },
    {
      shape: "declarative-question",
      text: "quartz actuator rotates?",
      firstObservedUnit: "quartz",
      topicUnit: "quartz"
    }
  ])("preserves topic units for $shape surfaces", ({ text, firstObservedUnit, topicUnit }) => {
    const slotSelectionUnits = requestContentPriorUnits(text);
    const graphRetrievalSurface = requestContentSurface(text);

    expect(slotSelectionUnits[0]).toBe(firstObservedUnit);
    expect(slotSelectionUnits).toContain(topicUnit);
    expect(graphRetrievalSurface.startsWith(firstObservedUnit)).toBe(true);
    expect(graphRetrievalSurface).toContain(topicUnit);
  });
});
