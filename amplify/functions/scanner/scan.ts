import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";

/**
 * The accessibility scan: load a page in headless Chromium, run axe-core, and
 * return violations ranked by impact. This is the same logic as the local
 * `scanner/` dev tool, adapted to run inside the Chromium Lambda container
 * (URL-only — no local-file scanning in the cloud).
 *
 * It finds common issues. It does not certify WCAG compliance.
 */

const IMPACT_ORDER = ["critical", "serious", "moderate", "minor"];

export interface ScanNode {
  target: string;
  html: string;
  failureSummary?: string;
}

export interface ScanViolation {
  id: string;
  impact: string | null;
  description: string;
  help: string;
  helpUrl: string;
  nodes: ScanNode[];
}

export interface ScanResult {
  url: string;
  scannedAt: string;
  violations: ScanViolation[];
}

function byImpact(a: ScanViolation, b: ScanViolation): number {
  const ai = IMPACT_ORDER.indexOf(a.impact ?? "");
  const bi = IMPACT_ORDER.indexOf(b.impact ?? "");
  return (ai === -1 ? IMPACT_ORDER.length : ai) - (bi === -1 ? IMPACT_ORDER.length : bi);
}

export interface ScanOutput {
  result: ScanResult;
  /**
   * Viewport PNG. A full-page capture of a long page is large enough to blow
   * the Lambda's memory, and the image never rides the Step Functions payload
   * (the handler uploads this buffer and returns only the object key).
   */
  screenshot: Buffer;
}

export async function scan(url: string): Promise<ScanOutput> {
  if (!/^https?:\/\//.test(url)) {
    throw new Error(`scan requires an http(s) URL, got: ${url}`);
  }

  // Flags Chromium needs under the Lambda sandbox (no /dev/shm, no sandbox).
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--single-process"],
  });

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

    // Tags axe ships for WCAG 2.x A/AA, including 2.2.
    const raw = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();

    const violations: ScanViolation[] = raw.violations.map((v) => ({
      id: v.id,
      impact: v.impact ?? null,
      description: v.description,
      help: v.help,
      helpUrl: v.helpUrl,
      nodes: v.nodes.map((n) => ({
        target: n.target.flat().join(" "),
        html: n.html,
        failureSummary: n.failureSummary,
      })),
    }));

    violations.sort(byImpact);

    const screenshot = await page.screenshot({ type: "png" });

    return {
      result: {
        url,
        scannedAt: new Date().toISOString(),
        violations,
      },
      screenshot,
    };
  } finally {
    await browser.close();
  }
}
