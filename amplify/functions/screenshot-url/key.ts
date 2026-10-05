/**
 * Screenshot object keys are `{scanId}/{pageId}.png`, and both ids are Amplify
 * UUIDs. The public API will presign whatever key it is given, so this is the
 * boundary that keeps a caller from signing `../` or some other object.
 */
const KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/i;

export function screenshotObjectKey(key: string): string | null {
  return KEY_PATTERN.test(key) ? key : null;
}
