#!/usr/bin/env bash
# Merge the latest official desktop Orca release tag into this branch.
# Default target is personal/spatial-pane-focus. Does not force-push.
# Pass --dry-run to print the tag without merging.
set -euo pipefail

UPSTREAM_REPO="${UPSTREAM_REPO:-stablyai/orca}"
UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/${UPSTREAM_REPO}.git}"
PERSONAL_BRANCH="${PERSONAL_BRANCH:-personal/spatial-pane-focus}"
ISSUE_LABEL="${ISSUE_LABEL:-personal-release-sync}"

requested_tag=""
dry_run=0
do_push=0
open_issue=0

usage() {
  cat <<'EOF'
Usage: scripts/merge-official-desktop-release.sh [--tag vX.Y.Z] [--dry-run] [--push] [--open-issue]
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) dry_run=1; shift ;;
    --push) do_push=1; shift ;;
    --open-issue) open_issue=1; shift ;;
    --tag)
      if [[ $# -lt 2 || "$2" == --* ]]; then
        echo "scripts/merge-official-desktop-release.sh: --tag requires a value" >&2
        exit 2
      fi
      requested_tag="$2"
      shift 2
      ;;
    --tag=*)
      requested_tag="${1#--tag=}"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "scripts/merge-official-desktop-release.sh: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

is_desktop_release_tag() {
  local tag="$1"
  [[ "$tag" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

resolve_latest_desktop_tag() {
  local tag candidate
  tag="$(gh release view --repo "$UPSTREAM_REPO" --json tagName,isPrerelease \
    --jq 'if .isPrerelease then empty else .tagName end')"
  if [[ -n "$tag" ]] && is_desktop_release_tag "$tag"; then
    printf '%s\n' "$tag"
    return 0
  fi
  while IFS= read -r candidate; do
    if is_desktop_release_tag "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done < <(gh release list --repo "$UPSTREAM_REPO" --exclude-pre-releases --limit 40 --json tagName \
    --jq '.[].tagName')
  return 1
}

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

if [[ -n "$requested_tag" ]]; then
  tag="$requested_tag"
else
  tag="$(resolve_latest_desktop_tag)" || {
    echo "scripts/merge-official-desktop-release.sh: no desktop release tag found on $UPSTREAM_REPO" >&2
    exit 1
  }
fi

if ! is_desktop_release_tag "$tag"; then
  echo "scripts/merge-official-desktop-release.sh: refusing non-desktop tag: $tag" >&2
  exit 1
fi

echo "official desktop release: $tag"

if [[ "$dry_run" -eq 1 ]]; then
  if git rev-parse -q --verify "refs/tags/$tag" >/dev/null 2>&1 \
    && git merge-base --is-ancestor "$tag" HEAD; then
    echo "dry-run: HEAD already contains $tag"
  else
    echo "dry-run: would merge $tag into $(git rev-parse --abbrev-ref HEAD)"
  fi
  exit 0
fi

git fetch "$UPSTREAM_URL" "refs/tags/${tag}:refs/tags/${tag}" --force --no-tags

if git merge-base --is-ancestor "$tag" HEAD; then
  echo "HEAD already contains $tag"
  exit 0
fi

if [[ -z "$(git config user.name || true)" ]]; then
  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
fi

conflict_issue_url=""

conflict_issue() {
  local body
  body="$(
    cat <<EOF
Automatic merge of official desktop release \`$tag\` into \`$PERSONAL_BRANCH\` hit conflicts.

Resolve locally:

\`\`\`bash
git checkout $PERSONAL_BRANCH
git fetch https://github.com/${UPSTREAM_REPO}.git tag $tag
git merge $tag
# resolve conflicts, then:
git push origin $PERSONAL_BRANCH
\`\`\`

The next scheduled run will no-op once \`$tag\` is an ancestor of the branch.
EOF
  )"
  if [[ "$open_issue" -ne 1 ]]; then
    echo "$body" >&2
    return 0
  fi
  if ! command -v gh >/dev/null 2>&1; then
    echo "$body" >&2
    return 0
  fi
  gh label create "$ISSUE_LABEL" --description "Personal branch official-release sync" --color "0E8A16" >/dev/null 2>&1 || true
  local existing
  existing="$(gh issue list --state open --label "$ISSUE_LABEL" --search "merge official desktop release $tag" --json number,title \
    --jq ".[] | select(.title | test(\"$tag\")) | .number" | head -n 1 || true)"
  if [[ -n "$existing" ]]; then
    echo "conflict issue already open: #$existing" >&2
    if [[ -n "${GITHUB_REPOSITORY:-}" ]]; then
      conflict_issue_url="https://github.com/${GITHUB_REPOSITORY}/issues/${existing}"
    fi
    return 0
  fi
  conflict_issue_url="$(gh issue create --title "merge official desktop release $tag into $PERSONAL_BRANCH" \
    --label "$ISSUE_LABEL" --body "$body")"
}

notify_bark() {
  if [[ -z "${BARK_DEVICE_KEY:-}" ]]; then
    echo "bark: BARK_DEVICE_KEY unset; skipping" >&2
    return 0
  fi
  local title content url http_code
  title="Orca 合并冲突 ${tag}"
  content="${PERSONAL_BRANCH} 无法自动合并 ${tag}"
  if [[ -n "$conflict_issue_url" ]]; then
    content="${content} ${conflict_issue_url}"
  fi
  url="$(
    BARK_DEVICE_KEY="$BARK_DEVICE_KEY" python3 - "$title" "$content" <<'PY'
import os
import sys
import urllib.parse

title, content = sys.argv[1], sys.argv[2]
key = urllib.parse.quote(os.environ["BARK_DEVICE_KEY"], safe="")
path = "/".join(
    [
        key,
        urllib.parse.quote(title, safe=""),
        urllib.parse.quote(content, safe=""),
    ]
)
query = urllib.parse.urlencode(
    {
        "isArchive": "1",
        "group": "Github",
        "icon": "https://live4w.com/assets/github.png",
    }
)
print(f"https://bark.0w0ai.com/{path}?{query}")
PY
  )"
  http_code="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 15 "$url" || true)"
  if [[ "$http_code" =~ ^2 ]]; then
    echo "bark: notified" >&2
    return 0
  fi
  echo "bark: notify failed http=${http_code}" >&2
  return 1
}

if ! git merge --no-ff "$tag" -m "merge official desktop release $tag"; then
  echo "merge of $tag failed with conflicts" >&2
  git merge --abort >/dev/null 2>&1 || true
  conflict_issue || echo "conflict issue failed" >&2
  notify_bark || true
  exit 1
fi

echo "merged $tag"

if [[ "$do_push" -eq 1 ]]; then
  git push origin "HEAD:refs/heads/${PERSONAL_BRANCH}"
  echo "pushed $PERSONAL_BRANCH"
fi
