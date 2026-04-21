#!/usr/bin/env bash
set -euo pipefail

cd "$REPO_FILES"

# Remove default files that GitHub generates when creating a repo.
# create-next-app refuses to run in a directory with conflicting files.
rm -f README.md LICENSE .gitignore .gitattributes

ARGS=(--yes --app --src-dir --use-bun --import-alias "{{ .inputs.ImportAlias }}")

{{ if eq .inputs.Language "JavaScript" -}}
ARGS+=(--javascript)
{{ else -}}
ARGS+=(--typescript)
{{ end -}}

{{ if eq .inputs.UseTailwind "Yes" -}}
ARGS+=(--tailwind)
{{ end -}}

{{ if eq .inputs.Bundler "Webpack" -}}
ARGS+=(--webpack)
{{ else -}}
ARGS+=(--turbopack)
{{ end -}}

bunx --bun create-next-app@latest . "${ARGS[@]}"

# Undo the automatic initial commit so all changes remain uncommitted.
# This lets the GitHubPullRequest block capture everything in one PR.
git reset HEAD~1 2>/dev/null || true
