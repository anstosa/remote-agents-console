ARG NODE_VERSION=22-bookworm-slim

FROM node:${NODE_VERSION} AS build
WORKDIR /build

# avoid corrupted responses from pipelining or caching proxies
RUN printf '%s\n' 'Acquire::http::Pipeline-Depth "0";' 'Acquire::http::No-Cache "true";' > /etc/apt/apt.conf.d/99-rac-build-transport \
    && apt-get update \
    && apt-get install --no-install-recommends -y g++ make python3 \
    && rm -rf /var/lib/apt/lists/* /etc/apt/apt.conf.d/99-rac-build-transport

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json

RUN corepack enable && pnpm install --frozen-lockfile

COPY apps ./apps
RUN pnpm build && pnpm --filter @rac/server deploy --legacy --prod /opt/rac-server

FROM node:${NODE_VERSION}
ARG CODEX_VERSION=0.164.0
ENV HOME=/home/node \
    NODE_ENV=production

# keep checksum verification while bypassing broken http intermediaries
RUN printf '%s\n' 'Acquire::http::Pipeline-Depth "0";' 'Acquire::http::No-Cache "true";' > /etc/apt/apt.conf.d/99-rac-build-transport \
    && apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates git tmux zsh \
    && npm install --global "@openai/codex@${CODEX_VERSION}" \
    && mkdir -p /workspace /home/node/.codex /home/node/.config/gh \
    && chown -R node:node /workspace /home/node \
    && rm -rf /var/lib/apt/lists/* /root/.npm /etc/apt/apt.conf.d/99-rac-build-transport

# let ICU inspect mounted host data rather than follow the image's UTC symlink
RUN rm /etc/localtime && cp /usr/share/zoneinfo/Etc/UTC /etc/localtime

WORKDIR /app
COPY --from=build /opt/rac-server ./server
# keep copied public assets readable under restrictive checkout permissions
COPY --from=build --chown=node:node /build/apps/web/dist ./web/dist
COPY --from=build /build/node_modules /opt/rac-dev/node_modules
COPY --from=build /build/apps/server/node_modules /opt/rac-dev/apps/server/node_modules

USER node
EXPOSE 8787
CMD ["node", "server/dist/index.js"]
