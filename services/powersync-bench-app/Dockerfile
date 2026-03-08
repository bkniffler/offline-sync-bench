FROM oven/bun:1.3.9

WORKDIR /app

COPY services/powersync-bench-app/package.json ./package.json
RUN bun install --production

COPY services/powersync-bench-app/src ./services/powersync-bench-app/src

EXPOSE 3000

CMD ["bun", "services/powersync-bench-app/src/index.ts"]
