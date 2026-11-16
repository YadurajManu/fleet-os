ARG POSTGRES_IMAGE
FROM ${POSTGRES_IMAGE} AS extensions
ARG PG_MAJOR
ARG VECTOR_COMMIT
ARG VECTOR_SHA256
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl build-essential postgresql-server-dev-${PG_MAJOR} \
    && curl -fsSL --retry 3 "https://codeload.github.com/pgvector/pgvector/tar.gz/${VECTOR_COMMIT}" -o /tmp/vector.tar.gz \
    && echo "${VECTOR_SHA256}  /tmp/vector.tar.gz" | sha256sum -c - \
    && mkdir /tmp/vector && tar -xzf /tmp/vector.tar.gz -C /tmp/vector --strip-components=1 \
    && make -C /tmp/vector OPTFLAGS="" -j2 \
    && make -C /tmp/vector install DESTDIR=/opt/vector

FROM ${POSTGRES_IMAGE}
ARG TARGETARCH
ARG WALG_VERSION
ARG WALG_ARM64_SHA256
ARG WALG_AMD64_SHA256
LABEL io.fleet.database-image="true"
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl liblzo2-2 libbrotli1 liblz4-1 libzstd1 \
    && case "${TARGETARCH}" in arm64) arch=aarch64; checksum="${WALG_ARM64_SHA256}" ;; amd64) arch=amd64; checksum="${WALG_AMD64_SHA256}" ;; *) exit 1 ;; esac \
    && curl -fsSL --retry 3 "https://github.com/wal-g/wal-g/releases/download/${WALG_VERSION}/wal-g-pg-22.04-${arch}" -o /usr/local/bin/wal-g \
    && echo "${checksum}  /usr/local/bin/wal-g" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/wal-g \
    && wal-g --version \
    && apt-get purge -y --auto-remove curl && rm -rf /var/lib/apt/lists/*
COPY --from=extensions /opt/vector/ /
# The runtime provides config/credentials separately; no tenant secrets enter image layers.
STOPSIGNAL SIGINT
