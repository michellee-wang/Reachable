import { describe, expect, it } from "vitest";
import {
  GraphQLClient,
  PageResultInput,
  ScannerPageResult,
  ViolationInput,
  finalizeScan,
  flattenScanResult,
  recordPageResult,
  registerPages,
  sumTallies,
  tallyImpacts,
} from "./actions";

/**
 * A fake GraphQL client that records every call and hands back predictable ids,
 * so the write logic can be tested without AppSync (mirrors the crawler's
 * MapFetcher).
 */
class FakeClient implements GraphQLClient {
  calls: { op: string; input: unknown }[] = [];
  private seq = 0;

  async createScan(input: { siteId: string }) {
    this.calls.push({ op: "createScan", input });
    return { id: `scan-${++this.seq}` };
  }
  async createPage(input: { scanId: string; url: string }) {
    this.calls.push({ op: "createPage", input });
    return { id: `page-${++this.seq}` };
  }
  async updateScan(input: Record<string, unknown>) {
    this.calls.push({ op: "updateScan", input });
  }
  async updatePage(input: { id: string; status: string }) {
    this.calls.push({ op: "updatePage", input });
  }
  async createViolation(input: ViolationInput & { pageId: string }) {
    this.calls.push({ op: "createViolation", input });
  }

  opsOf(op: string) {
    return this.calls.filter((c) => c.op === op).map((c) => c.input);
  }
}

const violation = (impact: ViolationInput["impact"], ruleId = "rule"): ViolationInput => ({
  ruleId,
  impact,
});

describe("tallyImpacts", () => {
  it("counts each known impact and ignores null/unknown", () => {
    const counts = tallyImpacts([
      violation("critical"),
      violation("critical"),
      violation("serious"),
      violation("moderate"),
      violation("minor"),
      violation(null),
    ]);
    expect(counts).toEqual({
      criticalCount: 2,
      seriousCount: 1,
      moderateCount: 1,
      minorCount: 1,
    });
  });

  it("is all zeros for no violations", () => {
    expect(tallyImpacts([])).toEqual({
      criticalCount: 0,
      seriousCount: 0,
      moderateCount: 0,
      minorCount: 0,
    });
  });
});

describe("registerPages", () => {
  it("creates a page per url and moves the scan into scanning", async () => {
    const client = new FakeClient();
    const urls = ["https://a.test/", "https://a.test/about", "https://a.test/contact"];

    const pages = await registerPages(client, "scan-1", urls);

    expect(pages).toHaveLength(3);
    expect(pages.map((p) => p.url)).toEqual(urls);
    expect(pages.every((p) => p.pageId.startsWith("page-"))).toBe(true);

    expect(client.opsOf("createPage")).toHaveLength(3);
    const update = client.opsOf("updateScan")[0] as Record<string, unknown>;
    expect(update).toMatchObject({
      id: "scan-1",
      status: "scanning",
      pagesDiscovered: 3,
      pagesScanned: 0,
    });
  });

  it("handles an empty crawl", async () => {
    const client = new FakeClient();
    const pages = await registerPages(client, "scan-1", []);
    expect(pages).toEqual([]);
    expect(client.opsOf("updateScan")[0]).toMatchObject({ pagesDiscovered: 0 });
  });
});

describe("recordPageResult", () => {
  it("marks the page done, writes violations, and returns this page's tally", async () => {
    const client = new FakeClient();
    const result: PageResultInput = {
      pageId: "page-1",
      status: "done",
      violations: [violation("critical", "button-name"), violation("minor", "region")],
    };

    const tally = await recordPageResult(client, "scan-1", result);

    expect(client.opsOf("updatePage")[0]).toEqual({ id: "page-1", status: "done" });
    expect(client.opsOf("createViolation")).toHaveLength(2);
    expect(client.opsOf("createViolation")[0]).toMatchObject({ pageId: "page-1", ruleId: "button-name" });

    expect(tally).toEqual({
      criticalCount: 1,
      seriousCount: 0,
      moderateCount: 0,
      minorCount: 1,
    });
    // It must NOT touch the Scan's shared counters — that is finalizeScan's job,
    // written once to avoid a parallel-Map race.
    expect(client.opsOf("updateScan")).toHaveLength(0);
  });

  it("records a failed page with no violations", async () => {
    const client = new FakeClient();
    const tally = await recordPageResult(
      client,
      "scan-1",
      { pageId: "p1", status: "failed", violations: [] },
    );
    expect(client.opsOf("updatePage")[0]).toEqual({ id: "p1", status: "failed" });
    expect(client.opsOf("createViolation")).toHaveLength(0);
    expect(tally).toEqual({ criticalCount: 0, seriousCount: 0, moderateCount: 0, minorCount: 0 });
  });
});

