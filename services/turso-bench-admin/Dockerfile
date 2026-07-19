FROM node:22-bookworm-slim

WORKDIR /app

COPY services/turso-bench-admin/package.json ./package.json
RUN npm install --omit=dev

COPY services/turso-bench-admin/src ./services/turso-bench-admin/src

EXPOSE 3000

CMD ["node", "--experimental-strip-types", "services/turso-bench-admin/src/index.ts"]
