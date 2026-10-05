import { defineFunction } from "@aws-amplify/backend";

/**
 * The scan-status Lambda: the single writer that pushes all scan progress
 * *through AppSync* (never a direct DynamoDB write — see CLAUDE.md), so the
 * browser's live progress bar moves.
 *
 * The Step Functions workflow calls it at each stage: create the Scan record,
 * flip status (crawling -> scanning -> summarizing -> done/failed), record the
 * pages the crawler found, persist each page's scan result + violations, and
 * write the cached plain-English fix for each axe rule.
 *
 * It is granted query+mutate access to the data API via allow.resource() in
 * amplify/data/resource.ts. Bedrock invoke permission is granted in backend.ts.
 *
 * Cross-region inference profile (us. prefix) so a throttle in one region can
 * spill to another. Nova Micro is the cheap, fast model: these prompts are one
 * rule and a couple of sentences, not a reasoning task.
 */
export const BEDROCK_MODEL_ID = "us.amazon.nova-micro-v1:0";

/** Foundation-model id behind that profile, used for the IAM resource ARN. */
export const BEDROCK_FOUNDATION_MODEL_ID = "amazon.nova-micro-v1:0";

export const scanStatus = defineFunction({
  name: "scan-status",
  entry: "./handler.ts",
  // Summarize calls the model once per distinct axe rule. 60s was enough to
  // flip a status; it is not enough to explain a few dozen rules.
  timeoutSeconds: 180,
  memoryMB: 512,
  environment: {
    BEDROCK_MODEL_ID,
  },
});
