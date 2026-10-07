/**
 * The scan-status write actions, expressed over an injectable GraphQL client so
 * they can be unit-tested without a network (same dependency-injection pattern
 * as the crawler's Fetcher).
 *
 * Every write goes through AppSync. There are no direct DynamoDB writes here —
 * that is the whole point of this Lambda (see CLAUDE.md).
 */

import { explainRules, mapPool, type Explainer } from "./fixes";

/** One axe-core violation on a page, as returned by the scanner. */
export interface ViolationInput {
  ruleId: string;
  impact: "critical" | "serious" | "moderate" | "minor" | null;
  description?: string;
  help?: string;
  helpUrl?: string;
  target?: string;
  html?: string;
}

/** The result of scanning one page, handed from the scanner to this Lambda. */
export interface PageResultInput {
  pageId: string;
  status: "done" | "failed";
  violations: ViolationInput[];
  /** S3 key of the page screenshot, when the scanner managed to store one. */
  screenshotKey?: string;
}

/**
 * The axe-shaped payload the scanner Lambda emits: one entry per *rule*, each
 * carrying every failing *element* in `nodes`. The data model stores one row
 * per element, so this is flattened before writing (see flattenScanResult).
 */
export interface ScannerPageResult {
  pageId: string;
  status: "done" | "failed";
  screenshotKey?: string;
  violations: {
    id: string;
    impact: string | null;
    description?: string;
    help?: string;
    helpUrl?: string;
    nodes: { target?: string; html?: string }[];
  }[];
}

/** Narrow a free-form impact string to the four known axe impacts, else null. */
function asImpact(impact: string | null): ViolationInput["impact"] {
  return impact === "critical" || impact === "serious" || impact === "moderate" || impact === "minor"
    ? impact
    : null;
}

/**
 * Flatten the scanner's rule-grouped violations into one ViolationInput per
 * failing element, renaming axe's `id` to `ruleId`. A rule that somehow carries
 * no nodes still yields one row so the failure isn't silently dropped.
 */
export function flattenScanResult(scan: ScannerPageResult): PageResultInput {
  const violations: ViolationInput[] = [];
  for (const rule of scan.violations) {
    const base = {
      ruleId: rule.id,
      impact: asImpact(rule.impact),
      description: rule.description,
      help: rule.help,
      helpUrl: rule.helpUrl,
    };
    if (rule.nodes.length === 0) {
      violations.push(base);
    } else {
      for (const node of rule.nodes) {
        violations.push({ ...base, target: node.target, html: node.html });
      }
    }
  }
  return {
    pageId: scan.pageId,
    status: scan.status,
    violations,
    ...(scan.screenshotKey ? { screenshotKey: scan.screenshotKey } : {}),
  };
}

/**
 * The minimal GraphQL surface the actions need. The handler supplies a real
 * implementation backed by the Amplify data client; tests supply a fake.
 */
export interface GraphQLClient {
  createPage(input: { scanId: string; url: string }): Promise<{ id: string }>;
  updateScan(input: {
    id: string;
    status?: string;
    pagesDiscovered?: number;
    pagesScanned?: number;
    criticalCount?: number;
    seriousCount?: number;
    moderateCount?: number;
    minorCount?: number;
    startedAt?: string;
    finishedAt?: string;
    error?: string;
  }): Promise<void>;
  updatePage(input: { id: string; status: string; screenshotKey?: string }): Promise<void>;
  createViolation(input: ViolationInput & { pageId: string }): Promise<void>;
  listPages(scanId: string): Promise<{ id: string }[]>;
  listViolations(pageId: string): Promise<ViolationRow[]>;
  updateViolation(input: { id: string; plainEnglishFix: string }): Promise<void>;
}

/** A stored violation row, just the fields the summarizer needs. */
export interface ViolationRow {
  id: string;
  ruleId: string;
  help?: string | null;
  description?: string | null;
}

/**
 * The impact tallies rolled up onto the Scan for the report header. Counts only
 * the four known impacts; a null/unknown impact is ignored.
 */
