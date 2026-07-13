import { describe, expect, it } from "vitest";
import { WidgetService, listWidgets } from "../src/widget.js";

describe("WidgetService", () => {
  it("lists widgets", () => {
    expect(new WidgetService().list()).toEqual(listWidgets());
  });
});
