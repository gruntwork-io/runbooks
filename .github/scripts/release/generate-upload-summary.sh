#!/usr/bin/env bash

set -euo pipefail

# Script to generate a GitHub Actions step summary for release uploads.
# Usage: generate-upload-summary.sh <artifacts-directory>
# Environment variables:
#   VERSION: Release version/tag
#   RELEASE_ID: GitHub release ID
#   IS_DRAFT: Whether the release is a draft
#   GITHUB_STEP_SUMMARY: Path to GitHub step summary file

function main {
	local -r bin_dir="${1:-artifacts}"

	: "${VERSION:?ERROR: VERSION is a required environment variable}"
	: "${GITHUB_STEP_SUMMARY:?ERROR: GITHUB_STEP_SUMMARY is a required environment variable}"

	local release_id="${RELEASE_ID:-unknown}"
	local is_draft="${IS_DRAFT:-unknown}"

	{
		cat <<EOF
## Release Asset Upload Summary

**Version**: $VERSION
**Release ID**: $release_id
**Was Draft**: $is_draft

### Assets Uploaded

| File | SHA256 |
|------|--------|
EOF

		if [[ -f "$bin_dir/SHA256SUMS" ]]; then
			# SHA256SUMS lines are "<hash>  <filename>"; render as a table.
			while read -r hash file; do
				# shellcheck disable=SC2016  # %s are printf placeholders, not shell vars
				[[ -n "$file" ]] && printf '| %s | `%s` |\n' "$file" "$hash"
			done <"$bin_dir/SHA256SUMS"
		fi

		cat <<EOF

The draft release **$VERSION** now has its binaries attached. Publish it from the
GitHub Releases page when you are ready to ship.
EOF
	} >>"$GITHUB_STEP_SUMMARY"

	echo "Upload summary generated successfully"

	return 0
}

main "$@"
