#!/bin/sh

# This template is rendered by scripts/portable-linux.mjs. The tokens are
# deliberately invalid release values so an unrendered source checkout cannot
# masquerade as an installer.
RELAYFORGE_RELEASE_VERSION='@@VERSION@@'
RELAYFORGE_ARCHIVE_FILENAME='@@ARCHIVE_FILENAME@@'
RELAYFORGE_ARCHIVE_SHA256='@@ARCHIVE_SHA256@@'
RELAYFORGE_DOWNLOAD_URL='@@DOWNLOAD_URL@@'

set -eu

die() {
  printf '%s\n' "relayforge installer: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Install the self-contained RelayForge Linux x64 bundle without root or npm.

Usage:
  sh install-relayforge-linux-x64.sh [--archive PATH] [--prefix PATH] [--bin-dir PATH]
  sh install-relayforge-linux-x64.sh --rollback [--prefix PATH] [--bin-dir PATH]

Defaults:
  install root  $XDG_DATA_HOME/relayforge or $HOME/.local/share/relayforge
  command links $HOME/.local/bin

When --archive is omitted, the installer uses a matching archive beside this
script or downloads the exact release asset bound to its embedded SHA-256.
EOF
}

archive=''
prefix=''
bin_dir=''
rollback='false'

while [ "$#" -gt 0 ]; do
  case "$1" in
    --archive)
      [ "$#" -ge 2 ] || die '--archive requires a path'
      archive=$2
      shift 2
      ;;
    --prefix)
      [ "$#" -ge 2 ] || die '--prefix requires a path'
      prefix=$2
      shift 2
      ;;
    --bin-dir)
      [ "$#" -ge 2 ] || die '--bin-dir requires a path'
      bin_dir=$2
      shift 2
      ;;
    --rollback)
      rollback='true'
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ "$(uname -s)" = 'Linux' ] || die 'this artifact supports Linux only'
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) die 'this artifact supports x86_64/amd64 only' ;;
esac

