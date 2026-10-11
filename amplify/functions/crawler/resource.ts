import { defineFunction } from "@aws-amplify/backend";

/**
 * The crawler Lambda: given a start URL, discovers up to ~200 same-domain
 * public pages, honoring robots.txt. Invoked as the first step of the scan
 * workflow (Step Functions).
 */
export const crawler = defineFunction({
  name: "crawler",
  // Same stack as the data API: the API resolves startScan/screenshotUrl to
  // these functions and grants them data access back, and the workflow (also
  // in the data stack) invokes them while start-scan holds its ARN. Separate
  // stacks would reference each other in a loop CloudFormation rejects.
  resourceGroupName: "data",
  entry: "./handler.ts",
  timeoutSeconds: 120,
  memoryMB: 512,
});
