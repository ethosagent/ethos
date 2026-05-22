# Stage 1: install — build tools for native modules (better-sqlite3)
FROM node:24-slim AS install

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# --omit=dev: skip devDependencies that contain workspace-private "0.0.0"
# refs (e.g. @ethosagent/safety-redact, @ethosagent/secrets-aws). Those
# packages are bundled into cli/dist via tsup noExternal, but pnpm's publish
# rewrites workspace:* → 0.0.0 in the manifest. Without this flag, npm
# install nests every transitive dep inside cli/node_modules/ instead of
# hoisting to /usr/local/lib/node_modules/, which then breaks Node ESM
# resolution at runtime ("Cannot find package @ethosagent/types").
RUN npm install -g --omit=dev @ethosagent/cli@0.3.9

# Stage 2: runtime — clean production image
FROM node:24-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

RUN userdel -r node && useradd -m -u 1000 ethos

COPY --from=install /usr/local/lib/node_modules /usr/local/lib/node_modules
# Recreate the bin symlink — Docker's COPY dereferences single-file
# symlinks, so copying /usr/local/bin/ethos directly would land a 1.9MB
# regular file in /usr/local/bin/, breaking Node ESM module resolution
# (the file is no longer under @ethosagent/cli/, so node_modules/ walking
# fails to find @ethosagent/types at runtime).
RUN ln -sf /usr/local/lib/node_modules/@ethosagent/cli/dist/index.js /usr/local/bin/ethos

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER ethos
WORKDIR /home/ethos

VOLUME /home/ethos/.ethos
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -sf http://localhost:3000/healthz || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["run-all"]
