# Reachable

Paste a URL, and automatically generate an accessibility report for the whole site! 

![](https://imgur.com/a/zaBbwsg)

## The Problem

Most websites have accessibility problems but it’s difficult to seek each out: images without alt text, buttons without names, text that's too low-contrast etc. This makes it unaccessible for people who use screen readers, keyboards, or magnification.

## The Idea

Run a full-site accessibility scan in a real browser:

- No install and no account
- The whole site, crawls and searches for other pages
- Outputs each issue with a screenshot, and fixes written

## The Solution

Reachable creates headless Chromium browsers, crawls up to about 200 public pages of a site, runs axe-core against each one. It collects issues and ranks them and the finished report can be saved as a PDF.

Reachable does not certify WCAG compliance. 

## How it works

![Architecture diagram. The browser sends startScan through the AppSync API, which is rate limited by a WAF, to the start-scan Lambda. That Lambda validates the URL and starts a Step Functions workflow: crawl up to 200 pages, scan about 10 at a time with Chromium and axe, then write AI fixes. Screenshots go to S3 and scan results go to DynamoDB. Live progress comes back to the browser. Results are kept for one hour, then deleted.](docs/architecture.png)

### Architecture

1. **Validate the URL:** `startScan` blocks localhost, private IPs, and the cloud metadata address
2. **Crawl the site:** The crawler reads the sitemap and uses robots.txt but stops at 200 pages.
3. **Scan each page:** About 10 pages run at a time in a container Lambda with Playwright and Chromium. Each page gets an axe scan. 
4. Page are screenshotted: Stored in S3 for the report. For each failing element, the scanner saves a cropped screenshot of just that element
5. **Explain fixes:** Bedrock writes some suggestions. The prompt will never include the page's HTML so so its safe against injections.
6. **Stream progress/report:** AppSync pushes live progress to the web app. Each worker writes only its own page so parallel writes can't overwrite each other. 

## Run it Yourself

Everything runs from this directory.

```bash
npm install
npm run dev          # Vite on localhost
npm test             # unit tests
npm run type-check   # vue-tsc for the app
npx tsc --noEmit -p amplify/tsconfig.json   # the backend
npm run build
```

## Backend

The backend is Amplify Gen 2, defined in `amplify/backend.ts`. 

```bash
npx ampx sandbox --once   # one synth + deploy, then exit
npx ampx sandbox          # watch mode, redeploys on save
npx ampx sandbox delete   # tear it down
```

Docker must be running. The first deploy builds the Chromium image and creates the screenshot bucket and the WAF, so it takes several minutes. The region is **us-east-2**.

## Layout

```
amplify/
  backend.ts                 scanner container, S3, Step Functions, WAF, IAM
  data/resource.ts           Scan, Page, Violation, startScan, screenshotUrl
  functions/
    crawler/                 robots.txt, sitemap, same-domain links
    scanner/                 Chromium + axe (Docker image Lambda)
    scan-status/             the only writer of progress; Bedrock fixes
    start-scan/              URL validation and workflow kickoff
    screenshot-url/          presigns a GET for one screenshot
src/
  App.vue                    the form and the live progress bar
  ReportView.vue             the report
  client.ts                  the data client
```