case "${HOME:-}" in
  /*) ;;
  *) die 'HOME must be an absolute path' ;;
esac

if [ -z "$prefix" ]; then
  if [ -n "${XDG_DATA_HOME:-}" ]; then
    prefix=$XDG_DATA_HOME/relayforge
  else
    prefix=$HOME/.local/share/relayforge
  fi
fi
[ -n "$bin_dir" ] || bin_dir=$HOME/.local/bin

case "$prefix" in
  /*) ;;
  *) die '--prefix must be an absolute path' ;;
esac
case "$bin_dir" in
  /*) ;;
  *) die '--bin-dir must be an absolute path' ;;
esac
case "$prefix" in
  /|/bin|/etc|/lib|/lib64|/sbin|/usr|/usr/bin|/usr/lib|/var) die 'refusing an unsafe install prefix' ;;
esac

if [ -L "$prefix" ]; then
  die "install prefix must not be a symlink: $prefix"
fi
if [ -L "$bin_dir" ]; then
  die "command directory must not be a symlink: $bin_dir"
fi

mkdir -p -- "$prefix/versions" "$bin_dir"
[ -d "$prefix" ] && [ ! -L "$prefix" ] || die 'could not create a safe install prefix'
[ -d "$bin_dir" ] && [ ! -L "$bin_dir" ] || die 'could not create a safe command directory'

atomic_link() {
  link_target=$1
  link_path=$2
  temporary_link="${link_path}.new.$$"
  rm -f -- "$temporary_link"
  ln -s -- "$link_target" "$temporary_link"
  mv -Tf -- "$temporary_link" "$link_path"
}

managed_state_link() {
  state_path=$1
  if [ -e "$state_path" ] && [ ! -L "$state_path" ]; then
    die "managed state path is not a symlink: $state_path"
  fi
}

link_commands() {
  for command_name in relayforge loop loop-orchestrator; do
    command_path=$bin_dir/$command_name
    if [ -e "$command_path" ] || [ -L "$command_path" ]; then
      [ -L "$command_path" ] || die "refusing to replace non-symlink command: $command_path"
      existing_target=$(readlink "$command_path")
      case "$existing_target" in
        "$prefix"/current/bin/relayforge|"$prefix"/current/bin/loop|"$prefix"/current/bin/loop-orchestrator) ;;
        *) die "refusing to replace command link not managed by this install: $command_path" ;;
      esac
    fi
    atomic_link "$prefix/current/bin/$command_name" "$command_path"
  done
}

managed_state_link "$prefix/current"
managed_state_link "$prefix/previous"

if [ "$rollback" = 'true' ]; then
  [ -z "$archive" ] || die '--archive cannot be combined with --rollback'
  [ -L "$prefix/current" ] || die 'there is no current installation to roll back'
  [ -L "$prefix/previous" ] || die 'there is no previous installation to roll back to'
  current_target=$(readlink "$prefix/current")
  previous_target=$(readlink "$prefix/previous")
  case "$current_target" in versions/*) ;; *) die 'current link is outside the version store' ;; esac
  case "$previous_target" in versions/*) ;; *) die 'previous link is outside the version store' ;; esac
  [ -d "$prefix/$current_target" ] || die 'current installation is missing'
  [ -d "$prefix/$previous_target" ] || die 'previous installation is missing'
  atomic_link "$previous_target" "$prefix/current"
  atomic_link "$current_target" "$prefix/previous"
  link_commands
  "$prefix/current/bin/relayforge" --version >/dev/null
  printf 'RelayForge rolled back to %s\n' "${previous_target#versions/}"
  exit 0
fi

download_dir=''
install_stage=''
cleanup() {
  if [ -n "$install_stage" ] && [ -d "$install_stage" ]; then
    rm -rf -- "$install_stage"
  fi
  if [ -n "$download_dir" ] && [ -d "$download_dir" ]; then
    rm -rf -- "$download_dir"
  fi
}
trap cleanup EXIT HUP INT TERM

if [ -z "$archive" ]; then
  script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd -P || true)
  if [ -n "$script_dir" ] && [ -f "$script_dir/$RELAYFORGE_ARCHIVE_FILENAME" ]; then
    archive=$script_dir/$RELAYFORGE_ARCHIVE_FILENAME
  else
    download_dir=$(mktemp -d "${TMPDIR:-/tmp}/relayforge-download.XXXXXX")
    archive=$download_dir/$RELAYFORGE_ARCHIVE_FILENAME
    printf 'Downloading %s\n' "$RELAYFORGE_DOWNLOAD_URL"
    if command -v curl >/dev/null 2>&1; then
      curl --fail --location --proto '=https' --tlsv1.2 --output "$archive" "$RELAYFORGE_DOWNLOAD_URL"
    elif command -v wget >/dev/null 2>&1; then
      wget -O "$archive" "$RELAYFORGE_DOWNLOAD_URL"
    else
      die 'curl or wget is required when the archive is not supplied locally'
    fi
  fi
fi

[ -f "$archive" ] || die "archive does not exist: $archive"

if command -v sha256sum >/dev/null 2>&1; then
  actual_sha256=$(sha256sum -- "$archive" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual_sha256=$(shasum -a 256 -- "$archive" | awk '{print $1}')
else
  die 'sha256sum or shasum is required to verify the release artifact'
fi
[ "$actual_sha256" = "$RELAYFORGE_ARCHIVE_SHA256" ] || die 'archive SHA-256 does not match this installer'

archive_root="relayforge-$RELAYFORGE_RELEASE_VERSION-linux-x64"
tar -tzf "$archive" | awk -v root="$archive_root" '
  $0 == root || $0 == root "/" || index($0, root "/") == 1 {
    count = split($0, parts, "/")
    for (i = 1; i <= count; i++) {
      if (parts[i] == "." || parts[i] == "..") exit 42
    }
    next
  }
  { exit 43 }
' || die 'archive contains a path outside its versioned root'

install_stage=$(mktemp -d "$prefix/versions/.install-$RELAYFORGE_RELEASE_VERSION.XXXXXX")
tar --no-same-owner --no-same-permissions -xzf "$archive" -C "$install_stage"
bundle=$install_stage/$archive_root
[ -x "$bundle/runtime/bin/node" ] || die 'bundle is missing its executable Node runtime'
[ -f "$bundle/app/dist/cli.js" ] || die 'bundle is missing the RelayForge CLI'

installed_version=$("$bundle/runtime/bin/node" "$bundle/app/dist/cli.js" --version)
[ "$installed_version" = "$RELAYFORGE_RELEASE_VERSION" ] || die 'bundle CLI version does not match the installer'
"$bundle/runtime/bin/node" -e '
  const fs = require("node:fs");
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.product !== "relayforge" ||
      manifest.version !== process.argv[2] || manifest.target !== "linux-x64-gnu" ||
      manifest.node?.version !== "v22.23.2" || manifest.nativeModules?.[0]?.name !== "better-sqlite3") {
    process.exit(8);
  }
' "$bundle/portable-manifest.json" "$RELAYFORGE_RELEASE_VERSION" || die 'portable manifest validation failed'

printf '%s\n' "$RELAYFORGE_ARCHIVE_SHA256" > "$bundle/.archive-sha256"
chmod 0644 "$bundle/.archive-sha256"
version_target=$prefix/versions/$RELAYFORGE_RELEASE_VERSION
if [ -e "$version_target" ] || [ -L "$version_target" ]; then
  [ -d "$version_target" ] && [ ! -L "$version_target" ] || die 'existing version target is not a regular directory'
  [ -f "$version_target/.archive-sha256" ] || die 'existing version is not managed by the portable installer'
  existing_sha256=$(sed -n '1p' "$version_target/.archive-sha256")
  [ "$existing_sha256" = "$RELAYFORGE_ARCHIVE_SHA256" ] || die 'same version already exists with different contents'
else
  mv -- "$bundle" "$version_target"
fi

new_target=versions/$RELAYFORGE_RELEASE_VERSION
old_target=''
if [ -L "$prefix/current" ]; then
  old_target=$(readlink "$prefix/current")
  case "$old_target" in versions/*) ;; *) die 'current link is outside the version store' ;; esac
  [ -d "$prefix/$old_target" ] || die 'current installation is missing'
fi
if [ -n "$old_target" ] && [ "$old_target" != "$new_target" ]; then
  atomic_link "$old_target" "$prefix/previous"
fi
atomic_link "$new_target" "$prefix/current"
link_commands

"$prefix/current/bin/relayforge" --version >/dev/null
printf 'RelayForge %s installed in %s\n' "$RELAYFORGE_RELEASE_VERSION" "$version_target"
case ":${PATH:-}:" in
  *:"$bin_dir":*) ;;
  *) printf 'Add %s to PATH, then run: relayforge setup\n' "$bin_dir" ;;
esac
