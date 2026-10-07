import { defineBackend } from '@aws-amplify/backend';
import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { DockerImageCode, DockerImageFunction, Function as LambdaFunction } from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { data } from './data/resource';
import { crawler } from './functions/crawler/resource';
import {
  BEDROCK_FOUNDATION_MODEL_ID,
  BEDROCK_MODEL_ID,
  scanStatus,
} from './functions/scan-status/resource';
import { screenshotUrl } from './functions/screenshot-url/resource';
import { startScan } from './functions/start-scan/resource';

/**
 * Reachable is a public, no-auth tool: no Cognito, no email. The data API is
 * public (API key), scans are transient, and this backend is just the scan
 * pipeline — crawler, scanner, scan-status, and the Step Functions workflow.
 *
 * @see https://docs.amplify.aws/react/build-a-backend/ to add storage, functions, and more
 */
const backend = defineBackend({
  data,
  crawler,
  scanStatus,
  startScan,
  screenshotUrl,
});

// The Chromium scanner is a container image Lambda (Playwright + Chromium are
// too large for a zip function), so it's defined in raw CDK rather than via
// defineFunction. It lives in its own stack alongside the other custom
// resources.
const here = path.dirname(fileURLToPath(import.meta.url));
const scannerStack = backend.createStack('scanner');

const scannerFunction = new DockerImageFunction(scannerStack, 'ScannerFunction', {
  code: DockerImageCode.fromImageAsset(path.join(here, 'functions', 'scanner')),
  memorySize: 2048, // Chromium needs headroom
  timeout: Duration.seconds(90),
});

// Screenshots are private and short-lived. The browser never talks to the
// bucket directly; screenshot-url presigns a GET. Objects expire after a day
// (scans themselves TTL out after an hour). No versioning: these are not
// records we need to recover, and versioning would leave delete markers behind
// when the sandbox is torn down.
const screenshots = new s3.Bucket(scannerStack, 'Screenshots', {
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  encryption: s3.BucketEncryption.S3_MANAGED,
  enforceSSL: true,
  objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
  lifecycleRules: [
    {
      expiration: Duration.days(1),
      abortIncompleteMultipartUploadAfter: Duration.days(1),
    },
  ],
});
screenshots.grantPut(scannerFunction);
scannerFunction.addEnvironment('SCREENSHOT_BUCKET', screenshots.bucketName);

// Step Functions workflow: crawl → scan every page (Map, ~10 at a time) →
// summarize → finish, with scan-status writing progress through AppSync. A
// single Catch flips the Scan to failed so a thrown step doesn't leave the
// progress bar stuck.
const workflowStack = backend.createStack('workflow');
const crawlerFn = backend.crawler.resources.lambda;
const statusFn = backend.scanStatus.resources.lambda;

// Retry policy shared by every Lambda task: Step Functions already handles the
// transient failures, so no SQS (see CLAUDE.md). Backoff smooths AppSync and
// Chromium hiccups.
const retry: sfn.RetryProps = {
  errors: ['States.ALL'],
  interval: Duration.seconds(2),
  maxAttempts: 3,
  backoffRate: 2,
};

// The Scan row already exists (start-scan created it and seeded this execution
// with its id). Flip it into "crawling" and stamp the start time. We carry the
// id forward under $.scan.scanId so the rest of the workflow is unchanged.
const beginScan = new tasks.LambdaInvoke(workflowStack, 'BeginScan', {
  lambdaFunction: statusFn,
  payload: sfn.TaskInput.fromObject({
    action: 'beginScan',
    scanId: sfn.JsonPath.stringAt('$.scanId'),
  }),
  resultSelector: { 'scanId.$': '$.Payload.scanId' },
  resultPath: '$.scan',
}).addRetry(retry);

// Discover same-domain pages (robots.txt + sitemap + links, ~200 cap).
const crawl = new tasks.LambdaInvoke(workflowStack, 'Crawl', {
  lambdaFunction: crawlerFn,
  payload: sfn.TaskInput.fromObject({
    startUrl: sfn.JsonPath.stringAt('$.startUrl'),
  }),
  resultSelector: { 'pages.$': '$.Payload.pages' },
  resultPath: '$.crawl',
}).addRetry(retry);

