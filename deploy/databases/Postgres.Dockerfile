ARG POSTGRES_IMAGE=postgres:17-bookworm@sha256:40865bc877a289da75963d97d72b59633f639fc5af7a4e856bfa3714cae5b536
ARG DEBIAN_IMAGE=debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
FROM ${POSTGRES_IMAGE} AS extensions
ARG PG_MAJOR
ARG VECTOR_COMMIT
ARG VECTOR_SHA256
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gcc make libc6-dev \
    && cd /tmp && apt-get download postgresql-server-dev-${PG_MAJOR} libpq-dev \
    && for package in /tmp/*.deb; do dpkg-deb -x "$package" /; done \
    && curl -fsSL --retry 3 "https://codeload.github.com/pgvector/pgvector/tar.gz/${VECTOR_COMMIT}" -o /tmp/vector.tar.gz \
    && echo "${VECTOR_SHA256}  /tmp/vector.tar.gz" | sha256sum -c - \
    && mkdir /tmp/vector && tar -xzf /tmp/vector.tar.gz -C /tmp/vector --strip-components=1 \
    && make -C /tmp/vector PG_CONFIG=/usr/lib/postgresql/${PG_MAJOR}/bin/pg_config with_llvm=no OPTFLAGS="" -j2 \
    && make -C /tmp/vector PG_CONFIG=/usr/lib/postgresql/${PG_MAJOR}/bin/pg_config with_llvm=no install DESTDIR=/opt/vector

FROM ${DEBIAN_IMAGE} AS walg
ARG TARGETARCH
ARG WALG_VERSION
ARG WALG_ARM64_SHA256
ARG WALG_AMD64_SHA256
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl liblzo2-2 libbrotli1 liblz4-1 libzstd1 \
    && case "${TARGETARCH}" in arm64) arch=aarch64; checksum="${WALG_ARM64_SHA256}" ;; amd64) arch=amd64; checksum="${WALG_AMD64_SHA256}" ;; *) exit 1 ;; esac \
    && curl -fsSL --retry 3 "https://github.com/wal-g/wal-g/releases/download/${WALG_VERSION}/wal-g-pg-22.04-${arch}" -o /usr/local/bin/wal-g \
    && echo "${checksum}  /usr/local/bin/wal-g" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/wal-g \
    && wal-g --version

FROM ${POSTGRES_IMAGE}
LABEL io.fleet.database-image="true"
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates liblzo2-2 libbrotli1 liblz4-1 libzstd1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=walg /usr/local/bin/wal-g /usr/local/bin/wal-g
COPY --from=extensions /opt/vector/ /
COPY --chmod=0755 postgres-entrypoint.sh /usr/local/bin/fleet-postgres-entrypoint.sh
ENTRYPOINT ["fleet-postgres-entrypoint.sh"]
# The runtime provides config/credentials separately; no tenant secrets enter image layers.
STOPSIGNAL SIGINT
