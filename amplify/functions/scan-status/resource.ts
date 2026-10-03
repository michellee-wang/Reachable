import { defineFunction } from "@aws-amplify/backend";

/**
 * The scan-status Lambda: the single writer that pushes all scan progress
 * *through AppSync* (never a direct DynamoDB write — see CLAUDE.md), so the
 * browser's live progress bar moves.
 *
 * The Step Functions workflow calls it at each stage: create the Scan record,
 * flip status (crawling -> scanning -> summarizing -> done/failed), record the
 * pages the crawler found, and persist each page's scan result + violations.
 *
 * It is granted query+mutate access to the data API via allow.resource() in
 * amplify/data/resource.ts.
 */
export const scanStatus = defineFunction({
  name: "scan-status",
  entry: "./handler.ts",
  timeoutSeconds: 60,
  memoryMB: 256,
});
