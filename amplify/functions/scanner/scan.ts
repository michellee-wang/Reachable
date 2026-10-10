import AxeBuilder from "@axe-core/playwright";
import { chromium, type Page } from "playwright";
import { nodesToCrop } from "./crops";

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
  /** Set by the handler after the crop is stored. Never a buffer. */
  screenshotKey?: string;
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

export interface ElementCrop {
  ruleId: string;
  nodeIndex: number;
  png: Buffer;
}

export interface ScanOutput {
  result: ScanResult;
  /**
   * Crops of failing elements. Empty when the page has no violations.
   * The handler uploads these and returns only the object keys.
   */
  crops: ElementCrop[];
}

/** Keep a crop small. A huge target (html, main) must not become a full-page capture. */
const CROP_PAD = 12;
const CROP_MAX_WIDTH = 1280;
const CROP_MAX_HEIGHT = 480;

/**
 * Scroll the element into view and capture it, with a little surrounding
 * context. Clip coordinates are viewport-relative. A miss is not a failed page.
 */
async function cropElement(page: Page, selector: string): Promise<Buffer | null> {
  try {
    const locator = page.locator(selector).first();
    await locator.scrollIntoViewIfNeeded({ timeout: 2_000 });
    const box = await locator.boundingBox();
    if (!box || box.width < 1 || box.height < 1) return null;

    const viewport = page.viewportSize() ?? { width: CROP_MAX_WIDTH, height: 800 };
    const x = Math.max(0, Math.floor(box.x - CROP_PAD));
    const y = Math.max(0, Math.floor(box.y - CROP_PAD));
    const width = Math.min(
      CROP_MAX_WIDTH,
      Math.ceil(box.width + CROP_PAD * 2),
      viewport.width - x,
    );
    const height = Math.min(
      CROP_MAX_HEIGHT,
      Math.ceil(box.height + CROP_PAD * 2),
      viewport.height - y,
    );
    if (width < 1 || height < 1) return null;

    return await page.screenshot({
      type: "png",
      animations: "disabled",
      clip: { x, y, width, height },
    });
  } catch {
    return null;
  }
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

    // Clean pages are not photographed. Crops are taken from the raw axe
    // targets, before they are flattened into the display string.
    const crops: ElementCrop[] = [];
    for (const pick of nodesToCrop(raw.violations)) {
      const png = await cropElement(page, pick.selector);
      if (png) crops.push({ ruleId: pick.ruleId, nodeIndex: pick.nodeIndex, png });
    }

    return {
      result: {
        url,
        scannedAt: new Date().toISOString(),
        violations,
      },
      crops,
    };
  } finally {
    await browser.close();
  }
}
