import { describe, expect, it } from "vitest";
import { cssSelector, nodesToCrop } from "./crops";

describe("cssSelector", () => {
  it("accepts one CSS selector", () => {
    expect(cssSelector(["nav a.logo"])).toBe("nav a.logo");
  });

  it("rejects frame chains, empty targets, and multiple selectors", () => {
    expect(cssSelector([["iframe", "a"]])).toBeNull();
    expect(cssSelector(["iframe", "a"])).toBeNull();
    expect(cssSelector([""])).toBeNull();
    expect(cssSelector([])).toBeNull();
    expect(cssSelector("nav a")).toBeNull();
  });
});

describe("nodesToCrop", () => {
  it("crops nothing when the page has no violations", () => {
    expect(nodesToCrop([])).toEqual([]);
  });

  it("caps each rule and skips nodes that cannot be cropped", () => {
    const picked = nodesToCrop(
      [
        {
          id: "color-contrast",
          nodes: [
            { target: [["iframe", "a"]] },
            { target: ["nav a"] },
            { target: ["footer a"] },
            { target: [".muted"] },
            { target: [".fine-print"] },
          ],
        },
        {
          id: "image-alt",
          nodes: [{ target: ["img.hero"] }],
        },
      ],
      3,
    );
    expect(picked).toEqual([
      { ruleId: "color-contrast", nodeIndex: 1, selector: "nav a" },
      { ruleId: "color-contrast", nodeIndex: 2, selector: "footer a" },
      { ruleId: "color-contrast", nodeIndex: 3, selector: ".muted" },
      { ruleId: "image-alt", nodeIndex: 0, selector: "img.hero" },
    ]);
  });
});
