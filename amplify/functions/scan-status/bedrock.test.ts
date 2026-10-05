import { ConverseCommand, type ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it } from "vitest";
import {
  ConverseClient,
  FIX_MAX_TOKENS,
  FIX_SYSTEM_PROMPT,
  buildFixPrompt,
  createBedrockExplainer,
} from "./bedrock";

function scripted(texts: string[]): { client: ConverseClient; commands: ConverseCommand[] } {
  const commands: ConverseCommand[] = [];
  const queue = [...texts];
  const client: ConverseClient = {
    async send(command) {
      commands.push(command);
      const text = queue.shift() ?? "";
      const output: ConverseCommandOutput = {
        $metadata: {},
        output: { message: { role: "assistant", content: [{ text }] } },
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        metrics: { latencyMs: 0 },
      };
      return output;
    },
  };
  return { client, commands };
}

describe("buildFixPrompt", () => {
  it("includes the rule id and axe's own wording, not the page html", () => {
    const prompt = buildFixPrompt({
      ruleId: "button-name",
      help: "Buttons must have discernible text",
      description: "Ensures buttons have discernible text",
    });
    expect(prompt).toContain("button-name");
    expect(prompt).toContain("Buttons must have discernible text");
    expect(prompt).not.toContain("<");
  });

  it("still produces a prompt when axe omitted the help text", () => {
    expect(buildFixPrompt({ ruleId: "region" })).toContain("No short help text.");
  });
});

describe("createBedrockExplainer", () => {
  it("asks for a short answer and caches a rule so the model is called once", async () => {
    const { client, commands } = scripted(["Give the button a name."]);
    const explainer = createBedrockExplainer(client, "us.amazon.nova-micro-v1:0");

    const first = await explainer.explain({ ruleId: "button-name", help: "name it" });
    const second = await explainer.explain({ ruleId: "button-name", help: "name it" });

    expect(first).toBe("Give the button a name.");
    expect(second).toBe("Give the button a name.");
    expect(commands).toHaveLength(1);

    const input = commands[0].input;
    expect(input.modelId).toBe("us.amazon.nova-micro-v1:0");
    expect(input.inferenceConfig?.maxTokens).toBe(FIX_MAX_TOKENS);
    expect(input.system?.[0].text).toBe(FIX_SYSTEM_PROMPT);
  });

  it("does not cache an empty answer", async () => {
    const { client, commands } = scripted(["", "Now a real fix."]);
    const explainer = createBedrockExplainer(client, "model");

    expect(await explainer.explain({ ruleId: "image-alt" })).toBe("");
    expect(await explainer.explain({ ruleId: "image-alt" })).toBe("Now a real fix.");
    expect(commands).toHaveLength(2);
  });
});
