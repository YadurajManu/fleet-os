#!/usr/bin/env bash
# Run on the Docker Compose host. No browser or agent gets shell access.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
git_safe=(git -c "safe.directory=$root")
compose=(docker compose -f deploy/docker-compose.yml)
action=${1:-check}

if [[ $action != check && $action != apply ]]; then
  echo 'usage: ./deploy/upgrade.sh [check|apply]' >&2
  exit 2
fi
if [[ $("${git_safe[@]}" branch --show-current) != main ]]; then
  echo 'Upgrade requires the main branch on the Compose host.' >&2
  exit 1
fi
if [[ -n $("${git_safe[@]}" status --porcelain) ]]; then
  echo 'Upgrade requires a clean checkout. Preserve local changes before retrying.' >&2
  exit 1
fi

old=$("${git_safe[@]}" rev-parse HEAD)
"${git_safe[@]}" fetch origin main
next=$("${git_safe[@]}" rev-parse origin/main)
if ! "${git_safe[@]}" merge-base --is-ancestor "$old" "$next"; then
  echo 'main cannot fast-forward to origin/main; inspect the history first.' >&2
  exit 1
fi
printf 'running %s\navailable %s\n' "$old" "$next"
if [[ $action == check || $old == "$next" ]]; then
  [[ $old == "$next" ]] && echo 'Already current.'
  exit 0
fi

backup_dir=${FLEET_BACKUP_DIR:-/var/backups/fleet-os}
install -d -m 0700 "$backup_dir"
run_dir=$(mktemp -d "$backup_dir/upgrade-XXXXXXXX")
chmod 0700 "$run_dir"
"${compose[@]}" exec -T postgres sh -c 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$run_dir/postgres.dump"
"${compose[@]}" exec -T postgres pg_restore --list < "$run_dir/postgres.dump" > /dev/null
test -s "$run_dir/postgres.dump"
printf '%s\n' "$old" > "$run_dir/previous-revision"

# Save a runnable rollback before the first production mutation. Old images
# can be rebuilt from the recorded source even after Compose tags are replaced.
cat > "$run_dir/rollback.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd '$root'
git -c 'safe.directory=$root' switch --detach '$old'
export FLEET_REVISION='$old'
docker compose -f deploy/docker-compose.yml up -d --build control-plane dashboard www
echo 'Check API, dashboard, website, node heartbeats, and services. Database was not restored.'
EOF
chmod 0700 "$run_dir/rollback.sh"
echo "Verified Postgres backup: $run_dir/postgres.dump"
echo "Rollback command: bash $run_dir/rollback.sh"

# Deploy exactly the revision checked above, even if origin advances between
# backup and rollout.
"${git_safe[@]}" merge --ff-only "$next"
export FLEET_REVISION=$("${git_safe[@]}" rev-parse --short=12 HEAD)
if ! "${compose[@]}" up -d --build control-plane dashboard www; then
  echo 'Compose failed; restoring the previous revision.' >&2
  bash "$run_dir/rollback.sh"
  exit 1
fi

healthy=false
for _ in {1..30}; do
  if [[ $(docker inspect -f '{{.State.Health.Status}}' fleet-control-plane 2>/dev/null || true) == healthy ]] \
    && [[ $(docker inspect -f '{{.State.Running}}' fleet-dashboard 2>/dev/null || true) == true ]] \
    && [[ $(docker inspect -f '{{.State.Running}}' fleet-www 2>/dev/null || true) == true ]]; then
    healthy=true
    break
  fi
  sleep 2
done
if [[ $healthy != true ]]; then
  echo 'Health check failed; restoring the previous revision.' >&2
  bash "$run_dir/rollback.sh"
  exit 1
fi
echo "Updated to $FLEET_REVISION. Check external routes and fleet status before closing the maintenance window."
