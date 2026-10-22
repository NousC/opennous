# Stage 1: build Vite app
FROM node:22-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/frontend/package.json ./apps/frontend/

RUN pnpm install --frozen-lockfile

COPY apps/frontend ./apps/frontend

# Build args become VITE_* env vars at build time
ARG VITE_AUTH_PROVIDER
ARG VITE_CLERK_PUBLISHABLE_KEY
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_API_URL
ARG VITE_STRIPE_PUBLISHABLE_KEY
ARG VITE_POSTHOG_KEY
ARG VITE_POSTHOG_HOST
ARG VITE_GOOGLE_ANALYTICS_ID
ARG VITE_DOCS_URL
ARG VITE_EXTERNAL_IMAGES
# The hosted MCP server the Connect agent dialogs quote (config/agentEndpoints.ts). Unset, the
# app falls back to Nous Cloud's; self-host passes https://$MCP_DOMAIN/mcp.
ARG VITE_MCP_URL
ENV VITE_MCP_URL=$VITE_MCP_URL

# The prod box (cpx11, 2 GB + swap) runs Node out of heap on the default limit.
ENV NODE_OPTIONS=--max-old-space-size=3072
RUN pnpm --filter @nous/frontend build

# Stage 2: nginx to serve static files + proxy /api/* to the api service
FROM nginx:1.27-alpine
COPY --from=builder /app/apps/frontend/dist /usr/share/nginx/html
COPY apps/frontend/nginx.conf /etc/nginx/conf.d/default.conf
# Fills the Supabase URL and anon key in at start when the image was built with placeholders
# (the GHCR release image); a no-op for an image built with real values. GET-758.
# The script is committed executable (git mode 755); COPY keeps the mode.
COPY apps/frontend/docker/40-nous-runtime-config.sh /docker-entrypoint.d/40-nous-runtime-config.sh
EXPOSE 80
