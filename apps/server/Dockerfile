# --- builder: modern image for native compilation ---
FROM node:20-bookworm AS builder

RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

WORKDIR /app

# 1. 先拷 lockfile 和所有 package.json，利用 Docker 缓存
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/harness/package.json packages/harness/
COPY packages/sentry-analyzer/package.json packages/sentry-analyzer/
COPY packages/wave-sdk/package.json packages/wave-sdk/
COPY apps/server/package.json apps/server/

RUN pnpm install --frozen-lockfile

# 2. 拷源码并构建
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/server/ apps/server/

RUN pnpm --filter @work-mi/server build

# 3. 用 pnpm deploy 把 server 的生产依赖打成独立目录（node_modules 已扁平化）
RUN pnpm deploy --legacy --filter @work-mi/server --prod /app/deploy

# --- runtime ---
FROM node:20-slim

WORKDIR /app

COPY --from=builder /app/deploy/dist ./dist
COPY --from=builder /app/deploy/package.json ./
COPY --from=builder /app/deploy/node_modules ./node_modules

ENV NODE_ENV=production
ENV HOST=0.0.0.0
EXPOSE 8082

CMD ["node", "dist/index.js"]
