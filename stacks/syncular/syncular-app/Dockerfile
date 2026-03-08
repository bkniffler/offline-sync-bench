FROM oven/bun:1.3.9

WORKDIR /app

COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile

COPY src ./src

EXPOSE 3000

CMD ["bun", "src/index.ts"]
