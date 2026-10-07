# Reachable

Paste a URL, get an accessibility report. Reachable crawls up to ~200 public
pages of a site, runs [axe-core](https://github.com/dequelabs/axe-core) against
each one in a real headless Chromium, and ranks what it finds by impact — with
the offending element, a screenshot, and a plain-English fix.

It finds common issues. It is **not** a WCAG certification. It only scans public
pages, respects `robots.txt`, and caps requests per site.

There are no accounts. Paste a URL, watch the progress bar, read the report.
Scans expire after an hour.

## How it works

```
Browser ──startScan──▶ start-scan Lambda (validates URL, SSRF guard)
                            │
                            ▼
                     Step Functions
   beginScan ─▶ crawl ─▶ registerPages ─▶ Map(scan page ×10) ─▶ summarize ─▶ finish
                                               │                    │
                        axe in Chromium ───────┤                    └─ Bedrock: one
                        screenshot ─▶ S3 ──────┘                       fix per rule
                                               │
                           scan-status Lambda ─┴─▶ AppSync ─▶ DynamoDB ─▶ live progress

   Any step that throws is caught and routed to markFailed, so the scan ends
   as `failed` instead of leaving the progress bar stuck.
```

- **Crawler** (TypeScript Lambda) reads `robots.txt` and the sitemap, follows
  same-domain links, dedupes, and stops around 200 pages.
- **Scanner** (Chromium container Lambda) loads each page in a real browser so
  JS-rendered content is scanned, runs axe, and captures a screenshot.
- **scan-status** is the single writer of progress — every update goes through
  AppSync so the browser's progress bar moves live.
- **Bedrock** (Nova Micro, via a cross-region inference profile so it rides out
  regional throttling) writes one plain-English fix per axe rule, cached so a
  rule that repeats across pages is only explained once.
- Scan data carries a 1-hour TTL and the public API key can only read a scan by
  id, so a scan URL is a capability — you can't enumerate other people's scans.

## Develop

Everything runs from this directory.

```sh
npm install
npm run dev          # Vite dev server on localhost
npm test             # unit tests
npm run type-check   # app types
npm run build        # production build
```

The app reads `amplify_outputs.json` at startup, so you need a backend deployed
before a scan will run (see below).

## Backend

The backend is Amplify Gen 2 + CDK (`amplify/`). It's deployed on demand and
torn down when idle, not left running.

```sh
npx ampx sandbox --once   # one deploy, exits when done
npx ampx sandbox          # watch mode, redeploys on save
npx ampx sandbox delete   # tear it down
```

Deploying writes `amplify_outputs.json` (gitignored). Requirements:

- **Docker** must be running — the scanner is a container-image Lambda, so the
  first deploy builds a Chromium image and takes a few minutes.
- AWS credentials for region **us-east-2**.

## Layout

```
amplify/
  backend.ts            CDK: scanner container, S3, Step Functions, WAF, IAM
  data/resource.ts      schema: Scan, Page, Violation, startScan
  functions/
    crawler/            robots + sitemap + link crawl
    scanner/            Chromium + axe (Docker)
    scan-status/        single writer of progress; Bedrock fixes
    start-scan/         URL validation + workflow kickoff
    screenshot-url/     presigns a GET for one screenshot
src/
  App.vue               the form and live progress
  ReportView.vue        the report
  client.ts             the data client
```

## Local scanner

`../scanner/` is a standalone Playwright + axe script for trying the scan
locally against a file or URL, without deploying anything.
