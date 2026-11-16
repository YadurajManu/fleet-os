ARG REDIS_IMAGE
FROM ${REDIS_IMAGE}
LABEL io.fleet.database-image="true"
# No unauthenticated default: the stateful runtime must supply its generated config and ACL.
CMD ["redis-server", "/etc/fleet/redis.conf"]
STOPSIGNAL SIGTERM
