import { describe, expect, it } from "vitest";
import { Explainer, RuleToExplain, explainRules } from "./fixes";

function fakeExplainer(impl: (rule: RuleToExplain) => Promise<string> | string): {
  explainer: Explainer;
  calls: RuleToExplain[];
} {
  const calls: RuleToExplain[] = [];
  return {
    calls,
    explainer: {
      async explain(rule) {
        calls.push(rule);
        return impl(rule);
      },
    },
  };
}

describe("explainRules", () => {
  it("explains each rule id once and reuses that text", async () => {
    const { explainer, calls } = fakeExplainer(async (rule) => `Fix ${rule.ruleId}.`);
    const fixes = await explainRules(explainer, [
      { ruleId: "image-alt", help: "add alt" },
      { ruleId: "button-name", help: "name the button" },
      { ruleId: "image-alt", help: "add alt" },
    ]);

    expect(calls.map((c) => c.ruleId).sort()).toEqual(["button-name", "image-alt"]);
    expect(fixes.get("image-alt")).toBe("Fix image-alt.");
    expect(fixes.get("button-name")).toBe("Fix button-name.");
  });

  it("drops a rule whose explanation is blank or throws", async () => {
    const { explainer } = fakeExplainer(async (rule) => {
      if (rule.ruleId === "blank") return "   ";
      if (rule.ruleId === "boom") throw new Error("throttled");
      return "Add a label.";
    });

    const fixes = await explainRules(explainer, [
      { ruleId: "blank" },
      { ruleId: "boom" },
      { ruleId: "label" },
    ]);

    expect([...fixes.keys()]).toEqual(["label"]);
    expect(fixes.get("label")).toBe("Add a label.");
  });

  it("returns an empty map when there is nothing to explain", async () => {
    const { explainer, calls } = fakeExplainer(async () => "unused");
    const fixes = await explainRules(explainer, []);
    expect(fixes.size).toBe(0);
    expect(calls).toEqual([]);
  });
});
