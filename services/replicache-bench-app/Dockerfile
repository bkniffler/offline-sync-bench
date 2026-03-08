FROM oven/bun:1.3.9

WORKDIR /app

COPY services/replicache-bench-app/package.json ./package.json
RUN bun install --production

COPY services/replicache-bench-app/src ./services/replicache-bench-app/src

EXPOSE 3000

CMD ["bun", "services/replicache-bench-app/src/index.ts"]
