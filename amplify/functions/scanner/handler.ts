import { scan, type ScanResult } from "./scan";

/** Input: the page to scan. */
export interface ScanEvent {
  url: string;
}

/** Output: the scan result plus a count summary. */
export interface ScanResponse extends ScanResult {
  ruleCount: number;
  elementCount: number;
}

export const handler = async (event: ScanEvent): Promise<ScanResponse> => {
  const result = await scan(event.url);
  const elementCount = result.violations.reduce((n, v) => n + v.nodes.length, 0);
  return {
    ...result,
    ruleCount: result.violations.length,
    elementCount,
  };
};
