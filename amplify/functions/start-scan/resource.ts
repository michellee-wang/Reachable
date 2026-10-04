import { defineFunction } from "@aws-amplify/backend";

/**
 * The start-scan Lambda: the only public write path (behind the startScan
 * mutation). It validates the URL (also an SSRF boundary — see validate.ts),
 * creates the Scan record, kicks off the Step Functions workflow, and returns
 * the new scanId for the browser to read/subscribe to.
 *
 * The state machine ARN is injected as an env var and start-execution
 * permission is granted in backend.ts (the state machine is built there).
 */
export const startScan = defineFunction({
  name: "start-scan",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  memoryMB: 256,
});
