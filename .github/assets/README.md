# GitHub Assets

This directory contains configuration files used in the release and CI/CD workflows.

## Files

### `release-assets-config.json`

Configuration file that defines the release asset matrix for the runbooks binary. It specifies:

- **Platforms**: The target OS/architecture combinations, including which ones require code signing.

- **Archive Formats**: The compression formats used for distribution (e.g. `zip`, `tar.gz`)

- **Additional Files**: Extra files included in releases (e.g., `SHA256SUMS` for checksum verification)

> **Note:** As of Dec 1, 20225, this config is only consumed by the macOS signing workflow (`sign-macos.yml`) to determine which binaries need signing. The build matrix in `release.yml` is maintained separately.

### `.gon_xxx.hcl`

[Gon](https://github.com/mitchellh/gon) configuration file for signing and notarizing the **macOS ARM64** (Apple Silicon) binary. Gon is a tool that automates the Apple code signing and notarization process required for distributing macOS binaries outside the App Store.

## Related

The [lib-release-config.sh](/.github/scripts/release/lib-release-config.sh) script consumes the `release-assets-config.json` file.