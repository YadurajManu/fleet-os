ARG REDIS_IMAGE=redis:7-bookworm@sha256:2e3eb11462c4e3759e6972678dd051d150ff54b1e60714b3c33b701260172a90
FROM ${REDIS_IMAGE}
ARG TARGETARCH
LABEL io.fleet.database-image="true"
COPY --chmod=0755 .build/proxy/${TARGETARCH}/fleet-db-proxy /usr/local/bin/fleet-db-proxy
# No unauthenticated default: the stateful runtime must supply its generated config and ACL.
CMD ["redis-server", "/etc/fleet/redis.conf"]
STOPSIGNAL SIGTERM
