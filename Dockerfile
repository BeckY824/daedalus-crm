# ---------- 依赖 ----------
FROM node:22-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# ---------- 构建 ----------
FROM node:22-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# 构建期不连真实库，给个占位串即可
ENV DATABASE_URL="file:/tmp/build.db"
# 同理给 AUTH_SECRET 一个构建期占位值。
# auth.ts 在模块顶层就校验密钥（生产环境缺失即抛错），而 next build 跑的就是
# NODE_ENV=production：不给的话，所有 import 了 requireUser 的页面会在
# 「collect page data」阶段直接失败，报错只说某个路由挂了，不提密钥的事。
# 这个值不会进运行镜像——runner 是另一个 stage，真实密钥由 compose 注入。
ENV AUTH_SECRET="build-time-placeholder-never-used-at-runtime-0123456789"
RUN npx prisma generate && npm run build
# 种子脚本是 TS，预先打包成单个 JS，运行时就不必装 tsx
RUN npx --yes esbuild@0.24.2 prisma/seed.ts \
      --bundle --platform=node --target=node22 \
      --external:@prisma/client \
      --outfile=seed.js
# 数据重置脚本同样预打包，便于在容器内直接执行
RUN npx --yes esbuild@0.24.2 prisma/reset-data.mjs \
      --bundle --platform=node --target=node22 \
      --outfile=reset-data.js
# 建表 SQL 在构建期生成，运行时用 Node 内置 sqlite 执行，
# 运行镜像因此不需要携带 Prisma CLI（它的依赖树很难裁剪干净）
RUN npx prisma migrate diff --from-empty \
      --to-schema-datamodel prisma/schema.prisma --script > schema.sql \
    && head -3 schema.sql

# ---------- 运行 ----------
FROM node:22-slim AS runner
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
# 数据库固定在卷 /data 下；compose 会再传一次，这里的默认值让裸 docker run 也能起
ENV DATABASE_URL="file:/data/crm.db"
# 服务端渲染的日期要和使用者浏览器同一时区，否则 React 水合时文案对不上（容器默认 UTC）
ENV TZ=Asia/Shanghai

# standalone 自带精简 node_modules
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Next 的依赖追踪会漏掉 Prisma（客户端是 generate 出来的，非静态引用），
# 不显式拷贝的话应用一查库就 MODULE_NOT_FOUND
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# 首启初始化所需：建表 SQL + 打包好的种子脚本
COPY --from=builder /app/schema.sql ./schema.sql
# 存量库的增量迁移脚本，容器每次启动按序重跑（内容幂等）
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/seed.js ./seed.js
COPY --from=builder /app/reset-data.js ./reset-data.js

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
