FROM oven/bun:1.3.9

WORKDIR /app

COPY stacks/electric/app/package.json ./package.json
RUN bun install --production

COPY stacks/electric/app/src ./stacks/electric/app/src

EXPOSE 3000

CMD ["bun", "stacks/electric/app/src/index.ts"]
