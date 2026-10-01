import { defineFunction } from "@aws-amplify/backend";

/**
 * The crawler Lambda: given a start URL, discovers up to ~200 same-domain
 * public pages, honoring robots.txt. Invoked as the first step of the scan
 * workflow (Step Functions).
 */
export const crawler = defineFunction({
  name: "crawler",
  entry: "./handler.ts",
  timeoutSeconds: 120,
  memoryMB: 512,
});
