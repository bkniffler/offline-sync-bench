FROM oven/bun:1.3.14

WORKDIR /workspace

# The syncular v2 packages are published to npm (@syncular/*@0.15.18) and pinned
# exactly in the app package.json — a plain `bun install` resolves them. They
# ship TS sources directly (no build step), so `bun src/server.ts` runs them
# as-is. No local checkout or additional build contexts are involved.
COPY stacks/syncular/syncular-app/package.json ./package.json
RUN bun install --no-save --ignore-scripts

COPY stacks/syncular/syncular-app/src ./src

EXPOSE 3000

CMD ["bun", "src/server.ts"]
