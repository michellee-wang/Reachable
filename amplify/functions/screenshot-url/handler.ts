import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "$amplify/env/screenshot-url";
import { screenshotObjectKey } from "./key";

/**
 * screenshotUrl query: turn a validated object key into a short-lived GET URL.
 * The key itself is the capability (it embeds the unguessable scan id); this
 * function only checks the shape and signs it. It does not list the bucket.
 */

const s3 = new S3Client({});

/** Long enough to read the report, short enough that a leaked URL dies soon. */
const URL_TTL_SECONDS = 60 * 60;

type ScreenshotArgs = { arguments: { key: string } };

export const handler = async (event: ScreenshotArgs): Promise<string> => {
  const key = screenshotObjectKey(event.arguments.key);
  if (!key) throw new Error("Invalid screenshot key.");
  if (!env.SCREENSHOT_BUCKET) throw new Error("Screenshot bucket is not configured.");

  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: env.SCREENSHOT_BUCKET, Key: key }),
    { expiresIn: URL_TTL_SECONDS },
  );
};
