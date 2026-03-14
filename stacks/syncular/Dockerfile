FROM oven/bun:1.3.9

WORKDIR /workspace

COPY stacks/syncular/syncular-app/package.json ./package.json
COPY stacks/syncular/syncular-app/bun.lock ./bun.lock
RUN bun install --frozen-lockfile --ignore-scripts --production

COPY stacks/syncular/syncular-app/src ./src

EXPOSE 3000

CMD ["bun", "src/index.ts"]
