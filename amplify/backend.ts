import { defineBackend } from '@aws-amplify/backend';
import { Duration } from 'aws-cdk-lib';
import { DockerImageCode, DockerImageFunction } from 'aws-cdk-lib/aws-lambda';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { crawler } from './functions/crawler/resource';
import { scanStatus } from './functions/scan-status/resource';

/**
 * @see https://docs.amplify.aws/react/build-a-backend/ to add storage, functions, and more
 */
const backend = defineBackend({
  auth,
  data,
  crawler,
  scanStatus,
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
  timeout: Duration.seconds(60),
});

// -----------------------------------------------------------------------------
// Step Functions workflow (build step 6)
//
// crawl → scan every discovered page (Map, ~10 at a time) → summarize → email,
// with scan-status writing live progress through AppSync at each stage. The
// crawler and scan-status are defineFunction Lambdas; the scanner is the
// container image above. A single Catch flips the Scan to "failed" so a thrown
// step never leaves the browser's progress bar stuck mid-run.
// -----------------------------------------------------------------------------
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

// Create the Scan row and flip it into "crawling"; returns { scanId }.
const createScan = new tasks.LambdaInvoke(workflowStack, 'CreateScan', {
  lambdaFunction: statusFn,
  payload: sfn.TaskInput.fromObject({
    action: 'createScan',
    siteId: sfn.JsonPath.stringAt('$.siteId'),
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

// Summarize (Bedrock plain-English fixes) and email (SES) land in step 8; for
// now the workflow advances the status so the progress bar reaches those phases
// and the pipeline shape is real.
const summarize = new tasks.LambdaInvoke(workflowStack, 'Summarize', {
  lambdaFunction: statusFn,
  payload: sfn.TaskInput.fromObject({
    action: 'setStatus',
    scanId: sfn.JsonPath.stringAt('$.scan.scanId'),
    status: 'summarizing',
  }),
  resultPath: sfn.JsonPath.DISCARD,
}).addRetry(retry);

const email = new tasks.LambdaInvoke(workflowStack, 'Email', {
  lambdaFunction: statusFn,
  payload: sfn.TaskInput.fromObject({
    action: 'setStatus',
    scanId: sfn.JsonPath.stringAt('$.scan.scanId'),
    status: 'emailing',
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
const markFailed = new tasks.LambdaInvoke(workflowStack, 'MarkFailed', {
  lambdaFunction: statusFn,
  payload: sfn.TaskInput.fromObject({
    action: 'setStatus',
    scanId: sfn.JsonPath.stringAt('$.scan.scanId'),
    status: 'failed',
    error: sfn.JsonPath.stringAt('$.error.Cause'),
  }),
}).next(new sfn.Fail(workflowStack, 'ScanFailed', { error: 'ScanFailed' }));

const definition = createScan
  .next(crawl)
  .next(registerPages)
  .next(scanAllPages)
  .next(summarize)
  .next(email)
  .next(finish)
  .next(new sfn.Succeed(workflowStack, 'ScanComplete'));

// Attach the failure path to every step that can throw. createScan runs before
// a Scan row exists, so it can't mark one failed — it just surfaces the error.
for (const step of [crawl, registerPages, scanAllPages, summarize, email, finish]) {
  step.addCatch(markFailed, { resultPath: '$.error' });
}

const stateMachine = new sfn.StateMachine(workflowStack, 'ScanWorkflow', {
  definitionBody: sfn.DefinitionBody.fromChainable(definition),
  timeout: Duration.minutes(30),
  tracingEnabled: true, // X-Ray; CloudWatch/dashboards come in step 9
});

// Let the state machine invoke the scanner container (the two defineFunction
// Lambdas are granted automatically by LambdaInvoke's generated policy, but the
// raw CDK scanner function needs an explicit grant).
scannerFunction.grantInvoke(stateMachine);

// Surface the ARN so the UI's start-scan mutation (step 7) can kick off a run.
backend.addOutput({
  custom: { scanWorkflowArn: stateMachine.stateMachineArn },
});