// Create a Page row per URL and move the Scan into "scanning"; returns the
// work-list of { pageId, url } the Map fans out over.
const registerPages = new tasks.LambdaInvoke(workflowStack, 'RegisterPages', {
  lambdaFunction: statusFn,
  payload: sfn.TaskInput.fromObject({
    action: 'registerPages',
    scanId: sfn.JsonPath.stringAt('$.scan.scanId'),
    urls: sfn.JsonPath.objectAt('$.crawl.pages'),
  }),
  resultSelector: { 'pages.$': '$.Payload.pages' },
  resultPath: '$.register',
}).addRetry(retry);

// Scan one page in a real browser; returns { pageId, status, violations }.
const scanPage = new tasks.LambdaInvoke(workflowStack, 'ScanPage', {
  lambdaFunction: scannerFunction,
  payload: sfn.TaskInput.fromObject({
    pageId: sfn.JsonPath.stringAt('$.pageId'),
    url: sfn.JsonPath.stringAt('$.url'),
    scanId: sfn.JsonPath.stringAt('$.scanId'),
  }),
  resultSelector: { 'result.$': '$.Payload' },
  resultPath: '$.scan',
}).addRetry(retry);

// Persist that page's result + violations (the Page flips to done/failed live,
// moving the browser's progress bar) and return just this page's impact tally.
// The Scan's shared counters are written once at the end — concurrent Map
// iterations must not read-modify-write them (see "collect then tally once").
const recordPageResult = new tasks.LambdaInvoke(workflowStack, 'RecordPageResult', {
  lambdaFunction: statusFn,
  payload: sfn.TaskInput.fromObject({
    action: 'recordPageResult',
    scanId: sfn.JsonPath.stringAt('$.scanId'),
    result: sfn.JsonPath.objectAt('$.scan.result'),
  }),
  // Hoist the tally up as this iteration's output so the Map collects an array
  // of tallies for the final roll-up.
  outputPath: '$.Payload.tally',
}).addRetry(retry);

// The per-page chain inside the Map.
scanPage.next(recordPageResult);

// Map over the discovered pages, ~10 at a time (a plain Map, not a Distributed
// Map — the ~200-page cap is small enough; see CLAUDE.md). Each iteration gets
// one page plus the scanId threaded in so recordPageResult knows the Scan.
const scanAllPages = new sfn.Map(workflowStack, 'ScanAllPages', {
  itemsPath: '$.register.pages',
  maxConcurrency: 10,
  itemSelector: {
    'pageId.$': '$$.Map.Item.Value.pageId',
    'url.$': '$$.Map.Item.Value.url',
    'scanId.$': '$.scan.scanId',
  },
  resultPath: '$.scanned',
}).itemProcessor(scanPage);

// One plain-English fix per axe rule, written onto the violation rows. The
// status flip to "summarizing" happens inside the action so the browser can
// show it while the model calls run. (Email was cut — this is a public tool.)
const summarize = new tasks.LambdaInvoke(workflowStack, 'Summarize', {
  lambdaFunction: statusFn,
  payload: sfn.TaskInput.fromObject({
    action: 'summarize',
    scanId: sfn.JsonPath.stringAt('$.scan.scanId'),
  }),
  resultPath: sfn.JsonPath.DISCARD,
}).addRetry(retry);

// Roll up the Map's per-page tallies into the Scan's final counts and mark it
// done with a finish time — the single, race-free write of the shared counters.
const finish = new tasks.LambdaInvoke(workflowStack, 'Finish', {
  lambdaFunction: statusFn,
  payload: sfn.TaskInput.fromObject({
    action: 'finish',
    scanId: sfn.JsonPath.stringAt('$.scan.scanId'),
    tallies: sfn.JsonPath.objectAt('$.scanned'),
    finishedAt: sfn.JsonPath.stringAt('$$.State.EnteredTime'),
  }),
}).addRetry(retry);

// If any step exhausts its retries, flip the Scan to "failed" with the error so
// the browser stops waiting, then end in a Fail state.
// Reads the id from the raw execution input ($.scanId), not $.scan.scanId, so
// it still works if beginScan is the step that failed (before $.scan is set).
const markFailed = new tasks.LambdaInvoke(workflowStack, 'MarkFailed', {
  lambdaFunction: statusFn,
  payload: sfn.TaskInput.fromObject({
    action: 'markFailed',
    scanId: sfn.JsonPath.stringAt('$.scanId'),
    error: sfn.JsonPath.stringAt('$.error.Cause'),
  }),
}).next(new sfn.Fail(workflowStack, 'ScanFailed', { error: 'ScanFailed' }));

const definition = beginScan
  .next(crawl)
  .next(registerPages)
  .next(scanAllPages)
  .next(summarize)
  .next(finish)
  .next(new sfn.Succeed(workflowStack, 'ScanComplete'));

