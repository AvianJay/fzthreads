FROM node:lts

LABEL org.opencontainers.image.description "Fixes Meta's Threads metadata for sites like Discord, Telegram, etc."
LABEL org.opencontainers.image.source "https://github.com/AvianJay/fzthreads"

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable
WORKDIR /build
COPY . .

RUN pnpm install --frozen-lockfile && pnpm build

EXPOSE 20061

CMD ["node", "./lib/src/index.js"]
