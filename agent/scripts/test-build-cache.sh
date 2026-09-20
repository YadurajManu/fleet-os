#!/bin/bash
# Manual integration test: requires Docker + Buildx. Creates a temporary worker,
# builds scratch contexts, verifies the cache cap, and removes its own resources.
set -euo pipefail
scratch=$(mktemp -d /tmp/fleet-cache-check.XXXXXX)
builder="fleet-$(openssl rand -hex 12)"
export DOCKER_HOST="$(docker context inspect --format '{{.Endpoints.docker.Host}}')"
export DOCKER_CONFIG="$scratch/docker"
unset DOCKER_CONTEXT
mkdir -p "$DOCKER_CONFIG" "$scratch/source"
python3 -c 'import json,os;json.dump({"cliPluginsExtraDirs":[os.path.expanduser("~/.docker/cli-plugins"),"/Applications/Docker.app/Contents/Resources/cli-plugins"]},open(os.environ["DOCKER_CONFIG"]+"/config.json","w"))'
cleanup() { docker buildx rm --force "$builder" >/dev/null 2>&1 || true; rm -rf "$scratch"; }
trap cleanup EXIT
printf 'FROM scratch\nCOPY blob /blob\n' > "$scratch/source/Dockerfile"
docker buildx create --name "$builder" --driver docker-container --driver-opt memory=512m,cpu-period=100000,cpu-quota=100000 --bootstrap >/dev/null
prune_flag=--keep-storage
if docker buildx prune --help | grep -q -- '--max-used-space'; then prune_flag=--max-used-space; fi
for round in 1 2 3; do
 dd if=/dev/urandom of="$scratch/source/blob" bs=1048576 count=4 2>/dev/null
 docker buildx build --builder "$builder" --network=none --output type=cacheonly "$scratch/source" >/dev/null 2>&1
 docker buildx prune --builder "$builder" --all --force "$prune_flag" 1MB >/dev/null
 docker buildx du --builder "$builder" --format '{{json .}}' > "$scratch/usage.jsonl"
 python3 - "$scratch/usage.jsonl" "$round" <<'PY'
import json,sys,re
rows=[json.loads(line) for line in open(sys.argv[1]) if line.strip()]
def byte_size(value):
 match=re.fullmatch(r'([0-9.]+)([kMGT]?B)?',str(value))
 return float(match[1])*{'B':1,'kB':1000,'MB':1000000,'GB':1000000000,'TB':1000000000000,None:1}[match[2]]
size=sum(byte_size(row['Size']) for row in rows)
print(f'Build {sys.argv[2]}: retained cache {size} bytes (cap 1000000)')
assert size <= 1000000, rows
PY
done
