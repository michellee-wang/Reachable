import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { scan, type ScanResult } from "./scan";

const s3 = new S3Client({});

// pageId/scanId are threaded through from the workflow so we can tie the result
// back to its Page row and key the screenshot, without the scanner touching the
// data model.
export interface ScanEvent {
  url: string;
  pageId: string;
  scanId: string;
}

// A page that fails to load comes back as status "failed" with no violations,
// not a thrown error, so one bad page doesn't fail the whole Map.
export interface ScanResponse {
  pageId: string;
  status: "done" | "failed";
  url: string;
  scannedAt: string;
  violations: ScanResult["violations"];
  ruleCount: number;
  elementCount: number;
  screenshotKey?: string;
  error?: string;
}

/** Upload the PNG. A failed upload must not fail the page: the axe result is
 *  the scan, and the screenshot is extra. */
async function storeScreenshot(scanId: string, pageId: string, body: Buffer): Promise<string | undefined> {
  const bucket = process.env.SCREENSHOT_BUCKET;
  if (!bucket || !scanId || !pageId) return undefined;
  const key = `${scanId}/${pageId}.png`;
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: "image/png",
      }),
    );
    return key;
  } catch (err) {
    console.error("screenshot upload failed", err instanceof Error ? err.message : err);
    return undefined;
  }
}

export const handler = async (event: ScanEvent): Promise<ScanResponse> => {
  try {
    const { result, screenshot } = await scan(event.url);
    const elementCount = result.violations.reduce((n, v) => n + v.nodes.length, 0);
    const screenshotKey = await storeScreenshot(event.scanId, event.pageId, screenshot);
    return {
      pageId: event.pageId,
      status: "done",
      ...result,
      ruleCount: result.violations.length,
      elementCount,
      ...(screenshotKey ? { screenshotKey } : {}),
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
