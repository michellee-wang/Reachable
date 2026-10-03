import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/scan-status";
import type { Schema } from "../../data/resource";
import {
  GraphQLClient,
  ImpactTally,
  ScannerPageResult,
  finalizeScan,
  flattenScanResult,
  recordPageResult,
  registerPages,
} from "./actions";

/**
 * The scan-status Lambda. The testable write logic lives in actions.ts behind a
 * GraphQLClient interface; this file is the thin AWS-facing shell: configure
 * Amplify, build the real client, and dispatch the Step Functions event.
 *
 * It is the single writer of scan progress, and it writes *through AppSync*
 * (generateClient, below) — never a direct DynamoDB write (see CLAUDE.md), so
 * the browser's live subscription moves the progress bar.
 */

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);

// IAM auth: the function's execution role is granted mutate/query access to the
// data API in amplify/data/resource.ts.
const data = generateClient<Schema>({ authMode: "iam" });

/**
 * Adapt the Amplify data client to the minimal GraphQLClient the actions need.
 * Each method unwraps { data, errors } and throws on error so a failed write
 * fails the state and Step Functions can retry it.
 */
const client: GraphQLClient = {
  async createScan(input) {
    const { data: scan, errors } = await data.models.Scan.create({
      siteId: input.siteId,
      status: "pending",
    });
    if (errors || !scan) throw new Error(`createScan: ${JSON.stringify(errors)}`);
    return { id: scan.id };
  },
  async createPage(input) {
    const { data: page, errors } = await data.models.Page.create({
      scanId: input.scanId,
      url: input.url,
      status: "pending",
    });
    if (errors || !page) throw new Error(`createPage: ${JSON.stringify(errors)}`);
    return { id: page.id };
  },
  async updateScan(input) {
    // The GraphQLClient interface types status/fields as plain strings for
    // testability; the generated client wants the enum literals. The state
    // machine only ever supplies valid values, so assert the model's type here.
    const { errors } = await data.models.Scan.update(
      input as Parameters<typeof data.models.Scan.update>[0],
    );
    if (errors) throw new Error(`updateScan: ${JSON.stringify(errors)}`);
  },
  async updatePage(input) {
    const { errors } = await data.models.Page.update(
      input as Parameters<typeof data.models.Page.update>[0],
    );
    if (errors) throw new Error(`updatePage: ${JSON.stringify(errors)}`);
  },
  async createViolation(input) {
    const { errors } = await data.models.Violation.create(input);
    if (errors) throw new Error(`createViolation: ${JSON.stringify(errors)}`);
  },
};

/**
 * One event per workflow stage, discriminated by `action`. The state machine
 * picks the action; the payload carries just what that action writes.
 */
export type StatusEvent =
  | { action: "createScan"; siteId: string }
  | { action: "setStatus"; scanId: string; status: string; error?: string }
  | { action: "registerPages"; scanId: string; urls: string[] }
  | {
      action: "recordPageResult";
      scanId: string;
      // The scanner's raw axe-shaped payload; flattened to rows here.
      result: ScannerPageResult;
    }
  | { action: "finish"; scanId: string; tallies: ImpactTally[]; finishedAt: string };

export const handler = async (event: StatusEvent) => {
  switch (event.action) {
    case "createScan": {
      const { id } = await client.createScan({ siteId: event.siteId });
      // Stamp the start and flip into crawling in one update.
      await client.updateScan({
        id,
        status: "crawling",
        startedAt: new Date().toISOString(),
      });
      return { scanId: id };
    }

    case "setStatus": {
      await client.updateScan({
        id: event.scanId,
        status: event.status,
        ...(event.error ? { error: event.error } : {}),
      });
      return { scanId: event.scanId };
    }

    case "registerPages": {
      const pages = await registerPages(client, event.scanId, event.urls);
      // Hand the Map its work-list.
      return { pages };
    }

    case "recordPageResult": {
      // Returns only this page's tally; the Map collects them. The Scan's
      // shared counters are written once in "finish" to avoid a parallel race.
      const tally = await recordPageResult(
        client,
        event.scanId,
        flattenScanResult(event.result),
      );
      return { tally };
    }

    case "finish": {
      await finalizeScan(client, event.scanId, event.tallies, event.finishedAt);
      return { scanId: event.scanId };
    }
  }
};
