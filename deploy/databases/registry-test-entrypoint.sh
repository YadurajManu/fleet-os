#!/bin/sh
set -eu
registry serve /etc/docker/registry/config.yml &
# This daemon owns only disposable test volumes and has no host Docker socket.
export DOCKER_TLS_CERTDIR=''
exec dockerd-entrypoint.sh dockerd --host=unix:///var/run/docker.sock --host=tcp://0.0.0.0:2375 --tls=false --bip=172.30.0.1/24
