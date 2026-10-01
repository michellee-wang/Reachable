# Chromium scanner Lambda: a real browser so JavaScript-rendered pages are
# scanned. Built as a container image because Playwright + Chromium exceed the
# zip Lambda size limit and need system libraries.
FROM public.ecr.aws/lambda/nodejs:20

# Install Chromium into the image (not /tmp) so it ships with the layer.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers

WORKDIR ${LAMBDA_TASK_ROOT}

# Install deps first for layer caching.
COPY package.json ./
RUN npm install --omit=dev --no-package-lock

# esbuild is a build-time tool; install it separately and bundle the handler.
COPY handler.ts scan.ts ./
RUN npm install --no-save esbuild@^0.28.2 \
  && npx esbuild handler.ts --bundle --platform=node --target=node20 \
     --external:playwright --external:@axe-core/playwright --outfile=handler.js \
  && npm remove esbuild 2>/dev/null || true

# Pull Chromium and its OS dependencies into the image.
RUN npx playwright install --with-deps chromium

# Lambda Node base uses the Runtime Interface Client; CMD is "<file>.<export>".
CMD [ "handler.handler" ]
