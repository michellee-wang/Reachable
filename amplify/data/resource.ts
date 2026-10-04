import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { scanStatus } from '../functions/scan-status/resource';
import { startScan } from '../functions/start-scan/resource';

/**
 * Reachable's data model: sites, scans, pages, violations.
 *
 * This is a public, no-auth tool. There are no accounts. Access is via a public
 * API key baked into the app, not Cognito.
 *
 * Security model — capability URLs, not enumeration:
 *   - The public key can only READ BY ID (get/listen). It deliberately has NO
 *     `list` and NO write. So knowing a scanId lets you read that one scan; you
 *     cannot enumerate other people's scans. (A public API key authorizes at the
 *     operation level, not the row level, so withholding `list` is what keeps the
 *     capability model sound — see the security note in DESIGN.md.)
 *   - Scans are started through the `startScan` mutation (a Lambda), never by a
 *     public create. That Lambda is the only public write path, and it just
 *     returns the new scanId.
 *   - The scan-status Lambda writes progress with its IAM role.
 *   - The root Scan record is transient: a 1-hour TTL (see backend.ts) shrinks
 *     the exposure window and keeps storage tiny.
 */

const schema = a.schema({
  // What startScan hands back: the new scan's id (the capability) and the
  // normalized URL it will scan.
  StartScanResult: a.customType({
    scanId: a.string().required(),
    url: a.string().required(),
  }),

  // A domain being scanned, e.g. "example.org".
  Site: a
    .model({
      domain: a.string().required(),
      scans: a.hasMany('Scan', 'siteId'),
    })
    // Read-by-id only for the public key; no list, no public write.
    .authorization((allow) => [allow.publicApiKey().to(['get', 'listen'])]),

  // One crawl+scan run against a Site. This is the record the browser polls /
  // subscribes to for live progress, so it carries the status and counts the
  // Step Functions workflow advances through.
  Scan: a
    .model({
      siteId: a.id().required(),
      site: a.belongsTo('Site', 'siteId'),
      status: a.enum([
        'pending',
        'crawling',
        'scanning',
        'summarizing',
        'done',
        'failed',
      ]),
      // Progress: pages discovered by the crawler vs. pages scanned so far.
      pagesDiscovered: a.integer().default(0),
      pagesScanned: a.integer().default(0),
      // Rolled-up violation counts for the report header.
      criticalCount: a.integer().default(0),
      seriousCount: a.integer().default(0),
      moderateCount: a.integer().default(0),
      minorCount: a.integer().default(0),
      startedAt: a.datetime(),
      finishedAt: a.datetime(),
      error: a.string(),
      // DynamoDB TTL: epoch seconds after which this scan auto-deletes. Set by
      // start-scan to ~1 hour out (TTL config is in backend.ts).
      ttl: a.integer(),
      pages: a.hasMany('Page', 'scanId'),
    })
    // Read-by-id + subscribe only: the browser watches one scan it already
    // holds the id for. No list (no enumeration) and no public write.
    .authorization((allow) => [allow.publicApiKey().to(['get', 'listen'])]),

  // One URL within a Scan. Holds its own scan status and the S3 key of its
  // screenshot (the bucket comes in step 8 with storage).
  Page: a
    .model({
      scanId: a.id().required(),
      scan: a.belongsTo('Scan', 'scanId'),
      url: a.string().required(),
      status: a.enum(['pending', 'scanning', 'done', 'failed']),
      screenshotKey: a.string(),
      violations: a.hasMany('Violation', 'pageId'),
    })
    .authorization((allow) => [allow.publicApiKey().to(['get', 'listen'])]),

  // One axe-core rule failure on a Page. Carries the element that failed and
  // the cached Bedrock plain-English fix (one explanation per rule, step 8).
  Violation: a
    .model({
      pageId: a.id().required(),
      page: a.belongsTo('Page', 'pageId'),
      ruleId: a.string().required(),
      impact: a.enum(['critical', 'serious', 'moderate', 'minor']),
      description: a.string(),
      help: a.string(),
      helpUrl: a.string(),
      // The offending element: CSS target and its HTML snippet.
      target: a.string(),
      html: a.string(),
      // Cached plain-English fix from Bedrock, keyed in practice by ruleId.
      plainEnglishFix: a.string(),
    })
    .authorization((allow) => [allow.publicApiKey().to(['get', 'listen'])]),

  // The only public write path. Validates the URL, starts the scan workflow,
  // and returns just the new scanId — the capability the browser then uses to
  // read/subscribe. Backed by the start-scan Lambda; the public key may call
  // it, but it cannot create Scan rows directly.
  startScan: a
    .mutation()
    .arguments({ url: a.string().required() })
    .returns(a.ref('StartScanResult'))
    .handler(a.handler.function(startScan))
    .authorization((allow) => [allow.publicApiKey()]),
}).authorization((allow) => [
  // The scan-status Lambda is the single writer of scan progress; it talks to
  // this API with its IAM execution role (see its handler).
  allow.resource(scanStatus),
]);

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    // Public tool, no accounts: a public API key is the default. Scans are
    // protected only by their unguessable ids and their short TTL.
    defaultAuthorizationMode: 'apiKey',
    // The key can be long-lived; it only grants access to transient, per-scan
    // data that already expires on its own.
    apiKeyAuthorizationMode: { expiresInDays: 365 },
  },
});
