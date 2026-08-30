#!/bin/sh
set -eu

if [ "$(id -u)" -eq 0 ]; then
  [ "$#" -eq 3 ] || { printf 'usage: %s ARCHIVE INSTALLER VERSION\n' "$0" >&2; exit 2; }
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y --no-install-recommends ca-certificates curl git >/dev/null
  useradd --create-home --uid 10001 --shell /bin/sh relayforge-smoke
  exec runuser -u relayforge-smoke -- env \
    HOME=/home/relayforge-smoke \
    PATH=/usr/bin:/bin \
    sh "$0" --as-user "$1" "$2" "$3"
fi

[ "${1:-}" = '--as-user' ] && [ "$#" -eq 4 ] || { printf 'invalid clean-host invocation\n' >&2; exit 2; }
archive=/artifacts/$2
installer=/artifacts/$3
expected_version=$4

for forbidden_command in node npm python3 cc c++ gcc g++ make; do
  if command -v "$forbidden_command" >/dev/null 2>&1; then
    printf 'clean-host precondition failed: %s is installed\n' "$forbidden_command" >&2
    exit 3
  fi
done

started=$(date +%s)
sh "$installer" --archive "$archive"
export PATH=$HOME/.local/bin:/usr/bin:/bin

[ "$(relayforge --version)" = "$expected_version" ]
project=$HOME/project
mkdir -p "$project"
cd "$project"
git init -q
git config user.name 'RelayForge Portable Smoke'
git config user.email 'portable-smoke@example.invalid'
printf '# Portable smoke\n' > README.md
git add README.md
git commit -qm 'initial project'

relayforge setup --provider custom > "$HOME/setup.log"
grep -F 'Safe planning: ready' "$HOME/setup.log"
git add relayforge.config.yaml brief.md .gitignore
git commit -qm 'configure RelayForge'
relayforge run 'Plan a small verified coding change' --run portable-smoke --json > "$HOME/dry-run.json"
grep -F '"status": "planned"' "$HOME/dry-run.json"

relayforge serve --port 4318 > "$HOME/serve.log" 2>&1 &
service_pid=$!
cleanup_service() {
  kill "$service_pid" 2>/dev/null || true
  wait "$service_pid" 2>/dev/null || true
}
trap cleanup_service EXIT HUP INT TERM

dashboard_ready='false'
attempt=0
while [ "$attempt" -lt 100 ]; do
  if curl --fail --silent --show-error http://127.0.0.1:4318/ > "$HOME/dashboard.html" 2>/dev/null; then
    dashboard_ready='true'
    break
  fi
  attempt=$((attempt + 1))
  sleep 0.1
done
[ "$dashboard_ready" = 'true' ] || { sed -n '1,160p' "$HOME/serve.log" >&2; exit 4; }
grep -F 'RelayForge' "$HOME/dashboard.html" >/dev/null
relayforge serve stop --timeout 7000 >/dev/null
wait "$service_pid"
trap - EXIT HUP INT TERM

finished=$(date +%s)
elapsed=$((finished - started))
[ "$elapsed" -lt 120 ] || { printf 'portable journey took %s seconds\n' "$elapsed" >&2; exit 5; }
printf 'CLEAN_HOST_SMOKE_PASS elapsedSeconds=%s node=absent npm=absent compiler=absent dashboard=opened\n' "$elapsed"
