#!/bin/sh
set -eu
# The upstream initializer itself connects over the SCRAM-protected local socket.
export PGPASSWORD="$(cat "${POSTGRES_PASSWORD_FILE:?Set POSTGRES_PASSWORD_FILE to the mounted owner credential}")"
exec /usr/local/bin/docker-entrypoint.sh "$@"
