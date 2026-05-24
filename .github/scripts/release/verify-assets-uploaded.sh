#!/usr/bin/env bash

set -euo pipefail

# Script to verify every local artifact made it onto the GitHub release,
# retrying any upload that the best-effort upload pass dropped.
# Usage: verify-assets-uploaded.sh <artifacts-directory>
# Environment variables:
#   VERSION: The version/tag to verify
#   GH_TOKEN: GitHub token for authentication
#   CLOBBER: Set to 'true' to overwrite existing assets during retry (default: false)

readonly MAX_RETRIES=10

function main {
	local -r bin_dir="${1:-artifacts}"
	local -r clobber="${CLOBBER:-false}"

	: "${VERSION:?ERROR: VERSION is a required environment variable}"
	: "${GH_TOKEN:?ERROR: GH_TOKEN is a required environment variable}"

	if [[ ! -d "$bin_dir" ]]; then
		echo "ERROR: Directory $bin_dir does not exist" >&2
		exit 1
	fi

	local clobber_flag=""
	if [[ "$clobber" == "true" ]]; then
		clobber_flag="--clobber"
	fi

	echo "Verifying all assets are accessible..."

	# Names of assets currently attached to the release.
	local assets
	assets=$(gh release view "$VERSION" --json 'assets' --jq '.assets[].name')
	echo "Found $(grep -c . <<<"$assets" || true) assets in release"

	# Expected files = every regular file we have locally.
	local -a expected_files=()
	local f
	for f in "$bin_dir"/*; do
		[[ -f "$f" ]] && expected_files+=("$(basename "$f")")
	done

	for expected_file in "${expected_files[@]}"; do
		echo "Checking $expected_file..."

		if grep -qx "$expected_file" <<<"$assets"; then
			echo "$expected_file present"
			continue
		fi

		echo "$expected_file not found in release, uploading..."
		local i
		for ((i = 0; i < MAX_RETRIES; i++)); do
			if gh release upload "$VERSION" "$bin_dir/$expected_file" $clobber_flag; then
				echo "Uploaded $expected_file"
				break
			fi
			echo "Upload attempt $((i + 1))/$MAX_RETRIES failed" >&2
			sleep 5
		done

		if ((i == MAX_RETRIES)); then
			echo "Failed to upload $expected_file after $MAX_RETRIES retries" >&2
			exit 1
		fi
	done

	echo ""
	echo "All required assets verified! (${#expected_files[@]} files)"

	return 0
}

main "$@"
