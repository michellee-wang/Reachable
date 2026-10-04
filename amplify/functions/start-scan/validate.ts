/**
 * URL validation for the public, no-auth start-scan endpoint.
 *
 * Because anyone can call startScan and the scanner is a real browser running in
 * our cloud, this is a security boundary, not just input hygiene: we must refuse
 * to point that browser at internal infrastructure (SSRF). We reject anything
 * that isn't a public http(s) URL — no other schemes, no localhost, no private
 * or link-local IP ranges, and no cloud metadata host.
 *
 * Pure and dependency-free so it can be unit-tested without a network.
 */

export interface ValidationError {
  ok: false;
  reason: string;
}
export interface ValidationOk {
  ok: true;
  /** The normalized URL to scan (origin + path, no fragment). */
  url: string;
  /** The hostname, used as the Site domain. */
  domain: string;
}
export type ValidationResult = ValidationOk | ValidationError;

/** Hostnames that must never be scanned (loopback + cloud metadata). */
const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "metadata",
  "metadata.google.internal",
]);

/** The AWS/GCP/Azure link-local metadata IP. */
const METADATA_IP = "169.254.169.254";

/**
 * True if the host is an IP literal in a private, loopback, link-local, or
 * otherwise non-public range. Covers IPv4 ranges and the obvious IPv6 cases.
 */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets

  // IPv6 loopback / link-local / unique-local.
  if (h === "::1" || h === "::") return true;
  if (h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;

  // IPv4 dotted-quad.
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (m.slice(1).some((o) => Number(o) > 255)) return true; // malformed → reject
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 169 && b === 254) return true; // link-local (incl. metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a >= 224) return true; // multicast / reserved
  return false;
}

export function validateScanUrl(raw: string): ValidationResult {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, reason: "A URL is required." };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "That doesn't look like a valid URL." };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "Only http and https URLs can be scanned." };
  }

  const host = parsed.hostname.toLowerCase();
  if (host === "" || BLOCKED_HOSTS.has(host) || host === METADATA_IP) {
    return { ok: false, reason: "That host can't be scanned." };
  }
  if (isPrivateHost(host)) {
    return { ok: false, reason: "Private and internal addresses can't be scanned." };
  }

  // Normalize: drop the fragment, keep origin + path + query.
  parsed.hash = "";
  return { ok: true, url: parsed.toString(), domain: host };
}
