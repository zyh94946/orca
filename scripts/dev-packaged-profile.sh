#!/usr/bin/env bash
# Launch `pnpm dev` against the official packaged Orca profile.
# Quit the packaged app first — two processes must not share userData.
# Pass --try to run checks only (no pnpm install / no app start).
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

try_mode=0
forwarded=()
for arg in "$@"; do
  if [[ "$arg" == "--try" ]]; then
    try_mode=1
  else
    forwarded+=("$arg")
  fi
done

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

packaged_running=0
if pgrep -f 'Orca.app/Contents/MacOS/Orca' >/dev/null 2>&1; then
  packaged_running=1
fi
if [[ "$(uname -s)" == "Linux" ]] && pgrep -x orca >/dev/null 2>&1; then
  packaged_running=1
fi

if [[ "$try_mode" -eq 1 ]]; then
  echo "try: repo=$repo_root"
  echo "try: ORCA_DEV_USER_DATA_PATH=$ORCA_DEV_USER_DATA_PATH"
  echo "try: ORCA_DEV_SAFE_STORAGE_APP_NAME=$ORCA_DEV_SAFE_STORAGE_APP_NAME"
  failed=0
  if [[ ! -d "$ORCA_DEV_USER_DATA_PATH" ]]; then
    echo "try: fail: packaged userData directory is missing" >&2
    failed=1
  else
    echo "try: userData directory exists"
  fi
  if [[ "$packaged_running" -eq 1 ]]; then
    echo "try: fail: packaged Orca looks running; quit it before sharing this profile" >&2
    failed=1
  else
    echo "try: no packaged Orca process detected"
  fi
  if [[ "$failed" -ne 0 ]]; then
    echo "try: checks failed; not starting pnpm dev" >&2
    exit 1
  fi
  echo "try: checks passed; not starting pnpm dev"
  exit 0
fi

if [[ ! -d "$ORCA_DEV_USER_DATA_PATH" ]]; then
  echo "warning: packaged userData directory is missing: $ORCA_DEV_USER_DATA_PATH" >&2
fi
if [[ "$packaged_running" -eq 1 ]]; then
  echo "warning: a packaged Orca process looks running; quit it before sharing this profile." >&2
fi

if [[ ${#forwarded[@]} -eq 0 ]]; then
  exec pnpm dev
fi
exec pnpm dev "${forwarded[@]}"
