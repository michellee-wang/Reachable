import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { scan, type ScanResult } from "./scan";

const s3 = new S3Client({});

// pageId/scanId are threaded through from the workflow so the result can be
// tied back to its Page row. Crop keys are stamped onto nodes here; the
// scanner still does not know about the data model.
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
  error?: string;
}

/** Upload one element crop. A failed upload must not fail the page: the axe
 *  result is the scan, and the picture is extra. The key is `{scanId}/{uuid}.png`,
 *  the same shape the public presign check allows. */
async function storeScreenshot(scanId: string, body: Buffer): Promise<string | undefined> {
  const bucket = process.env.SCREENSHOT_BUCKET;
  if (!bucket || !scanId) return undefined;
  const key = `${scanId}/${randomUUID()}.png`;
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
    const { result, crops } = await scan(event.url);
    for (const crop of crops) {
      const key = await storeScreenshot(event.scanId, crop.png);
      const node = result.violations.find((v) => v.id === crop.ruleId)?.nodes[crop.nodeIndex];
      if (key && node) node.screenshotKey = key;
    }
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