// Attach the failure path to every step that can throw. The Scan row already
// exists (start-scan created it), so even a beginScan failure can be marked.
for (const step of [beginScan, crawl, registerPages, scanAllPages, summarize, finish]) {
  step.addCatch(markFailed, { resultPath: '$.error' });
}

const stateMachine = new sfn.StateMachine(workflowStack, 'ScanWorkflow', {
  definitionBody: sfn.DefinitionBody.fromChainable(definition),
  timeout: Duration.minutes(30),
  tracingEnabled: true, // X-Ray
});

// Let the state machine invoke the scanner container (the two defineFunction
// Lambdas are granted automatically by LambdaInvoke's generated policy, but the
// raw CDK scanner function needs an explicit grant).
scannerFunction.grantInvoke(stateMachine);

// The startScan mutation's Lambda is what kicks off a run: give it the ARN and
// permission to start an execution.
const startScanFn = backend.startScan.resources.lambda as LambdaFunction;
startScanFn.addEnvironment('SCAN_WORKFLOW_ARN', stateMachine.stateMachineArn);
stateMachine.grantStartExecution(startScanFn);

// Transience: a 1-hour TTL on the Scan table. DynamoDB auto-deletes expired
// rows, so nothing is durably stored and the capability-URL exposure window is
// bounded. (Reads treat an expired scan as gone even before AWS sweeps it.)
const scanTable = backend.data.resources.cfnResources.amplifyDynamoDbTables['Scan'];
scanTable.timeToLiveAttribute = { attributeName: 'ttl', enabled: true };

// Bedrock: invoke only this one model. The profile ARN is account-scoped; the
// foundation-model ARN uses a region wildcard because the us. profile may
// route the call to another US region.
const statusStack = Stack.of(statusFn);
statusFn.addToRolePolicy(
  new iam.PolicyStatement({
    actions: ['bedrock:InvokeModel', 'bedrock:Converse'],
    resources: [
      `arn:aws:bedrock:*::foundation-model/${BEDROCK_FOUNDATION_MODEL_ID}`,
      statusStack.formatArn({
        service: 'bedrock',
        resource: 'inference-profile',
        resourceName: BEDROCK_MODEL_ID,
      }),
    ],
  }),
);

const screenshotFn = backend.screenshotUrl.resources.lambda as LambdaFunction;
screenshotFn.addEnvironment('SCREENSHOT_BUCKET', screenshots.bucketName);
screenshots.grantRead(screenshotFn);

// The public API is AppSync, which has no usage-plan throttle. A WAF web ACL
// is the throttle: a tight per-IP limit on startScan (the expensive call) and
// a wider one on everything else so a normal report can still load.
const edgeStack = backend.createStack('edge');
const rateLimitVisibility = (metricName: string): wafv2.CfnWebACL.VisibilityConfigProperty => ({
  cloudWatchMetricsEnabled: true,
  metricName,
  sampledRequestsEnabled: true,
});

const publicApiAcl = new wafv2.CfnWebACL(edgeStack, 'PublicApiAcl', {
  scope: 'REGIONAL',
  defaultAction: { allow: {} },
  visibilityConfig: rateLimitVisibility('reachablePublicApi'),
  rules: [
    {
      name: 'StartScanPerIp',
      priority: 0,
      action: { block: {} },
      statement: {
        rateBasedStatement: {
          // Counted over a 5-minute window. A person starting scans by hand
          // will not get near 100; a script will.
          limit: 100,
          aggregateKeyType: 'IP',
          scopeDownStatement: {
            byteMatchStatement: {
              searchString: 'startScan',
              fieldToMatch: { body: { oversizeHandling: 'CONTINUE' } },
              textTransformations: [{ priority: 0, type: 'NONE' }],
              positionalConstraint: 'CONTAINS',
            },
          },
        },
      },
      visibilityConfig: rateLimitVisibility('reachableStartScanPerIp'),
    },
    {
      name: 'ApiPerIp',
      priority: 1,
      action: { block: {} },
      statement: {
        rateBasedStatement: {
          limit: 2000,
          aggregateKeyType: 'IP',
        },
      },
      visibilityConfig: rateLimitVisibility('reachableApiPerIp'),
    },
  ],
});

new wafv2.CfnWebACLAssociation(edgeStack, 'PublicApiAclAssociation', {
  resourceArn: backend.data.resources.graphqlApi.arn,
  webAclArn: publicApiAcl.attrArn,
});
