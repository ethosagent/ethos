# Stage 1: install — build tools for native modules (better-sqlite3)
FROM node:24-slim AS install

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @ethosagent/cli@0.3.6

# Stage 2: runtime — clean production image
FROM node:24-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

RUN userdel -r node && useradd -m -u 1000 ethos

COPY --from=install /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=install /usr/local/bin/ethos /usr/local/bin/ethos

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
