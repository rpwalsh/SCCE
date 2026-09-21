# syntax=docker/dockerfile:1.7

ARG SCCE_BASE_IMAGE=node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

FROM ${SCCE_BASE_IMAGE} AS build

ARG SCCE_BASE_IMAGE
ARG SCCE_REVISION=development
LABEL org.opencontainers.image.title="SCCE build" \
      org.opencontainers.image.revision="${SCCE_REVISION}" \
      org.opencontainers.image.base.name="${SCCE_BASE_IMAGE}"

ENV TZ=UTC \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

WORKDIR /app

RUN corepack enable \
  && corepack prepare pnpm@10.28.2 --activate

# Keep the repository layout intact: workspace links, the local XLSX archive,
# and the existing build/test tools all assume these paths.
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm build

FROM build AS production-deps
ENV CI=true
RUN pnpm install --recursive --prod --frozen-lockfile --offline

FROM ${SCCE_BASE_IMAGE} AS runtime

ARG SCCE_BASE_IMAGE
ARG SCCE_REVISION=development
LABEL org.opencontainers.image.title="SCCE runtime" \
      org.opencontainers.image.revision="${SCCE_REVISION}" \
      org.opencontainers.image.base.name="${SCCE_BASE_IMAGE}"

ENV NODE_ENV=production \
    TZ=UTC \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

WORKDIR /app

RUN corepack enable \
  && corepack prepare pnpm@10.28.2 --activate

COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=production-deps /app/packages/kernel/node_modules ./packages/kernel/node_modules
COPY --from=production-deps /app/packages/adapters-node/node_modules ./packages/adapters-node/node_modules
COPY --from=production-deps /app/packages/server/node_modules ./packages/server/node_modules

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=build /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /app/packages/kernel/package.json ./packages/kernel/package.json
COPY --from=build /app/packages/kernel/dist ./packages/kernel/dist
COPY --from=build /app/packages/adapters-node/package.json ./packages/adapters-node/package.json
COPY --from=build /app/packages/adapters-node/dist ./packages/adapters-node/dist
COPY --from=build /app/packages/ui/package.json ./packages/ui/package.json
COPY --from=build /app/packages/ui/dist ./packages/ui/dist
COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --from=build /app/packages/server/dist ./packages/server/dist

COPY deploy/container-entrypoint.mjs ./deploy/container-entrypoint.mjs

RUN mkdir -p /workspace /scratch /results /app/.tmp /app/.scce /app/artifacts \
  && chown -R node:node /workspace /scratch /results /app/.tmp /app/.scce /app/artifacts
VOLUME ["/workspace", "/scratch", "/results", "/app/.tmp", "/app/.scce", "/app/artifacts"]

USER node
ENTRYPOINT ["node", "/app/deploy/container-entrypoint.mjs"]
CMD ["node", "packages/server/dist/index.js", "--config", "/config/scce.config.json"]

FROM runtime AS runtime-media

ARG SCCE_BASE_IMAGE
ARG SCCE_REVISION=development
LABEL org.opencontainers.image.title="SCCE runtime with document/media tools" \
      org.opencontainers.image.revision="${SCCE_REVISION}" \
      org.opencontainers.image.base.name="${SCCE_BASE_IMAGE}"

USER root
# Bootstrap APT's CA bundle from the pinned Node distribution; keep TLS verification on.
RUN set -eux; \
  node -e 'require("node:fs").writeFileSync("/tmp/node-ca.pem", require("node:tls").rootCertificates.join("\n"))'; \
  rm -f /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; \
  printf '%s\n' \
    'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20260901T000000Z bookworm main' \
    > /etc/apt/sources.list.d/scce-snapshot.list; \
  apt-get -o Acquire::https::CaInfo=/tmp/node-ca.pem update --error-on=any; \
  apt-get -o Acquire::https::CaInfo=/tmp/node-ca.pem install --no-install-recommends -y ca-certificates ffmpeg poppler-utils; \
  rm -f /tmp/node-ca.pem; \
  rm -rf /var/lib/apt/lists/*
USER node

FROM runtime-media AS worker

ARG SCCE_BASE_IMAGE
ARG SCCE_REVISION=development
LABEL org.opencontainers.image.title="SCCE worker" \
      org.opencontainers.image.revision="${SCCE_REVISION}" \
      org.opencontainers.image.base.name="${SCCE_BASE_IMAGE}"

USER root
RUN set -eux; \
  rm -f /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; \
  printf '%s\n' \
    'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20260901T000000Z bookworm main' \
    > /etc/apt/sources.list.d/scce-snapshot.list; \
  apt-get update --error-on=any; \
  apt-get install --no-install-recommends -y git python3 python-is-python3 bzip2; \
  rm -rf /var/lib/apt/lists/*

COPY --from=build /app/packages/cli/package.json ./packages/cli/package.json
COPY --from=build /app/packages/cli/dist ./packages/cli/dist

COPY --from=production-deps /app/packages/cli/node_modules ./packages/cli/node_modules
USER node
CMD ["node", "packages/cli/dist/index.js", "--config", "/config/scce.config.json", "help"]

FROM worker AS evaluation

ARG SCCE_BASE_IMAGE
ARG SCCE_REVISION=development
LABEL org.opencontainers.image.title="SCCE evaluation" \
      org.opencontainers.image.revision="${SCCE_REVISION}" \
      org.opencontainers.image.base.name="${SCCE_BASE_IMAGE}"

ENV NODE_ENV=development \
    TZ=UTC \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

COPY --chown=node:node --from=build /app /app
COPY deploy/container-entrypoint.mjs ./deploy/container-entrypoint.mjs
USER root
RUN mkdir -p /workspace /scratch /results /app/.tmp /app/.scce /app/artifacts \
  && chown -R node:node /workspace /scratch /results /app/.tmp /app/.scce /app/artifacts
USER node
ENTRYPOINT ["node", "/app/deploy/container-entrypoint.mjs"]
CMD ["pnpm", "eval:kit:verify"]
