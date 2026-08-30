#!/bin/sh
set -eu

artifact_directory=${1:-.portable}
case "$artifact_directory" in
  /*) ;;
  *) artifact_directory=$(pwd -P)/$artifact_directory ;;
esac
[ -d "$artifact_directory" ] || { printf 'portable artifact directory is missing: %s\n' "$artifact_directory" >&2; exit 2; }
[ -f "$artifact_directory/portable-release.json" ] || { printf 'portable-release.json is missing\n' >&2; exit 2; }
command -v node >/dev/null 2>&1 || { printf 'build-host Node is required to read the release manifest\n' >&2; exit 2; }
command -v docker >/dev/null 2>&1 || { printf 'Docker is required for clean-host verification\n' >&2; exit 2; }

archive_filename=$(node -e 'const m=require(process.argv[1]); if(m.target!=="linux-x64-gnu")process.exit(2); process.stdout.write(m.archive.filename)' "$artifact_directory/portable-release.json")
installer_filename=$(node -e 'const m=require(process.argv[1]); process.stdout.write(m.installer.filename)' "$artifact_directory/portable-release.json")
version=$(node -e 'const m=require(process.argv[1]); process.stdout.write(m.version)' "$artifact_directory/portable-release.json")
[ -f "$artifact_directory/$archive_filename" ] || { printf 'portable archive is missing\n' >&2; exit 2; }
[ -f "$artifact_directory/$installer_filename" ] || { printf 'portable installer is missing\n' >&2; exit 2; }

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
result_log=$(mktemp "${TMPDIR:-/tmp}/relayforge-portable-smoke.XXXXXX")
cleanup() { rm -f -- "$result_log"; }
trap cleanup EXIT HUP INT TERM
if docker run --rm --platform linux/amd64 \
    --volume "$artifact_directory:/artifacts:ro" \
    --volume "$script_directory/portable-clean-host-guest.sh:/portable-clean-host-guest.sh:ro" \
    ubuntu:22.04 \
    sh /portable-clean-host-guest.sh "$archive_filename" "$installer_filename" "$version" > "$result_log" 2>&1; then
  sed -n '1,240p' "$result_log"
else
  status=$?
  sed -n '1,240p' "$result_log" >&2
  exit "$status"
fi
marker=$(grep -E '^CLEAN_HOST_SMOKE_PASS elapsedSeconds=[0-9]+ node=absent npm=absent compiler=absent dashboard=opened$' "$result_log")
elapsed=$(printf '%s\n' "$marker" | sed -E 's/^CLEAN_HOST_SMOKE_PASS elapsedSeconds=([0-9]+).*$/\1/')
node "$script_directory/portable-linux.mjs" --record-clean-host "$artifact_directory/portable-release.json" "$elapsed" >/dev/null
printf 'Recorded clean-host proof in portable-release.json\n'
