#!/usr/bin/env bash
#
# Push this tool to its own standalone GitHub repository (repo root).
#
# Usage:
#   bash make-standalone.sh https://github.com/<you>/<repo>.git
#
# The target repo must ALREADY EXIST and be EMPTY (GitHub cannot be pushed
# into a non-existent repo). Create it first:  https://github.com/new
#   → name it, select PRIVATE, do NOT add README/.gitignore/license.
#
set -euo pipefail

REMOTE="${1:?Usage: bash make-standalone.sh https://github.com/<you>/<repo>.git}"
SRC="$(cd "$(dirname "$0")" && pwd)"
STAGE="$(mktemp -d)/tx-broadcaster"

mkdir -p "$STAGE"
cp -r "$SRC/src" "$SRC/scripts" "$SRC/inputs" "$SRC/package.json" \
      "$SRC/package-lock.json" "$SRC/.env.example" "$SRC/.gitignore" \
      "$SRC/README.md" "$STAGE/"

cd "$STAGE"
git init -b main -q
git add -A
git -c user.name="${GIT_AUTHOR_NAME:-tx-broadcaster}" \
    -c user.email="${GIT_AUTHOR_EMAIL:-noreply@users.noreply.github.com}" \
    commit -q -m "tx-broadcaster: sign & broadcast EVM transactions from DATA, ABI or HEX inputs"
git remote add origin "$REMOTE"

echo "→ pushing to $REMOTE (main)…"
if ! git push -q origin main 2>&1; then
  echo
  echo "✘ Push failed. Most likely the repo doesn't exist yet."
  echo "  1. Open https://github.com/new"
  echo "  2. Name: $REMOTE" 
  echo "  3. Select PRIVATE, leave every checkbox UNchecked, create."
  echo "  4. Re-run: bash make-standalone.sh $REMOTE"
  exit 1
fi

echo "✔ Done. Verify it:  gh repo view ${REMOTE#*github.com/} --json isPrivate,url"
