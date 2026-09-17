#!/usr/bin/env bash
# Launch `pnpm dev` against the official packaged Orca profile.
# Quit the packaged app first — two processes must not share userData.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

if [[ -z "${ORCA_DEV_USER_DATA_PATH:-}" ]]; then
  case "$(uname -s)" in
    Darwin)
      ORCA_DEV_USER_DATA_PATH="$HOME/Library/Application Support/Orca"
      ;;
    Linux)
      ORCA_DEV_USER_DATA_PATH="${XDG_CONFIG_HOME:-$HOME/.config}/Orca"
      ;;
    *)
      echo "scripts/dev-packaged-profile.sh: set ORCA_DEV_USER_DATA_PATH for this OS" >&2
      exit 1
      ;;
  esac
fi
export ORCA_DEV_USER_DATA_PATH
export ORCA_DEV_SAFE_STORAGE_APP_NAME=Orca

if [[ ! -d "$ORCA_DEV_USER_DATA_PATH" ]]; then
  echo "warning: packaged userData directory is missing: $ORCA_DEV_USER_DATA_PATH" >&2
fi

packaged_running=0
if pgrep -f 'Orca.app/Contents/MacOS/Orca' >/dev/null 2>&1; then
  packaged_running=1
fi
if [[ "$(uname -s)" == "Linux" ]] && pgrep -x orca >/dev/null 2>&1; then
  packaged_running=1
fi
if [[ "$packaged_running" -eq 1 ]]; then
  echo "warning: a packaged Orca process looks running; quit it before sharing this profile." >&2
fi

exec pnpm dev "$@"
