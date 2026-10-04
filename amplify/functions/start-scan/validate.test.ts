import { describe, expect, it } from "vitest";
import { isPrivateHost, validateScanUrl } from "./validate";

describe("validateScanUrl", () => {
  it("accepts a normal public https URL and reports the domain", () => {
    const r = validateScanUrl("https://example.org/about");
    expect(r).toEqual({ ok: true, url: "https://example.org/about", domain: "example.org" });
  });

  it("accepts http too", () => {
    const r = validateScanUrl("http://example.org/");
    expect(r.ok).toBe(true);
  });

  it("trims whitespace and strips the fragment", () => {
    const r = validateScanUrl("  https://example.org/p?q=1#section  ");
    expect(r).toMatchObject({ ok: true, url: "https://example.org/p?q=1" });
  });

  it("lowercases the host for the domain", () => {
    const r = validateScanUrl("https://Example.ORG/");
    expect(r).toMatchObject({ ok: true, domain: "example.org" });
  });

  it.each(["", "   ", "not a url", "example.org", "//example.org"])(
    "rejects non-URL input %o",
    (bad) => {
      expect(validateScanUrl(bad).ok).toBe(false);
    },
  );

  it.each(["ftp://example.org", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x"])(
    "rejects non-http(s) scheme %o",
    (bad) => {
      const r = validateScanUrl(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/http/);
    },
  );

  it.each([
    "http://localhost/",
    "http://localhost.localdomain/",
    "http://metadata.google.internal/",
    "http://169.254.169.254/latest/meta-data/",
  ])("blocks loopback/metadata host %o (SSRF)", (bad) => {
    expect(validateScanUrl(bad).ok).toBe(false);
  });

  it.each([
    "http://127.0.0.1/",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://172.16.4.2/",
    "http://0.0.0.0/",
    "http://[::1]/",
  ])("blocks private/loopback IP %o (SSRF)", (bad) => {
    const r = validateScanUrl(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/internal|can't be scanned/i);
  });

  it("allows a public IP literal", () => {
    expect(validateScanUrl("http://8.8.8.8/").ok).toBe(true);
  });
});

describe("isPrivateHost", () => {
  it.each(["10.1.2.3", "127.0.0.1", "192.168.0.1", "172.31.255.255", "169.254.169.254", "::1", "fe80::1", "fd00::1"])(
    "is private: %s",
    (h) => expect(isPrivateHost(h)).toBe(true),
  );

  it.each(["8.8.8.8", "1.1.1.1", "203.0.113.5", "172.32.0.1", "example.org"])(
    "is public/non-IP: %s",
    (h) => expect(isPrivateHost(h)).toBe(false),
  );
});
