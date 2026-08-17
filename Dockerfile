FROM node:22-bookworm AS builder

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src/ src/

# Prune after building: the runtime stage copies node_modules wholesale, and
# without this it shipped tsx, typescript and vitest into the production image.
# tsx in particular is an arbitrary-TypeScript executor on the PATH of a
# container holding a signing key.
RUN npm ci && npm run build && rm -f dist/*.js.map dist/*.d.ts.map && npm prune --omit=dev

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

# spending-limit-account.js resolves the compiled artifact at runtime as
# ../contracts/... from dist/, so it must land at /app/contracts/.
#
# The whole directory, not just target/. target/ is gitignored and produced by
# the CI `contract` job, so copying it directly failed the build outright on a
# clean checkout -- including every `docker compose build`. Copying contracts/
# always succeeds, since Nargo.toml and src/ are committed, and the artifact
# rides along when it has been built.
#
# An image built without it still runs the default Schnorr configuration; only
# PXE_BRIDGE_SPENDING_LIMIT_ADMIN needs the artifact, and that path fails at
# startup with a module resolution error naming the missing file.
COPY contracts/ contracts/

ENV NODE_ENV=production
EXPOSE 8547

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -sf http://localhost:8547/status || exit 1

USER node
CMD ["node", "dist/index.js"]
