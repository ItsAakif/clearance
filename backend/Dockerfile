# ---- Clearance backend (Node/TS + Prisma) ----
# ADR-029 decision 6 (a): slim app image. No browser (Playwright/Camofox)
# install here - the browser tier is a separate optional path (wave 6, T724).
FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

# Prisma engines need OpenSSL on node:20-slim (migrate deploy fails with
# `Schema engine error` without it). Single layer, lists cleaned.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

# Install deps (leverage layer cache). The lockfile ships in the build
# context, so plain `npm ci` is correct - no install fallback.
COPY package.json package-lock.json ./
RUN npm ci

# Prisma schema first so client generation is cached unless the schema changes.
COPY prisma ./prisma
RUN npx prisma generate

# Build TypeScript (migrations travel with the prisma/ copy above and are
# required at runtime for `prisma migrate deploy` - see compose command).
COPY . .
RUN npm run build

# Wave 6 (T724, ADR-029 N17): optional full-image path. The default stays
# SLIM: WITH_BROWSER defaults to false and this step is a no-op (no browser
# library, no engine, no system libs - `docker compose up --build` is
# unchanged and the tier reports skipped-with-reason). Opt in:
#   docker compose build --build-arg WITH_BROWSER=true backend
# or set WITH_BROWSER=true in the root .env (compose passes it through).
# Install shape follows the T720 probe evidence
# (`.planning/research/camofox-protocol.md`): `npm i camoufox-js` +
# `npx camoufox-js fetch` (engine download ~300 MB reported, cached in the
# image's `~/.cache/camoufox`, overridable at runtime with
# `CAMOUFOX_INSTALL_DIR`). Camoufox is a Firefox fork: if the engine fails
# to launch on this base for missing system libraries, add the distro libs
# from the Camoufox upstream docs (no list is hardcoded here - the exact
# image delta was not measured, probe finding "unknown"). A missing or
# broken engine can never break boot: the tier reports unavailable and deep
# search continues with the cheaper tiers (N2).
ARG WITH_BROWSER=false
RUN if [ "$WITH_BROWSER" = "true" ]; then npm i --no-save camoufox-js && npx camoufox-js fetch; else echo "slim image: browser tier unavailable (deep search reports skipped-with-reason, ADR-029)"; fi

EXPOSE 3001
CMD ["node", "dist/index.js"]