export function tallyImpacts(violations: ViolationInput[]): {
  criticalCount: number;
  seriousCount: number;
  moderateCount: number;
  minorCount: number;
} {
  const counts = { criticalCount: 0, seriousCount: 0, moderateCount: 0, minorCount: 0 };
  for (const v of violations) {
    if (v.impact === "critical") counts.criticalCount++;
    else if (v.impact === "serious") counts.seriousCount++;
    else if (v.impact === "moderate") counts.moderateCount++;
    else if (v.impact === "minor") counts.minorCount++;
  }
  return counts;
}

/**
 * Register the crawler's discovered pages: create a Page row per URL and move
 * the Scan into the scanning phase with the discovered count. Returns the new
 * page ids paired with their URLs so the Map step can fan out over them.
 */
export async function registerPages(
  client: GraphQLClient,
  scanId: string,
  urls: string[],
): Promise<{ pageId: string; url: string }[]> {
  const pages = await Promise.all(
    urls.map(async (url) => {
      const { id } = await client.createPage({ scanId, url });
      return { pageId: id, url };
    }),
  );
  await client.updateScan({
    id: scanId,
    status: "scanning",
    pagesDiscovered: pages.length,
    pagesScanned: 0,
  });
  return pages;
}

/** The per-page impact deltas returned by recordPageResult. */
export interface ImpactTally {
  criticalCount: number;
  seriousCount: number;
  moderateCount: number;
  minorCount: number;
}

/**
 * Persist one page's scan result: mark the Page done/failed and write its
 * violation rows. Returns just this page's impact tally.
 *
 * It deliberately does NOT touch the Scan's shared counters. The scan Map runs
 * ~10 pages at once, and the data API's update is a full PUT — concurrent
 * read-modify-writes on the Scan would race and lose counts. The browser's
 * progress bar moves off the Page rows themselves (each flips to done/failed
 * live); the Scan's authoritative totals are summed once at the end by
 * finalizeScan. (See the "collect then tally once" decision in DESIGN.md.)
 */
export async function recordPageResult(
  client: GraphQLClient,
  _scanId: string,
  result: PageResultInput,
): Promise<ImpactTally> {
  await client.updatePage({
    id: result.pageId,
    status: result.status,
    ...(result.screenshotKey ? { screenshotKey: result.screenshotKey } : {}),
  });
  for (const v of result.violations) {
    await client.createViolation({ ...v, pageId: result.pageId });
  }
  return tallyImpacts(result.violations);
}

export function sumTallies(tallies: ImpactTally[]): ImpactTally & { pagesScanned: number } {
  const total = { pagesScanned: tallies.length, criticalCount: 0, seriousCount: 0, moderateCount: 0, minorCount: 0 };
  for (const t of tallies) {
    total.criticalCount += t.criticalCount;
    total.seriousCount += t.seriousCount;
    total.moderateCount += t.moderateCount;
    total.minorCount += t.minorCount;
  }
  return total;
}

/**
 * The single, race-free write of the Scan's final counts: sum the Map's
 * per-page tallies, write the rolled-up totals, and mark the Scan done with its
 * finish time.
 */
export async function finalizeScan(
  client: GraphQLClient,
  scanId: string,
  tallies: ImpactTally[],
  finishedAt: string,
): Promise<void> {
  await client.updateScan({
    id: scanId,
    status: "done",
    finishedAt,
    ...sumTallies(tallies),
  });
}

/**
 * Write a plain-English fix onto every violation in the scan. Each axe rule is
 * explained once (see explainRules) and that text is copied onto every row
 * with the same ruleId. Runs after the Map, so it is a single writer and does
 * not race with recordPageResult.
 */
export async function applyPlainEnglishFixes(
  client: GraphQLClient,
  explainer: Explainer,
  scanId: string,
): Promise<{ ruleCount: number; explained: number }> {
  const pages = await client.listPages(scanId);
  const violations: ViolationRow[] = [];
  await mapPool(pages, 8, async (page) => {
    violations.push(...(await client.listViolations(page.id)));
  });

  const fixes = await explainRules(explainer, violations);
  for (const violation of violations) {
    const fix = fixes.get(violation.ruleId);
    if (fix) await client.updateViolation({ id: violation.id, plainEnglishFix: fix });
  }

  return {
    ruleCount: new Set(violations.map((v) => v.ruleId)).size,
    explained: fixes.size,
  };
}
