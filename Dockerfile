FROM node:24.22.1

LABEL org.opencontainers.image.description "Fixes Meta's Threads metadata for sites like Discord, Telegram, etc."
LABEL org.opencontainers.image.source "https://github.com/AvianJay/fzthreads"

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# CVE-2026-111497: the base image can lag behind Debian security updates, and
# curl --compressed (findPost.ts) decodes Threads responses with libbrotli.
RUN apt-get update \
  && apt-get install -y --only-upgrade libbrotli1 libbrotli-dev \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable
WORKDIR /build
COPY . .

RUN pnpm install --frozen-lockfile && pnpm build

EXPOSE 20061

CMD ["node", "./lib/src/index.js"]
