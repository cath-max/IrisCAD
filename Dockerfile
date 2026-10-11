# Build the TanStack Start/Nitro application once, then ship only Nitro's
# self-contained output. Cloud Run terminates TLS and provides PORT at runtime.
FROM node:22.12.0-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json .npmrc ./
# Nitro's current beta dependency tree declares development-only optional peer
# packages that are intentionally absent from this lockfile. Keep the clean,
# lockfile-based install while avoiding npm 10's strict optional-peer check.
RUN npm ci --legacy-peer-deps

COPY . ./

# Vite embeds public configuration in the browser bundle during the build.
# Secrets deliberately do not appear here; Cloud Run injects those at runtime.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_APP_URL
ARG VITE_SIMPLECAD_WHEEL_CHINA_MIRROR_BASE_URL
ARG VITE_POSTHOG_PROJECT_KEY
ARG VITE_POSTHOG_HOST
ARG VITE_SENTRY_DSN
ARG VITE_SENTRY_ENVIRONMENT=production

ENV VITE_SUPABASE_URL=${VITE_SUPABASE_URL} \
    VITE_SUPABASE_ANON_KEY=${VITE_SUPABASE_ANON_KEY} \
    VITE_APP_URL=${VITE_APP_URL} \
    VITE_SIMPLECAD_WHEEL_CHINA_MIRROR_BASE_URL=${VITE_SIMPLECAD_WHEEL_CHINA_MIRROR_BASE_URL} \
    VITE_POSTHOG_PROJECT_KEY=${VITE_POSTHOG_PROJECT_KEY} \
    VITE_POSTHOG_HOST=${VITE_POSTHOG_HOST} \
    VITE_SENTRY_DSN=${VITE_SENTRY_DSN} \
    VITE_SENTRY_ENVIRONMENT=${VITE_SENTRY_ENVIRONMENT}

RUN npm run build

FROM node:22.12.0-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

WORKDIR /app

COPY --from=build /app/.output ./.output

EXPOSE 8080

CMD ["node", ".output/server/index.mjs"]
