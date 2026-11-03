# ---- Clearance frontend (Vite + React app at the repo root) ----
# Multi-stage: build the static bundle with Node, then serve it with nginx
# (SPA fallback so react-router deep links resolve to index.html).
# Choice rationale: nginx adds zero new runtime dependencies to the app
# itself (it lives only inside this image); `vite preview` would instead
# run a Node dev server in production, which is not its intended shape.
#
# Vite bakes VITE_* and V2_* values in AT BUILD TIME: changing VITE_API_URL (or
# any VITE_* flag, or any V2_* feature flag) requires a rebuild
# (`docker compose up --build`). The compose file passes them as build args from
# the root .env with safe defaults.
# Runtime BYOK keys are entered in the app Settings page and are NEVER
# baked into this image.
FROM node:20-slim AS build
WORKDIR /app

# Install deps first (layer cache). NOTE: plain `npm ci` is NOT usable here:
# the root package-lock.json is currently out of sync with package.json
# (`npm ci` fails with EUSAGE "Missing: esbuild@... from lock file"), so the
# build resolves with `npm install` instead. This only affects the image
# build (the repo lockfile is untouched); if the lock is ever brought back
# in sync (`npm install` locally and commit), prefer `npm ci` again.
COPY package.json package-lock.json ./
RUN npm install --no-audit --no-fund

COPY . .

# Build-time app config (defaults mirror .env.example).
ARG VITE_API_URL=http://localhost:3001/api
ARG VITE_APP_URL=
ARG VITE_ENABLE_PUBLIC_SCAN=true
ARG VITE_ENABLE_AI_FEATURES=true
ARG VITE_GA_MEASUREMENT_ID=
ARG VITE_POSTHOG_KEY=
# V2 feature flags (T1002). vite.config.ts sets `envPrefix: ['VITE_', 'V2_']`
# so these are exposed to the bundle exactly like the VITE_* values above, and
# the backend reads the SAME env key names from the root .env (docker-compose
# env_file). Declaring them here is what makes the two runtimes agree under
# `docker compose up --build` instead of leaving the browser permanently OFF.
# All default OFF, so a build with none set is byte-identical to a pre-flag build.
ARG V2_RESUME_STUDIO=false
ARG V2_DISABLE_FREE_AI_GENERATION=false
ARG V2_TYPST_RENDER=false
ENV VITE_API_URL=$VITE_API_URL \
    VITE_APP_URL=$VITE_APP_URL \
    VITE_ENABLE_PUBLIC_SCAN=$VITE_ENABLE_PUBLIC_SCAN \
    VITE_ENABLE_AI_FEATURES=$VITE_ENABLE_AI_FEATURES \
    VITE_GA_MEASUREMENT_ID=$VITE_GA_MEASUREMENT_ID \
    VITE_POSTHOG_KEY=$VITE_POSTHOG_KEY \
    V2_RESUME_STUDIO=$V2_RESUME_STUDIO \
    V2_DISABLE_FREE_AI_GENERATION=$V2_DISABLE_FREE_AI_GENERATION \
    V2_TYPST_RENDER=$V2_TYPST_RENDER
RUN npm run build

FROM nginx:1-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
