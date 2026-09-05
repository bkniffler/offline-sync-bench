FROM debian:bookworm-slim

ARG TARGETARCH
ARG TURSO_VERSION=0.7.2

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl netcat-openbsd xz-utils \
  && case "$TARGETARCH" in \
       amd64) archive="turso_cli-x86_64-unknown-linux-gnu.tar.xz" ;; \
       arm64) archive="turso_cli-aarch64-unknown-linux-gnu.tar.xz" ;; \
       *) echo "Unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
     esac \
  && curl -fsSL "https://github.com/tursodatabase/turso/releases/download/v${TURSO_VERSION}/${archive}" -o /tmp/turso.tar.xz \
  && tar -xJf /tmp/turso.tar.xz -C /tmp \
  && find /tmp -type f -name tursodb -exec install -m 0755 {} /usr/local/bin/tursodb \; \
  && rm -rf /tmp/turso.tar.xz /tmp/turso_cli-* \
  && rm -rf /var/lib/apt/lists/*

VOLUME ["/data"]
EXPOSE 8080

CMD ["tursodb", "/data/server.db", "--sync-server", "0.0.0.0:8080"]
