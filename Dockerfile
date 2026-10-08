FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS toolchain
WORKDIR /app
RUN npm install --global pnpm@11.15.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/tsconfig.json ./apps/api/
COPY apps/web/package.json apps/web/tsconfig.json apps/web/vite.config.ts apps/web/index.html ./apps/web/
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
COPY packages/tv-adapter/package.json packages/tv-adapter/tsconfig.json ./packages/tv-adapter/
COPY packages/webos/package.json packages/webos/tsconfig.json ./packages/webos/
COPY packages/tizen/package.json packages/tizen/tsconfig.json ./packages/tizen/

FROM toolchain AS dependencies
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN pnpm install --frozen-lockfile
COPY apps/api/src ./apps/api/src
COPY apps/web/src ./apps/web/src
COPY apps/web/public ./apps/web/public
COPY packages/contracts/src ./packages/contracts/src
COPY packages/tv-adapter/src ./packages/tv-adapter/src
COPY packages/webos/src ./packages/webos/src
COPY packages/tizen/src ./packages/tizen/src
RUN pnpm --filter @remote-webos-tv/contracts build && pnpm --filter @remote-webos-tv/tv-adapter build && pnpm --filter @remote-webos-tv/webos build && pnpm --filter @remote-webos-tv/tizen build && pnpm --filter @remote-webos-tv/api build && pnpm --filter @remote-webos-tv/web build

FROM toolchain AS production-dependencies
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN pnpm install --prod --frozen-lockfile

FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=production-dependencies /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=production-dependencies /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=production-dependencies /app/packages/tv-adapter/node_modules ./packages/tv-adapter/node_modules
COPY --from=production-dependencies /app/packages/webos/node_modules ./packages/webos/node_modules
COPY --from=production-dependencies /app/packages/tizen/node_modules ./packages/tizen/node_modules
COPY --from=dependencies /app/apps/api/package.json ./apps/api/package.json
COPY --from=dependencies /app/apps/api/dist ./apps/api/dist
COPY --from=dependencies /app/apps/web/package.json ./apps/web/package.json
COPY --from=dependencies /app/apps/web/dist ./apps/web/dist
COPY --from=dependencies /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=dependencies /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=dependencies /app/packages/tv-adapter/package.json ./packages/tv-adapter/package.json
COPY --from=dependencies /app/packages/tv-adapter/dist ./packages/tv-adapter/dist
COPY --from=dependencies /app/packages/webos/package.json ./packages/webos/package.json
COPY --from=dependencies /app/packages/webos/dist ./packages/webos/dist
COPY --from=dependencies /app/packages/tizen/package.json ./packages/tizen/package.json
COPY --from=dependencies /app/packages/tizen/dist ./packages/tizen/dist
RUN mkdir /data && chown node:node /data && chmod 700 /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.REMOTE_WEBOS_PORT+'/api/health',{signal:AbortSignal.timeout(2000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/src/index.js"]
