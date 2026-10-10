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
COPY handler.ts scan.ts crops.ts ./
RUN npm install --no-save esbuild@^0.28.2 \
  && npx esbuild handler.ts --bundle --platform=node --target=node20 \
     --external:playwright --external:@axe-core/playwright --outfile=handler.js \
  && npm remove esbuild 2>/dev/null || true

# Chromium's shared-library dependencies. The base image is Amazon Linux 2023,
# so Playwright's `--with-deps` (which shells out to apt-get) does not work;
# install the libraries with dnf and run a plain `playwright install` instead.
RUN dnf install -y \
      nss nspr atk at-spi2-atk at-spi2-core cups-libs libdrm libxkbcommon \
      libXcomposite libXdamage libXfixes libXrandr mesa-libgbm alsa-lib \
      pango cairo \
  && dnf clean all

# Pull Chromium itself into the image (deps already installed above).
RUN npx playwright install chromium

# Lambda Node base uses the Runtime Interface Client; CMD is "<file>.<export>".
CMD [ "handler.handler" ]
