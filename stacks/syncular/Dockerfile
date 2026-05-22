FROM oven/bun:1.3.9

WORKDIR /workspace

COPY stacks/syncular/syncular-app/package.json ./package.json
COPY stacks/syncular/syncular-app/bun.lock ./bun.lock
RUN bun install --frozen-lockfile --ignore-scripts --production

COPY --from=syncular_branch packages/core/package.json ./node_modules/@syncular/core/package.json
COPY --from=syncular_branch packages/core/src ./node_modules/@syncular/core/src
COPY --from=syncular_branch packages/server/package.json ./node_modules/@syncular/server/package.json
COPY --from=syncular_branch packages/server/src ./node_modules/@syncular/server/src
COPY --from=syncular_branch packages/server-dialect-postgres/package.json ./node_modules/@syncular/server-dialect-postgres/package.json
COPY --from=syncular_branch packages/server-dialect-postgres/src ./node_modules/@syncular/server-dialect-postgres/src
COPY --from=syncular_branch packages/server-hono/package.json ./node_modules/@syncular/server-hono/package.json
COPY --from=syncular_branch packages/server-hono/src ./node_modules/@syncular/server-hono/src

COPY stacks/syncular/syncular-app/src ./src

EXPOSE 3000

CMD ["bun", "src/index.ts"]
