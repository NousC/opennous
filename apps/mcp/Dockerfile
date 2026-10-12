FROM node:22-alpine AS base
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace manifests for dependency install. The MCP server has no
# workspace (@nous/*) dependencies, so only its own manifest is needed.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/mcp/package.json ./apps/mcp/

RUN pnpm install --frozen-lockfile --filter ./apps/mcp

# Copy source
COPY apps/mcp ./apps/mcp

EXPOSE 3002
CMD ["node", "apps/mcp/src/http.js"]
