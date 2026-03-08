FROM oven/bun:1.3.9

WORKDIR /app

COPY services/livestore-bench-app/package.json ./package.json
RUN bun install --production

COPY services/livestore-bench-app/src ./services/livestore-bench-app/src

EXPOSE 3000

CMD ["bun", "services/livestore-bench-app/src/index.ts"]
