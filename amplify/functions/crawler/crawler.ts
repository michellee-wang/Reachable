/**
 * Crawler: discovers the public pages of a single site.
 *
 * It reads robots.txt and the sitemap for seed URLs, then follows same-domain
 * links breadth-first, deduping as it goes and stopping at a page cap (~200).
 * All network access goes through a Fetcher, so the crawl logic is testable
 * without a live site.
 */

export const DEFAULT_MAX_PAGES = 200;

/**
 * Retrieves the body at a URL. The crawl loop depends on this interface rather
 * than fetch() directly so tests can serve canned pages.
 */
export interface Fetcher {
  fetch(url: string): Promise<{ body: string; contentType: string } | null>;
}

/** Production Fetcher backed by the global fetch(). Returns null on any error. */
export class HttpFetcher implements Fetcher {
  constructor(
    private userAgent = "ReachableBot/1.0 (+accessibility scan)",
    private timeoutMs = 15_000,
  ) {}

  async fetch(url: string) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const resp = await globalThis.fetch(url, {
        headers: { "User-Agent": this.userAgent },
        signal: ac.signal,
      });
      if (!resp.ok) return null;
      return {
        body: await resp.text(),
        contentType: resp.headers.get("content-type") ?? "",
      };
    } catch {
      return null; // a dead link shouldn't kill the crawl
    } finally {
      clearTimeout(t);
    }
  }
}

/**
 * Canonicalizes a URL for deduping: lowercases scheme and host, drops the
 * fragment, removes a default port, and strips a trailing slash from the path.
 * Returns null if the input isn't an absolute http(s) URL.
 */
export function normalizeURL(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  if (
    (u.protocol === "http:" && u.port === "80") ||
    (u.protocol === "https:" && u.port === "443")
  ) {
    u.port = "";
  }
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
  return u.toString();
}

function canonicalHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

// Same host, ignoring a leading www. and the port.
export function sameDomain(base: string, other: string): boolean {
  try {
    return canonicalHost(new URL(base).hostname) === canonicalHost(new URL(other).hostname);
  } catch {
    return false;
  }
}

const HREF_RE = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
const LOC_RE = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi;

/**
 * Pulls href targets from HTML and resolves them against base, returning
 * absolute, normalized, same-domain http(s) URLs. Anchors, javascript:,
 * mailto:, and tel: links are skipped.
 */
export function extractLinks(base: string, html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(HREF_RE)) {
    const href = m[1].trim();
    if (!href || href.startsWith("#")) continue;
    const lower = href.toLowerCase();
    if (
      lower.startsWith("javascript:") ||
      lower.startsWith("mailto:") ||
      lower.startsWith("tel:")
    ) {
      continue;
    }
    let abs: string;
    try {
      abs = new URL(href, base).toString();
    } catch {
      continue;
    }
    const norm = normalizeURL(abs);
    if (norm && sameDomain(base, norm)) out.push(norm);
  }
  return out;
}

/** Parsed subset of robots.txt: disallowed path prefixes and sitemap URLs. */
export interface Robots {
  disallowed: string[];
  sitemaps: string[];
}

/**
 * Parses robots.txt, collecting Disallow rules that apply to all agents
 * (User-agent: *) and any Sitemap: declarations. A missing or empty file
 * yields a permissive result with no rules.
 */
export function parseRobots(body: string): Robots {
  const r: Robots = { disallowed: [], sitemaps: [] };
  let applies = false; // inside a group that applies to "*"?
  for (let line of body.split("\n")) {
    const hash = line.indexOf("#");
    if (hash !== -1) line = line.slice(0, hash);
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();
    if (lower.startsWith("sitemap:")) {
      r.sitemaps.push(trimmed.slice(trimmed.indexOf(":") + 1).trim());
    } else if (lower.startsWith("user-agent:")) {
      applies = trimmed.slice(trimmed.indexOf(":") + 1).trim() === "*";
    } else if (applies && lower.startsWith("disallow:")) {
      const p = trimmed.slice(trimmed.indexOf(":") + 1).trim();
      if (p) r.disallowed.push(p);
    }
  }
  return r;
}

export function robotsAllowed(r: Robots, url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname || "/";
  } catch {
    return false;
  }
  return !r.disallowed.some((d) => path.startsWith(d));
}

/** Extracts URLs from <loc> entries of a sitemap or sitemap index. */
export function parseSitemap(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(LOC_RE)) {
    const norm = normalizeURL(m[1].trim());
    if (norm) out.push(norm);
  }
  return out;
}

export interface CrawlOptions {
  maxPages?: number; // defaults to DEFAULT_MAX_PAGES
  fetcher: Fetcher;
}

export interface CrawlResult {
  pages: string[]; // discovered page URLs, in discovery order, deduped
  capped: boolean; // true if stopped at maxPages with more to visit
  sitemapSeeds: string[]; // seed URLs that came from the sitemap
}

/**
 * Discovers pages starting from startURL. Seeds the frontier with the start URL
 * plus any sitemap URLs (from robots.txt, else /sitemap.xml), then follows
 * same-domain links breadth-first. Honors robots.txt Disallow rules, dedupes
 * via normalized URLs, and stops once maxPages pages are collected.
 */
export async function crawl(startURL: string, opts: CrawlOptions): Promise<CrawlResult> {
  const max = opts.maxPages && opts.maxPages > 0 ? opts.maxPages : DEFAULT_MAX_PAGES;
  const start = normalizeURL(startURL);
  if (!start) throw new Error(`start URL is not an absolute http(s) URL: ${startURL}`);

  const robots = await fetchRobots(start, opts.fetcher);

  const seen = new Set<string>();
  const queue: string[] = [];
  const result: CrawlResult = { pages: [], capped: false, sitemapSeeds: [] };

  const enqueue = (u: string | null) => {
    if (!u || seen.has(u)) return;
    if (!sameDomain(start, u) || !robotsAllowed(robots, u)) return;
    seen.add(u);
    queue.push(u);
  };

  enqueue(start);
  for (const s of await sitemapSeeds(start, robots, opts.fetcher)) {
    result.sitemapSeeds.push(s);
    enqueue(s);
  }

  while (queue.length > 0) {
    if (result.pages.length >= max) {
      result.capped = queue.length > 0;
      break;
    }
    const cur = queue.shift()!;
    result.pages.push(cur);

    const got = await opts.fetcher.fetch(cur);
    if (!got) continue; // a dead link shouldn't kill the crawl
    if (got.contentType && !got.contentType.toLowerCase().includes("html")) continue;
    for (const link of extractLinks(cur, got.body)) enqueue(link);
  }
  return result;
}

async function fetchRobots(start: string, f: Fetcher): Promise<Robots> {
  const u = new URL(start);
  const got = await f.fetch(`${u.protocol}//${u.host}/robots.txt`);
  return got ? parseRobots(got.body) : { disallowed: [], sitemaps: [] };
}

async function sitemapSeeds(start: string, robots: Robots, f: Fetcher): Promise<string[]> {
  const u = new URL(start);
  const maps = robots.sitemaps.length ? robots.sitemaps : [`${u.protocol}//${u.host}/sitemap.xml`];
  const seeds: string[] = [];
  for (const m of maps) {
    const got = await f.fetch(m);
    if (got) seeds.push(...parseSitemap(got.body));
  }
  return seeds;
}
