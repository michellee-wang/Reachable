import { describe, expect, it } from "vitest";
import { screenshotObjectKey } from "./key";

const SCAN = "11111111-1111-4111-8111-111111111111";
const PAGE = "22222222-2222-4222-8222-222222222222";

describe("screenshotObjectKey", () => {
  it("accepts a scan/page png key", () => {
    const key = `${SCAN}/${PAGE}.png`;
    expect(screenshotObjectKey(key)).toBe(key);
  });

  it("rejects traversal, extra path segments, and other extensions", () => {
    expect(screenshotObjectKey(`../${SCAN}/${PAGE}.png`)).toBeNull();
    expect(screenshotObjectKey(`${SCAN}/../${PAGE}.png`)).toBeNull();
    expect(screenshotObjectKey(`${SCAN}/${PAGE}/extra.png`)).toBeNull();
    expect(screenshotObjectKey(`${SCAN}/${PAGE}.jpg`)).toBeNull();
    expect(screenshotObjectKey(`${SCAN}/${PAGE}.png\n`)).toBeNull();
    expect(screenshotObjectKey("")).toBeNull();
  });
});
