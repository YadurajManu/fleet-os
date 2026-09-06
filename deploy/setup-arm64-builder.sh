#!/bin/sh
# Add a NATIVE arm64 node to the control plane's buildx builder.
#
# Why this exists
# ---------------
# The control plane runs on an amd64 Lightsail instance and most fleet nodes are
# arm64, so every arm64 image was produced by QEMU emulating the whole
# Dockerfile. That is not a small penalty: a FastAPI service installing
# cryptography, bcrypt and psycopg2 took long enough to look like a hang, and
# BUILD_TIMEOUT_MS is 20 minutes.
#
# buildx solves this natively. A builder is a set of NODES, and when a build
# asks for two platforms buildx dispatches each one to a node that can do it
# without emulation. So the fix is not a second build system — it is one more
# node on the builder that already exists.
#
# What you need
# -------------
# Any arm64 machine the control plane can reach over SSH with a Docker daemon on
# it. An AWS Graviton instance (t4g.small is enough) is the obvious choice next
# to a Lightsail control plane; a spare Pi 5 or an arm64 VM works identically.
#
# It must NOT be a fleet node. A builder competes for CPU and disk with whatever
# else runs there, and a node that is busy building is a node that is slow at
# the thing it was paired for.
#
# Usage, on the control plane host:
#
#   ARM64_HOST=ubuntu@10.0.1.42 ./deploy/setup-arm64-builder.sh
#
# then put this in deploy/.env and restart the control plane:
#
#   BUILDX_PLATFORM_BUILDERS=linux/arm64=fleet-builder
#
# (The same builder name as before: the arm64 work goes to the new node inside
# it. The variable is what makes the routing explicit and what the logs report.)
set -eu

BUILDER="${BUILDER:-fleet-builder}"
ARM64_HOST="${ARM64_HOST:-}"
REGISTRY="${REGISTRY:-localhost:5001}"

[ -n "$ARM64_HOST" ] || {
  echo "ARM64_HOST is required, e.g. ARM64_HOST=ubuntu@10.0.1.42" >&2
  exit 1
}

# SSH multiplexing is off by default in Docker's ssh:// transport and a build
# opens many connections. Without a control socket every one of them pays a full
# handshake, which shows up as a build that stalls between layers.
echo "checking ssh to ${ARM64_HOST}…"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$ARM64_HOST" 'docker version --format "{{.Server.Arch}}"' \
  | grep -q 'arm64\|aarch64' || {
  echo "that host's Docker does not report an arm64 server; nothing would be gained" >&2
  exit 1
}

CONFIG="$(mktemp -d)/buildkitd.toml"
cat > "$CONFIG" <<TOML
[registry."${REGISTRY}"]
  http = true
  insecure = true
TOML

# --append adds a node to an existing builder rather than replacing it, so the
# amd64 node already there keeps serving amd64 natively. Removing and recreating
# the builder would throw away its local cache.
echo "appending an arm64 node to \"${BUILDER}\"…"
docker buildx create \
  --name "$BUILDER" \
  --append \
  --node "${BUILDER}-arm64" \
  --driver docker-container \
  --platform linux/arm64 \
  --config "$CONFIG" \
  "ssh://${ARM64_HOST}" >/dev/null

echo "bootstrapping…"
docker buildx inspect --bootstrap "$BUILDER"

cat <<'DONE'

Look at the Platforms line for each node above.

  linux/arm64     native   — what you want
  linux/arm64*    emulated — the asterisk means QEMU, so the node did not attach

Then set, in deploy/.env:

  BUILDX_PLATFORM_BUILDERS=linux/arm64=fleet-builder

and restart the control plane. `fleet deployments <service>` will show the
platform and say "emulated" when it is, so you can confirm it took effect on the
next build rather than inferring it from the clock.
DONE
