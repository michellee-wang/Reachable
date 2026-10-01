import { describe, expect, it } from "vitest";
import {
  crawl,
  extractLinks,
  Fetcher,
  normalizeURL,
  parseRobots,
  parseSitemap,
  robotsAllowed,
  sameDomain,
} from "./crawler";

/**
 * Serves canned responses so the crawl logic can be tested without a network.
 * A url in `fails` errors (dead link); a missing url returns null (404).
 */
class MapFetcher implements Fetcher {
  constructor(
    private pages: Record<string, string>,
    private fails: Set<string> = new Set(),
  ) {}

  async fetch(url: string) {
    if (this.fails.has(url)) return null;
    if (!(url in this.pages)) return null;
    return { body: this.pages[url], contentType: "text/html" };
  }
}

describe("normalizeURL", () => {
  const cases: [string, string | null][] = [
    ["https://Example.com", "https://example.com/"],
    ["https://example.com/", "https://example.com/"],
    ["https://example.com/a/", "https://example.com/a"],
    ["https://example.com/a#frag", "https://example.com/a"],
    ["https://example.com:443/a", "https://example.com/a"],
    ["http://example.com:80/a", "http://example.com/a"],
    ["HTTPS://EXAMPLE.COM/A", "https://example.com/A"], // path case preserved
    ["ftp://example.com/x", null],
    ["/relative/path", null],
    ["javascript:void(0)", null],
  ];
  it.each(cases)("normalizeURL(%s) -> %s", (input, want) => {
    expect(normalizeURL(input)).toBe(want);
  });
});

describe("sameDomain", () => {
  const cases: [string, string, boolean][] = [
    ["https://example.com", "https://example.com/page", true],
    ["https://example.com", "https://www.example.com/page", true], // www-insensitive
    ["https://example.com", "https://other.com/page", false],
    ["https://example.com", "https://sub.example.com/page", false], // subdomain differs
    ["https://example.com:8080", "https://example.com/page", true], // port ignored
  ];
  it.each(cases)("sameDomain(%s, %s) -> %s", (base, other, want) => {
    expect(sameDomain(base, other)).toBe(want);
  });
});

describe("extractLinks", () => {
  it("resolves, filters, and keeps same-domain links only", () => {
    const html = `
      <a href="/about">About</a>
      <a href='https://example.com/contact/'>Contact</a>
      <a href="#top">Skip</a>
      <a href="mailto:x@example.com">Mail</a>
      <a href="https://other.com/x">External</a>
      <a href="https://example.com/about">Dup</a>
    `;
    expect(extractLinks("https://example.com/", html).sort()).toEqual(
      [
        "https://example.com/about",
        "https://example.com/about",
        "https://example.com/contact",
      ].sort(),
    );
  });
});

describe("parseRobots", () => {
  const body = `
User-agent: BadBot
Disallow: /

User-agent: *
Disallow: /private
Disallow: /tmp

Sitemap: https://example.com/sitemap.xml
`;
  it("collects the '*' group rules and sitemaps", () => {
    const r = parseRobots(body);
    expect(r.disallowed).toEqual(["/private", "/tmp"]);
    expect(r.sitemaps).toEqual(["https://example.com/sitemap.xml"]);
  });
  it("applies only the '*' group, not BadBot's Disallow: /", () => {
    const r = parseRobots(body);
    expect(robotsAllowed(r, "https://example.com/public")).toBe(true);
    expect(robotsAllowed(r, "https://example.com/private/x")).toBe(false);
  });
});

describe("parseSitemap", () => {
  it("extracts and normalizes <loc> entries", () => {
    const body = `<?xml version="1.0"?>
      <urlset>
        <url><loc>https://example.com/a</loc></url>
        <url><loc> https://example.com/b/ </loc></url>
      </urlset>`;
    expect(parseSitemap(body)).toEqual(["https://example.com/a", "https://example.com/b"]);
  });
});

describe("crawl", () => {
  it("follows same-domain links and dedupes", async () => {
    const f = new MapFetcher({
      "https://example.com/": `<a href="/a">a</a><a href="/b">b</a><a href="https://other.com/x">ext</a>`,
      "https://example.com/a": `<a href="/b">b</a><a href="/">home</a>`,
      "https://example.com/b": `<a href="/a">a</a>`,
    });
    const res = await crawl("https://example.com", { fetcher: f });
    expect(res.pages.sort()).toEqual([
      "https://example.com/",
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });

  it("respects maxPages and reports capped", async () => {
    const pages: Record<string, string> = {};
    let links = "";
    for (let i = 0; i < 10; i++) {
      links += `<a href="/p${i}">p</a>`;
      pages[`https://example.com/p${i}`] = "";
    }
    pages["https://example.com/"] = links;
    const res = await crawl("https://example.com", {
      fetcher: new MapFetcher(pages),
      maxPages: 3,
    });
    expect(res.pages).toHaveLength(3);
    expect(res.capped).toBe(true);
  });

  it("honors robots.txt Disallow", async () => {
    const f = new MapFetcher({
      "https://example.com/robots.txt": "User-agent: *\nDisallow: /private\n",
      "https://example.com/": `<a href="/ok">ok</a><a href="/private/secret">no</a>`,
      "https://example.com/ok": "",
    });
    const res = await crawl("https://example.com", { fetcher: f });
    expect(res.pages).not.toContain("https://example.com/private/secret");
  });

  it("survives dead links", async () => {
    const f = new MapFetcher(
      {
        "https://example.com/": `<a href="/dead">dead</a><a href="/live">live</a>`,
        "https://example.com/live": "",
      },
      new Set(["https://example.com/dead"]),
    );
    const res = await crawl("https://example.com", { fetcher: f });
    // /dead is still a discovered page, but its fetch failure must not abort
    // the crawl, so /live is reached too.
    expect(res.pages).toHaveLength(3);
  });

  it("rejects a non-absolute start URL", async () => {
    await expect(crawl("not-a-url", { fetcher: new MapFetcher({}) })).rejects.toThrow();
  });
});
