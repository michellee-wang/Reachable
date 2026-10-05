import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { scanStatus } from '../functions/scan-status/resource';
import { screenshotUrl } from '../functions/screenshot-url/resource';
import { startScan } from '../functions/start-scan/resource';

/**
 * Reachable's data model: sites, scans, pages, violations.
 *
 * This is a public, no-auth tool. There are no accounts. Access is via a public
 * API key baked into the app, not Cognito.
 *
 * The public key can only get/listen, never list or write, so a scanId is a
 * capability: you can read the one scan you hold the id for, but you can't
 * enumerate others. (API-key auth is per-operation, not per-row, so dropping
 * list is what keeps that true.) Writes go through startScan (public) and the
 * scan-status Lambda (IAM). Scans carry a 1-hour TTL, set in backend.ts.
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
      pagesDiscovered: a.integer().default(0),
      pagesScanned: a.integer().default(0),
      criticalCount: a.integer().default(0),
      seriousCount: a.integer().default(0),
      moderateCount: a.integer().default(0),
      minorCount: a.integer().default(0),
      startedAt: a.datetime(),
      finishedAt: a.datetime(),
      error: a.string(),
      // epoch seconds; set ~1h out by start-scan, swept by DynamoDB TTL (backend.ts)
      ttl: a.integer(),
      pages: a.hasMany('Page', 'scanId'),
    })
    .authorization((allow) => [allow.publicApiKey().to(['get', 'listen'])]),

  // One URL within a Scan, with its scan status and the S3 key of its screenshot.
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

  // One axe-core rule failure on a Page: the element that failed plus the
  // cached plain-English fix (one per rule).
  Violation: a
    .model({
      pageId: a.id().required(),
      page: a.belongsTo('Page', 'pageId'),
      ruleId: a.string().required(),
      impact: a.enum(['critical', 'serious', 'moderate', 'minor']),
      description: a.string(),
      help: a.string(),
      helpUrl: a.string(),
      // offending element: CSS selector + the HTML snippet
      target: a.string(),
      html: a.string(),
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

  // Presign one screenshot. The key is `{scanId}/{pageId}.png`; the Lambda
  // rejects anything else, and the bucket itself stays private.
  screenshotUrl: a
    .query()
    .arguments({ key: a.string().required() })
    .returns(a.string().required())
    .handler(a.handler.function(screenshotUrl))
    .authorization((allow) => [allow.publicApiKey()]),
}).authorization((allow) => [
  // The scan-status Lambda is the single writer of scan progress; it talks to
  // this API with its IAM execution role (see its handler).
  allow.resource(scanStatus),
  // start-scan creates the Site + Scan rows (it's the startScan handler, but it
  // also calls the data API with generateClient, so it needs the data env +
  // grant like scan-status does).
  allow.resource(startScan),
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
