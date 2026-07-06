FROM oven/bun:1.3.14

WORKDIR /workspace

COPY stacks/syncular/syncular-app/package.json ./package.json
RUN bun install --no-save --ignore-scripts

# syncular v2 packages are unpublished — vendored from the local repo
# checkout (additional context `syncular_branch`). They ship TS sources
# directly (no build step), so copying package.json + src suffices.
COPY --from=syncular_branch packages/core/package.json ./node_modules/@syncular/core/package.json
COPY --from=syncular_branch packages/core/src ./node_modules/@syncular/core/src
COPY --from=syncular_branch packages/server/package.json ./node_modules/@syncular/server/package.json
COPY --from=syncular_branch packages/server/src ./node_modules/@syncular/server/src
COPY --from=syncular_branch packages/server-hono/package.json ./node_modules/@syncular/server-hono/package.json
COPY --from=syncular_branch packages/server-hono/src ./node_modules/@syncular/server-hono/src

COPY stacks/syncular/syncular-app/src ./src

EXPOSE 3000

CMD ["bun", "src/server.ts"]
