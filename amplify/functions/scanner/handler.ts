import { scan, type ScanResult } from "./scan";

/** Input: the page to scan. `pageId` is threaded through from the workflow so
 *  the result can be tied back to its Page row without the scanner touching the
 *  data model. */
export interface ScanEvent {
  url: string;
  pageId: string;
}

/**
 * Output: the axe result tagged with the page it belongs to and a done/failed
 * status. The scanner stays a pure "scan a URL" function — it never writes to
 * the data model; scan-status flattens these axe violations into rows (see its
 * recordPageResult). A page that fails to load reports status "failed" with no
 * violations rather than throwing, so one bad page doesn't fail the whole Map.
 */
export interface ScanResponse {
  pageId: string;
  status: "done" | "failed";
  url: string;
  scannedAt: string;
  violations: ScanResult["violations"];
  ruleCount: number;
  elementCount: number;
  error?: string;
}

export const handler = async (event: ScanEvent): Promise<ScanResponse> => {
  try {
    const result = await scan(event.url);
    const elementCount = result.violations.reduce((n, v) => n + v.nodes.length, 0);
    return {
      pageId: event.pageId,
      status: "done",
      ...result,
      ruleCount: result.violations.length,
      elementCount,
    };
  } catch (err) {
    return {
      pageId: event.pageId,
      status: "failed",
      url: event.url,
      scannedAt: new Date().toISOString(),
      violations: [],
      ruleCount: 0,
      elementCount: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};
