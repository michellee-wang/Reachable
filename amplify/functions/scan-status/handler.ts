import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/scan-status";
import type { Schema } from "../../data/resource";
import {
  GraphQLClient,
  ImpactTally,
  ScannerPageResult,
  ViolationRow,
  applyPlainEnglishFixes,
  finalizeScan,
  flattenScanResult,
  recordPageResult,
  registerPages,
} from "./actions";
import { bedrockClient, createBedrockExplainer } from "./bedrock";

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
  async listPages(scanId) {
    return listAll(`listPages ${scanId}`, (nextToken) =>
      data.models.Page.list({ filter: { scanId: { eq: scanId } }, nextToken }),
    ).then((pages) => pages.map((page) => ({ id: page.id })));
  },
  async listViolations(pageId) {
    return listAll(`listViolations ${pageId}`, (nextToken) =>
      data.models.Violation.list({ filter: { pageId: { eq: pageId } }, nextToken }),
    ).then((rows) =>
      rows.map(
        (row): ViolationRow => ({
          id: row.id,
          ruleId: row.ruleId,
          help: row.help,
          description: row.description,
        }),
      ),
    );
  },
  async updateViolation(input) {
    const { errors } = await data.models.Violation.update(input);
    if (errors) throw new Error(`updateViolation: ${JSON.stringify(errors)}`);
  },
};

/**
 * Follow an Amplify list's nextToken until the model is exhausted. A scan is
 * capped around 200 pages, so this stays small, but a single page can still
 * return a partial page of violations.
 */
async function listAll<T extends { id: string }>(
  label: string,
  fetch: (nextToken?: string) => Promise<{
    data: T[];
    errors?: { message: string }[] | null;
    nextToken?: string | null;
  }>,
): Promise<T[]> {
  const out: T[] = [];
  let nextToken: string | undefined;
  do {
    const page = await fetch(nextToken);
    if (page.errors?.length) throw new Error(`${label}: ${JSON.stringify(page.errors)}`);
    out.push(...page.data);
    nextToken = page.nextToken ?? undefined;
  } while (nextToken);
  return out;
}

const explainer = createBedrockExplainer(bedrockClient(), env.BEDROCK_MODEL_ID);

/**
 * One event per workflow stage, discriminated by `action`. The state machine
 * picks the action; the payload carries just what that action writes.
 */
export type StatusEvent =
  | { action: "beginScan"; scanId: string }
  | { action: "markFailed"; scanId: string; error?: string }
  | { action: "registerPages"; scanId: string; urls: string[] }
  | {
      action: "recordPageResult";
      scanId: string;
      // The scanner's raw axe-shaped payload; flattened to rows here.
      result: ScannerPageResult;
    }
  | { action: "finish"; scanId: string; tallies: ImpactTally[]; finishedAt: string }
  | { action: "summarize"; scanId: string };

export const handler = async (event: StatusEvent) => {
  switch (event.action) {
    case "beginScan": {
      // The Scan row already exists (start-scan created it). Flip it into
      // crawling and stamp the start time.
      await client.updateScan({
        id: event.scanId,
        status: "crawling",
        startedAt: new Date().toISOString(),
      });
      return { scanId: event.scanId };
    }

    case "markFailed": {
      // The only non-happy-path status write: a step exhausted its retries, so
      // flip the Scan to "failed" (with the error) and the browser stops waiting.
      await client.updateScan({
        id: event.scanId,
        status: "failed",
        ...(event.error ? { error: event.error } : {}),
      });
      return { scanId: event.scanId };
    }

    case "registerPages": {
      const pages = await registerPages(client, event.scanId, event.urls);
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

    case "summarize": {
      // Flip the status first so the browser can show "writing fixes" while
      // the model calls run. A rule that Bedrock can't explain is left blank;
      // the UI falls back to axe's description.
      await client.updateScan({ id: event.scanId, status: "summarizing" });
      const summary = await applyPlainEnglishFixes(client, explainer, event.scanId);
      return { scanId: event.scanId, ...summary };
    }
  }
};
