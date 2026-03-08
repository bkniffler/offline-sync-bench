FROM oven/bun:1.3.9

WORKDIR /app

COPY services/bench-admin/package.json ./package.json
RUN bun install --production

COPY services/bench-admin/src ./services/bench-admin/src

EXPOSE 3000

CMD ["bun", "services/bench-admin/src/index.ts"]
