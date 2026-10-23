#!/usr/bin/env bash
set -euo pipefail

# The block's env prop sets APP_LANGUAGE, USE_TAILWIND, BUNDLER and
# IMPORT_ALIAS from its inputs

cd "$REPO_FILES"

# Remove default files that GitHub generates when creating a repo.
# create-next-app refuses to run in a directory with conflicting files.
rm -f README.md LICENSE .gitignore .gitattributes

ARGS=(--yes --app --src-dir --use-bun --import-alias "$IMPORT_ALIAS")

if [ "$APP_LANGUAGE" = "JavaScript" ]; then
  ARGS+=(--javascript)
else
  ARGS+=(--typescript)
fi

if [ "$USE_TAILWIND" = "Yes" ]; then
  ARGS+=(--tailwind)
fi

if [ "$BUNDLER" = "Webpack" ]; then
  ARGS+=(--webpack)
else
  ARGS+=(--turbopack)
fi

bunx --bun create-next-app@latest . "${ARGS[@]}"

# Undo the automatic initial commit so all changes remain uncommitted.
# This lets the GitHubPullRequest block capture everything in one PR.
git reset HEAD~1 2>/dev/null || true
