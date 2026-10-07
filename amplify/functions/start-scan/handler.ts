import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { env } from "$amplify/env/start-scan";
import type { Schema } from "../../data/resource";
import { validateScanUrl } from "./validate";

/**
 * start-scan: the only public write path. Validates the URL (SSRF boundary),
 * creates the Scan row, starts the Step Functions workflow seeded with the new
 * scanId, and returns { scanId, url } — the capability the browser then uses to
 * read and subscribe to its scan.
 */

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
const data = generateClient<Schema>({ authMode: "iam" });
const sfn = new SFNClient();

type StartScanArgs = { arguments: { url: string } };

export const handler = async (event: StartScanArgs) => {
  const result = validateScanUrl(event.arguments.url);
  if (!result.ok) {
    // Surfaced to the caller as a GraphQL error.
    throw new Error(result.reason);
  }

  // Create the Scan up front so the browser has an id to watch immediately; the
  // workflow advances this same record (it does not create its own). The ttl is
  // ~1 hour out (epoch seconds) — DynamoDB auto-deletes the row after that.
  const ttl = Math.floor(Date.now() / 1000) + 60 * 60;
  const { data: scan, errors: scanErrors } = await data.models.Scan.create({
    domain: result.domain,
    status: "pending",
    ttl,
  });
  if (scanErrors || !scan) throw new Error(`createScan: ${JSON.stringify(scanErrors)}`);

  await sfn.send(
    new StartExecutionCommand({
      stateMachineArn: env.SCAN_WORKFLOW_ARN,
      input: JSON.stringify({ scanId: scan.id, startUrl: result.url }),
    }),
  );

  return { scanId: scan.id, url: result.url };
};
