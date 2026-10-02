import { type ClientSchema, a, defineData } from '@aws-amplify/backend';

/**
 * Reachable's data model: sites, scans, pages, violations.
 *
 * Every model is owner-authorized — each nonprofit owns its own scans and can
 * only read and write its own records (see CLAUDE.md). The owner is the
 * signed-in Cognito user, stamped automatically by Amplify.
 *
 * The scanner Lambdas update progress *through this API* (AppSync), not by
 * writing DynamoDB directly, so the live progress bar in the browser moves.
 */

const schema = a.schema({
  // A domain a nonprofit scans, e.g. "example.org". Owns its scans and holds
  // the weekly-rescan toggle (EventBridge Scheduler reads this).
  Site: a
    .model({
      domain: a.string().required(),
      rescanWeekly: a.boolean().default(false),
      scans: a.hasMany('Scan', 'siteId'),
    })
    .authorization((allow) => [allow.owner()]),

  // One crawl+scan run against a Site. This is the record the browser
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
        'emailing',
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
      pages: a.hasMany('Page', 'scanId'),
    })
    .authorization((allow) => [allow.owner()]),

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
    .authorization((allow) => [allow.owner()]),

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
    .authorization((allow) => [allow.owner()]),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    // Signed-in Cognito users only — each owns their own scans.
    defaultAuthorizationMode: 'userPool',
  },
});
