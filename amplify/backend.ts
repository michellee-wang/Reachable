import { defineBackend } from '@aws-amplify/backend';
import { Duration } from 'aws-cdk-lib';
import { DockerImageCode, DockerImageFunction } from 'aws-cdk-lib/aws-lambda';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { crawler } from './functions/crawler/resource';

/**
 * @see https://docs.amplify.aws/react/build-a-backend/ to add storage, functions, and more
 */
const backend = defineBackend({
  auth,
  data,
  crawler,
});

// The Chromium scanner is a container image Lambda (Playwright + Chromium are
// too large for a zip function), so it's defined in raw CDK rather than via
// defineFunction. It lives in its own stack alongside the other custom
// resources.
const here = path.dirname(fileURLToPath(import.meta.url));
const scannerStack = backend.createStack('scanner');

new DockerImageFunction(scannerStack, 'ScannerFunction', {
  code: DockerImageCode.fromImageAsset(path.join(here, 'functions', 'scanner')),
  memorySize: 2048, // Chromium needs headroom
  timeout: Duration.seconds(60),
});
