#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
docker compose build control-plane dashboard
docker compose up -d --remove-orphans control-plane dashboard
echo "Fleet OS deployed: API :8080, Dashboard :8082"
