# mind server: the MCP tools over HTTP (mind serve). Node runs the TypeScript sources directly, so there is no build stage.
FROM node:24.22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY bin ./bin
COPY src ./src

ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1 \
    MIND_DB=/data/mind.db \
    MIND_HOST=0.0.0.0 \
    MIND_PORT=7077
# The node user (uid 1000) by default; compose overrides it to match the owner of the bind-mounted data dir.
USER node
VOLUME /data
EXPOSE 7077
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO /dev/null http://localhost:7077/health || exit 1

ENTRYPOINT ["node", "src/cli.ts"]
CMD ["serve"]
