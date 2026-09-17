#!/usr/bin/env bash
# Launch `pnpm dev` against the official packaged Orca profile.
# Quit the packaged app first — two processes must not share userData.
# Pulls origin (the fork branch the release-sync Action pushes) with --ff-only.
# Pass --try to run checks only (no pull / no pnpm install / no app start).
# Pass --no-pull to skip git fetch/pull.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

try_mode=0
skip_pull=0
forwarded=()
for arg in "$@"; do
  if [[ "$arg" == "--try" ]]; then
    try_mode=1
  elif [[ "$arg" == "--no-pull" ]]; then
    skip_pull=1
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

fetch_upstream_remote() {
  local remote="$1"
  GIT_TERMINAL_PROMPT=0 python3 - "$remote" <<'PY'
import os, subprocess, sys

remote = sys.argv[1]
env = os.environ.copy()
env["GIT_TERMINAL_PROMPT"] = "0"
try:
    completed = subprocess.run(["git", "fetch", "--quiet", remote], env=env, timeout=25)
except subprocess.TimeoutExpired:
    sys.exit(1)
sys.exit(completed.returncode)
PY
}

report_origin_sync() {
  local branch remote_ref behind ahead
  branch="$(git rev-parse --abbrev-ref HEAD)"
  echo "try: branch=$branch"
  if [[ "$branch" == "HEAD" ]]; then
    echo "try: detached HEAD; launch would skip git pull"
    return 0
  fi
  if ! git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
    echo "try: no upstream; launch would skip git pull"
    return 0
  fi
  remote_ref="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}')"
  if ! fetch_upstream_remote "$(cut -d/ -f1 <<<"$remote_ref")"; then
    echo "try: warning: git fetch failed or timed out; launch would skip git pull" >&2
    return 0
  fi
  behind="$(git rev-list --count "HEAD..@{u}")"
  ahead="$(git rev-list --count "@{u}..HEAD")"
  echo "try: upstream=$remote_ref behind=$behind ahead=$ahead"
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "try: working tree is dirty; launch would skip git pull"
  fi
  return 0
}

# Fast-forward to origin only. Never merge stablyai/main here — the GitHub
# Action merges official desktop tags into this fork branch first.
pull_origin_ff_only() {
  local branch remote_ref
  branch="$(git rev-parse --abbrev-ref HEAD)"
  if [[ "$branch" == "HEAD" ]]; then
    echo "warning: detached HEAD; skipping git pull" >&2
    return 0
  fi
  if ! git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
    echo "warning: no upstream for $branch; skipping git pull" >&2
    return 0
  fi
  remote_ref="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}')"
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "warning: working tree is dirty; skipping git pull" >&2
    return 0
  fi
  if ! fetch_upstream_remote "$(cut -d/ -f1 <<<"$remote_ref")"; then
    echo "warning: git fetch failed or timed out; starting with local tree" >&2
    return 0
  fi
  if git merge-base --is-ancestor HEAD '@{u}' && ! git merge-base --is-ancestor '@{u}' HEAD; then
    if git pull --ff-only; then
      echo "synced to $(git rev-parse --short HEAD) ($remote_ref)"
    else
      echo "warning: git pull --ff-only failed; starting with local tree" >&2
    fi
    return 0
  fi
  if git merge-base --is-ancestor '@{u}' HEAD; then
    echo "already up to date with $remote_ref"
    return 0
  fi
  echo "warning: $branch and $remote_ref have diverged; skipping git pull" >&2
}

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
  if [[ "$skip_pull" -eq 0 ]]; then
    if ! report_origin_sync; then
      failed=1
    fi
  else
    echo "try: skip-pull"
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
if [[ "$skip_pull" -eq 0 ]]; then
  pull_origin_ff_only
fi

if [[ ${#forwarded[@]} -eq 0 ]]; then
  exec pnpm dev
fi
exec pnpm dev "${forwarded[@]}"
