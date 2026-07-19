FROM node:24-bookworm-slim

RUN npm install --global --omit=dev jazz-tools@2.0.0-alpha.53

EXPOSE 3227

CMD ["jazz-tools", "server", "782ccb53-dcba-56c0-acc8-d056d008eea3", "--port", "3227", "--data-dir", "/data", "--admin-secret", "jazz-admin", "--backend-secret", "jazz-backend", "--allow-local-first-auth"]