describe("sumTallies", () => {
  it("sums per-page tallies and counts pages scanned", () => {
    const total = sumTallies([
      { criticalCount: 1, seriousCount: 0, moderateCount: 0, minorCount: 2 },
      { criticalCount: 0, seriousCount: 3, moderateCount: 1, minorCount: 0 },
    ]);
    expect(total).toEqual({
      pagesScanned: 2,
      criticalCount: 1,
      seriousCount: 3,
      moderateCount: 1,
      minorCount: 2,
    });
  });

  it("is zero pages with all zero counts for no results", () => {
    expect(sumTallies([])).toEqual({
      pagesScanned: 0,
      criticalCount: 0,
      seriousCount: 0,
      moderateCount: 0,
      minorCount: 0,
    });
  });
});

describe("finalizeScan", () => {
  it("writes the rolled-up totals and marks the scan done in one update", async () => {
    const client = new FakeClient();
    await finalizeScan(
      client,
      "scan-1",
      [
        { criticalCount: 2, seriousCount: 0, moderateCount: 0, minorCount: 0 },
        { criticalCount: 1, seriousCount: 1, moderateCount: 0, minorCount: 0 },
      ],
      "2026-10-06T00:00:00.000Z",
    );
    const updates = client.opsOf("updateScan");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      id: "scan-1",
      status: "done",
      finishedAt: "2026-10-06T00:00:00.000Z",
      pagesScanned: 2,
      criticalCount: 3,
      seriousCount: 1,
      moderateCount: 0,
      minorCount: 0,
    });
  });
});

describe("flattenScanResult", () => {
  const axe = (overrides: Partial<ScannerPageResult> = {}): ScannerPageResult => ({
    pageId: "page-1",
    status: "done",
    violations: [
      {
        id: "image-alt",
        impact: "critical",
        description: "Images must have alt text",
        help: "add alt",
        helpUrl: "https://x/image-alt",
        nodes: [
          { target: "img.hero", html: "<img class=hero>" },
          { target: "img.logo", html: "<img class=logo>" },
        ],
      },
    ],
    ...overrides,
  });

  it("flattens one row per failing element, renaming id to ruleId", () => {
    const flat = flattenScanResult(axe());
    expect(flat.pageId).toBe("page-1");
    expect(flat.status).toBe("done");
    expect(flat.violations).toHaveLength(2);
    expect(flat.violations[0]).toEqual({
      ruleId: "image-alt",
      impact: "critical",
      description: "Images must have alt text",
      help: "add alt",
      helpUrl: "https://x/image-alt",
      target: "img.hero",
      html: "<img class=hero>",
    });
    expect(flat.violations[1].target).toBe("img.logo");
  });

  it("narrows an unknown impact to null", () => {
    const flat = flattenScanResult(
      axe({ violations: [{ id: "r", impact: "cosmetic", nodes: [{ target: "a", html: "<a>" }] }] }),
    );
    expect(flat.violations[0].impact).toBeNull();
  });

  it("keeps one row for a rule that carries no nodes", () => {
    const flat = flattenScanResult(
      axe({ violations: [{ id: "html-has-lang", impact: "serious", nodes: [] }] }),
    );
    expect(flat.violations).toHaveLength(1);
    expect(flat.violations[0]).toMatchObject({ ruleId: "html-has-lang", impact: "serious" });
    expect(flat.violations[0].target).toBeUndefined();
  });

  it("carries a failed page through with no violations", () => {
    const flat = flattenScanResult({ pageId: "p9", status: "failed", violations: [] });
    expect(flat).toEqual({ pageId: "p9", status: "failed", violations: [] });
  });
});
