# SEIKA API — production image.
# Multi-stage: compile TypeScript → ship only compiled JS + production deps.
# Final image runs plain `node dist/server.js` (no TypeScript, no tsx).
# Comfortably runs in ~100-150 MB — fine for a 2 GB droplet.

# ---- build stage ----
FROM node:20-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod=false --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# ---- runtime stage ----
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable
# Only production dependencies (dev deps like typescript, tsx,
# mongodb-memory-server are NOT installed here).
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod --ignore-scripts && pnpm store prune
COPY --from=build /app/dist ./dist
EXPOSE 4000
# Cap V8 heap so it stays friendly on a small box.
CMD ["node", "--max-old-space-size=384", "dist/server.js"]
