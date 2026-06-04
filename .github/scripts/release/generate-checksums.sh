#!/usr/bin/env bash

set -euo pipefail

# Script to generate SHA256 checksums for all release files.
# Usage: generate-checksums.sh <artifacts-directory>

function main {
	local -r bin_dir="${1:-artifacts}"

	if [[ ! -d "$bin_dir" ]]; then
		echo "ERROR: Directory $bin_dir does not exist" >&2
		exit 1
	fi

	# Use pushd/popd to avoid side effects on caller's working directory
	pushd "$bin_dir" >/dev/null || return 1

	# Checksum the user-facing installers/archives. The latest*.yml update
	# manifests are uploaded but deliberately excluded here (electron-updater
	# verifies them via its own sha512). *.blockmap delta files are not uploaded
	# to the release at all (omitted at the upload-artifact step in release.yml).
	shopt -s nullglob
	local -a files=(*.dmg *.zip *.AppImage *.deb *.exe)
	shopt -u nullglob

	if [[ ${#files[@]} -eq 0 ]]; then
		echo "ERROR: No release artifacts found to checksum in $bin_dir" >&2
		popd >/dev/null || true
		exit 1
	fi

	sha256sum "${files[@]}" >SHA256SUMS

	echo "SHA256SUMS generated:"
	cat SHA256SUMS

	echo ""
	echo "Total files with checksums: $(wc -l <SHA256SUMS)"

	popd >/dev/null || return 1

	return 0
}

main "$@"
