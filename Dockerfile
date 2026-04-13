FROM node:22-bookworm AS builder

WORKDIR /app
COPY package.json tsconfig.json ./
COPY src/ src/

RUN npm install && npm run build

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

CMD ["node", "dist/index.js"]
