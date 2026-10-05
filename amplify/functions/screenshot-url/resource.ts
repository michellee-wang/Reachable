import { defineFunction } from "@aws-amplify/backend";

/**
 * Presigns a GET for one screenshot. The bucket is private; the browser never
 * holds AWS credentials. backend.ts fills in the real bucket name.
 */
export const screenshotUrl = defineFunction({
  name: "screenshot-url",
  entry: "./handler.ts",
  timeoutSeconds: 10,
  memoryMB: 256,
  environment: {
    SCREENSHOT_BUCKET: "",
  },
});
