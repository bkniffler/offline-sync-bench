FROM oven/bun:1.3.9

WORKDIR /app

COPY services/zero-bench-app/package.json ./package.json
RUN bun install --production

COPY services/zero-bench-app/src ./services/zero-bench-app/src

EXPOSE 3000

CMD ["bun", "services/zero-bench-app/src/index.js"]
