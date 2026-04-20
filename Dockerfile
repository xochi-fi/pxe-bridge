FROM node:22-bookworm AS builder

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src/ src/

RUN npm ci && npm run build && rm -f dist/*.js.map dist/*.d.ts.map

FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

# Install newer libstdc++ from trixie for GLIBCXX_3.4.32 (needed by @aztec/bb.js)
RUN echo "deb http://deb.debian.org/debian trixie main" > /etc/apt/sources.list.d/trixie.list \
    && apt-get update \
    && apt-get install -y -t trixie libstdc++6 \
    && rm -f /etc/apt/sources.list.d/trixie.list \
    && apt-get update \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/dist dist/
COPY --from=builder /app/node_modules node_modules/
COPY --from=builder /app/package.json .

ENV NODE_ENV=production
EXPOSE 8547

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -sf http://localhost:8547/status || exit 1

USER node
CMD ["node", "dist/index.js"]
