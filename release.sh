#!/usr/bin/env bash
set -euo pipefail

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Not inside a git repository." >&2
  exit 1
fi

MODULE_JSON="module.json"
if [[ ! -f "$MODULE_JSON" ]]; then
  echo "module.json not found in $(pwd)." >&2
  exit 1
fi

if command -v jq >/dev/null 2>&1; then
  CURRENT_VERSION=$(jq -r ".version" "$MODULE_JSON")
else
  CURRENT_VERSION=$(node -pe "require('./$MODULE_JSON').version")
fi

if [[ -z "$CURRENT_VERSION" || "$CURRENT_VERSION" == "null" ]]; then
  echo "Could not read version from $MODULE_JSON." >&2
  exit 1
fi

# Determine bump type (default patch)
BUMP_TYPE="patch"
EXPLICIT_VERSION=""
if [[ $# -ge 1 ]]; then
  case "$1" in
    major|minor|patch) BUMP_TYPE="$1" ;;
    *) EXPLICIT_VERSION="$1" ;;
  esac
fi

if [[ -n "$EXPLICIT_VERSION" ]]; then
  # Full explicit version like 0.2.0
  NEXT_VERSION="$EXPLICIT_VERSION"
else
  IFS='.' read -r MAJ MIN PAT <<< "$CURRENT_VERSION"
  case "$BUMP_TYPE" in
    major) MAJ=$((MAJ + 1)); MIN=0; PAT=0 ;;
    minor) MIN=$((MIN + 1)); PAT=0 ;;
    patch) PAT=$((PAT + 1)) ;;
  esac
  NEXT_VERSION="$MAJ.$MIN.$PAT"
fi

echo "Current version: $CURRENT_VERSION"
echo "Next version:    $NEXT_VERSION"

read -r -p "Commit message: " COMMIT_MSG
if [[ -z "$COMMIT_MSG" ]]; then
  echo "Commit message required." >&2
  exit 1
fi

TAG="v$NEXT_VERSION"
ORIG_DOWNLOAD_URL="$(jq -r '.download // empty' "$MODULE_JSON" 2>/dev/null || true)"
if [[ -z "$ORIG_DOWNLOAD_URL" ]]; then
  echo "No download URL found in $MODULE_JSON." >&2
  exit 1
fi
DOWNLOAD_URL="$(printf '%s\n' "$ORIG_DOWNLOAD_URL" | sed -E "s#/v[0-9]+\.[0-9]+\.[0-9]+/#/${TAG}/#")"
if [[ "$DOWNLOAD_URL" == "$ORIG_DOWNLOAD_URL" ]]; then
  echo 'Could not find a version to replace (v<X.Y.Z>) in the download URL: '"$ORIG_DOWNLOAD_URL" >&2
  exit 1
fi

# Update version and download URL in module.json
if command -v jq >/dev/null 2>&1; then
  jq ".version = \"$NEXT_VERSION\" | .download = \"$DOWNLOAD_URL\"" "$MODULE_JSON" > "$MODULE_JSON.tmp" && mv "$MODULE_JSON.tmp" "$MODULE_JSON"
else
  node -e "
    const fs = require('fs');
    const m = JSON.parse(fs.readFileSync('$MODULE_JSON', 'utf8'));
    m.version = '$NEXT_VERSION';
    m.download = '$DOWNLOAD_URL';
    fs.writeFileSync('$MODULE_JSON', JSON.stringify(m, null, 2) + '\n');
  "
fi

git add "$MODULE_JSON"
git commit -m "$COMMIT_MSG"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Tag $TAG already exists; skipping tag." >&2
else
  git tag "$TAG"
  echo "Created tag $TAG"
fi

echo "Done. Push with: git push && git push --tags"
