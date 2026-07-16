FROM node:22-alpine AS base
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace manifests for dependency install
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/core/package.json ./packages/core/

# Install all deps (need devDeps to build core)
RUN pnpm install --frozen-lockfile

# Copy source
COPY apps/api ./apps/api
COPY packages/core ./packages/core
COPY tsconfig.base.json ./

# Build @nous/core
RUN pnpm --filter @nous/core run build

EXPOSE 3000
CMD ["node", "apps/api/src/index.mjs"]
