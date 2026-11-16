ARG DEBIAN_IMAGE
FROM ${DEBIAN_IMAGE} AS build
ARG PGBOUNCER_VERSION
ARG PGBOUNCER_SHA256
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl build-essential pkg-config libevent-dev libssl-dev \
    && curl -fsSL --retry 3 "https://github.com/pgbouncer/pgbouncer/releases/download/pgbouncer_$(echo ${PGBOUNCER_VERSION} | tr . _)/pgbouncer-${PGBOUNCER_VERSION}.tar.gz" -o /tmp/pgbouncer.tar.gz \
    && echo "${PGBOUNCER_SHA256}  /tmp/pgbouncer.tar.gz" | sha256sum -c - \
    && mkdir /tmp/pgbouncer && tar -xzf /tmp/pgbouncer.tar.gz -C /tmp/pgbouncer --strip-components=1 \
    && cd /tmp/pgbouncer && ./configure --prefix=/usr/local --with-openssl && make -j2 && make install
FROM ${DEBIAN_IMAGE}
LABEL io.fleet.database-image="true"
RUN apt-get update && apt-get install -y --no-install-recommends libevent-2.1-7 libssl3 ca-certificates \
    && useradd --uid 999 --system --no-create-home fleet-pooler && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/pgbouncer /usr/local/bin/pgbouncer
USER 999:999
STOPSIGNAL SIGTERM
ENTRYPOINT ["pgbouncer"]
CMD ["/etc/fleet/pgbouncer.ini"]
