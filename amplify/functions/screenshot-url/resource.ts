import { defineFunction } from "@aws-amplify/backend";

/**
 * Presigns a GET for one screenshot. The bucket is private; the browser never
 * holds AWS credentials. backend.ts fills in the real bucket name.
 */
export const screenshotUrl = defineFunction({
  name: "screenshot-url",
  // Same stack as the data API: the API resolves startScan/screenshotUrl to
  // these functions and grants them data access back, and the workflow (also
  // in the data stack) invokes them while start-scan holds its ARN. Separate
  // stacks would reference each other in a loop CloudFormation rejects.
  resourceGroupName: "data",
  entry: "./handler.ts",
  timeoutSeconds: 10,
  memoryMB: 256,
  environment: {
    SCREENSHOT_BUCKET: "",
  },
});
