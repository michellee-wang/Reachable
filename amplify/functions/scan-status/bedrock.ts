import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import type { Explainer, RuleToExplain } from "./fixes";

/**
 * Bedrock Converse call for one axe rule.
 *
 * The prompt uses only axe's own rule text, never the scanned page's HTML, so
 * a hostile page can't steer the model and the same rule always gets the same
 * fix (which is what makes the per-rule cache valid).
 *
 * maxTokens is set on purpose: leaving it unset reserves the model's whole
 * output budget and throttles a scan that only needs a sentence or two.
 */

export const FIX_MAX_TOKENS = 200;

export const FIX_SYSTEM_PROMPT =
  "You write one or two short sentences telling a website owner how to fix one accessibility issue. Use plain language. No preamble, no list, and do not mention that you are a model.";

export function buildFixPrompt(rule: RuleToExplain): string {
  const help = rule.help?.trim() || "No short help text.";
  const description = rule.description?.trim() || "No description.";
  return `Rule id: ${rule.ruleId}\nWhat the checker says: ${help}\nDetails: ${description}`;
}

/** The slice of the Bedrock client the explainer actually calls. */
export interface ConverseClient {
  send(command: ConverseCommand): Promise<ConverseCommandOutput>;
}

export function createBedrockExplainer(client: ConverseClient, modelId: string): Explainer {
  // Lives for the life of this Lambda container, so a warm start does not pay
  // for a rule it already explained on an earlier scan.
  const cache = new Map<string, string>();

  return {
    async explain(rule) {
      const cached = cache.get(rule.ruleId);
      if (cached) return cached;

      const response = await client.send(
        new ConverseCommand({
          modelId,
          system: [{ text: FIX_SYSTEM_PROMPT }],
          messages: [{ role: "user", content: [{ text: buildFixPrompt(rule) }] }],
          inferenceConfig: { maxTokens: FIX_MAX_TOKENS, temperature: 0.2 },
        }),
      );

      const text =
        response.output?.message?.content?.map((block) => block.text ?? "").join("").trim() ?? "";
      if (text) cache.set(rule.ruleId, text);
      return text;
    },
  };
}

export function bedrockClient(): BedrockRuntimeClient {
  // Region comes from AWS_REGION in the Lambda environment. Adaptive retry
  // backs off when the model throttles instead of failing the whole scan.
  return new BedrockRuntimeClient({ maxAttempts: 5, retryMode: "adaptive" });
}
