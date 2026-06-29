# Pinned version of gruntwork-io/boilerplate to bundle.
# Bump and re-run `just fetch-boilerplate` to pick up a new release.
boilerplate_version := "v0.16.0"

# Default recipe: show available commands
default:
    @just --list

# --- Development ---

# Start Electron app in dev mode with HMR
dev:
    mise x node -- npx electron-vite dev

# Start Electron app pointing at a specific runbook
dev-runbook path="testdata/my-first-runbook":
    mise x node -- npx electron-vite dev -- --runbook {{path}}

# --- Build ---

# Build the Electron app (main + preload + renderer)
build:
    mise x node -- npx electron-vite build

# Compile the test CLI as a standalone binary (no Node.js required)
compile-test-cli:
    #!/usr/bin/env bash
    set -euo pipefail
    mise x bun -- bun build --compile --outfile resources/bin/runbooks-test cli/index.ts
    # Bun's --compile embeds a malformed LC_CODE_SIGNATURE placeholder on macOS,
    # which breaks electron-builder's hardened-runtime signing
    # ("invalid or unsupported format for signature"). Strip it so downstream
    # codesign --force can overwrite cleanly. See oven-sh/bun#7208.
    if [[ "$(uname)" == "Darwin" ]]; then
        codesign --remove-signature resources/bin/runbooks-test 2>/dev/null || true
    fi

# Fetch the boilerplate CLI + WASM artifacts from gruntwork-io/boilerplate
# release assets, pinned to {{boilerplate_version}}. Lands them under
# resources/bin and resources/wasm so electron-builder.extraResources picks
# them up and the main process can point BOILERPLATE_BIN /
# BOILERPLATE_WASM_DIR at the bundled copies.
#
# Defaults to the host os/arch (dev / local-packaging case). CI cross-packages
# by passing explicit target os+arch — e.g. on an arm64 macOS runner building
# the x64 .app, `just fetch-boilerplate darwin amd64`. Valid os values:
# darwin, linux, windows. Valid arch values: arm64, amd64. The WASM blob and
# wasm_exec.js are architecture-independent. Idempotent: the marker file
# encodes version+os+arch, so re-running with a different target re-fetches.
fetch-boilerplate target_os="" target_arch="":
    #!/usr/bin/env bash
    set -euo pipefail

    VERSION="{{boilerplate_version}}"
    MARKER="resources/.boilerplate-version"

    os="{{target_os}}"
    arch="{{target_arch}}"

    if [ -z "$os" ]; then
        case "$(uname -s)" in
            Darwin)               os="darwin"  ;;
            Linux)                os="linux"   ;;
            MINGW*|MSYS*|CYGWIN*) os="windows" ;;
            *) echo "[fetch-boilerplate] Unsupported OS: $(uname -s)" >&2; exit 1 ;;
        esac
    fi
    if [ -z "$arch" ]; then
        case "$(uname -m)" in
            arm64|aarch64) arch="arm64" ;;
            x86_64|amd64)  arch="amd64" ;;
            *) echo "[fetch-boilerplate] Unsupported arch: $(uname -m)" >&2; exit 1 ;;
        esac
    fi

    # Windows boilerplate ships as .exe and the main process looks for
    # boilerplate.exe on win32 (electron/main/index.ts).
    if [ "$os" = "windows" ]; then
        bin_name="boilerplate.exe"
        asset_suffix=".exe"
    else
        bin_name="boilerplate"
        asset_suffix=""
    fi

    target_id="$VERSION $os $arch"

    if [ -f "$MARKER" ] && [ "$(cat "$MARKER")" = "$target_id" ] \
        && [ -f "resources/bin/$bin_name" ] \
        && [ -f "resources/wasm/boilerplate-full.wasm.br" ] \
        && [ -f "resources/wasm/wasm_exec.js" ]; then
        echo "[fetch-boilerplate] $target_id already present, skipping"
        exit 0
    fi

    base="https://github.com/gruntwork-io/boilerplate/releases/download/${VERSION}"

    mkdir -p resources/bin resources/wasm
    # Drop any stale alternate-target binary so the bundle never ends up with
    # both boilerplate (arm64) and boilerplate (amd64) side by side.
    rm -f resources/bin/boilerplate resources/bin/boilerplate.exe

    echo "[fetch-boilerplate] $VERSION CLI for ${os}_${arch}"
    curl -fL --retry 3 -o "resources/bin/$bin_name" "${base}/boilerplate_${os}_${arch}${asset_suffix}"
    if [ "$os" != "windows" ]; then
        chmod +x "resources/bin/$bin_name"
    fi

    echo "[fetch-boilerplate] $VERSION WASM blob (boilerplate-full.wasm.br)"
    curl -fL --retry 3 -o resources/wasm/boilerplate-full.wasm.br "${base}/boilerplate-full.wasm.br"

    echo "[fetch-boilerplate] $VERSION wasm_exec.js"
    curl -fL --retry 3 -o resources/wasm/wasm_exec.js "${base}/wasm_exec.js"

    echo "$target_id" > "$MARKER"
    echo "[fetch-boilerplate] Done"

# Package the Electron app for distribution
package: build compile-test-cli fetch-boilerplate
    mise x node -- npx electron-builder

# Package for local testing. electron-builder on this host has no Developer ID
# cert, and both `identity=null` and `CSC_IDENTITY_AUTO_DISCOVERY=false` make it
# skip signing entirely — leaving Electron Inc's Team ID on the framework and
# crashing at launch on macOS 14+/Sequoia. Workaround: build the unpacked .app
# only, manually ad-hoc sign it leaf-first, then repackage the DMG ourselves
# so the installer actually contains the signed bundle.
package-local: build compile-test-cli fetch-boilerplate
    #!/usr/bin/env bash
    set -euo pipefail

    # 1. Build unpacked .app bundles (no DMG/zip yet).
    CSC_IDENTITY_AUTO_DISCOVERY=false mise x node -- npx electron-builder --mac --dir

    if [[ "$(uname)" != "Darwin" ]]; then
        exit 0
    fi

    ENTITLEMENTS="build/entitlements.mac.plist"
    INHERIT_ENTITLEMENTS="build/entitlements.mac.inherit.plist"

    # Sign every Mach-O file directly inside a directory (non-recursive).
    sign_mach_o_files_in() {
        local dir="$1"
        [ -d "$dir" ] || return 0
        find "$dir" -type f -print0 | while IFS= read -r -d '' f; do
            if file -b "$f" | grep -q "Mach-O"; then
                codesign --force --sign - --timestamp=none --options runtime "$f"
            fi
        done
    }

    for app in out/mac*/Runbooks.app; do
        [ -d "$app" ] || continue
        echo "Ad-hoc signing $app"
        frameworks_dir="$app/Contents/Frameworks"

        # 2a. Loose dylibs / .node addons directly under Frameworks/
        for f in "$frameworks_dir"/*.dylib "$frameworks_dir"/*.node; do
            [ -f "$f" ] && codesign --force --sign - --timestamp=none --options runtime "$f"
        done

        # 2b. Framework bundles: leaves (Helpers/, Libraries/) → main binary → bundle.
        for fw in "$frameworks_dir"/*.framework; do
            [ -d "$fw" ] || continue
            versions="$fw/Versions/A"
            fw_name="$(basename "$fw" .framework)"

            sign_mach_o_files_in "$versions/Helpers"
            sign_mach_o_files_in "$versions/Libraries"

            if [ -f "$versions/$fw_name" ]; then
                codesign --force --sign - --timestamp=none --options runtime "$versions/$fw_name"
            fi
            codesign --force --sign - --timestamp=none --options runtime "$fw"
        done

        # 2c. Helper .app bundles.
        for helper in "$frameworks_dir"/*.app; do
            [ -d "$helper" ] || continue
            helper_name="$(basename "$helper" .app)"
            if [ -f "$helper/Contents/MacOS/$helper_name" ]; then
                codesign --force --sign - --timestamp=none --options runtime \
                    --entitlements "$INHERIT_ENTITLEMENTS" \
                    "$helper/Contents/MacOS/$helper_name"
            fi
            codesign --force --sign - --timestamp=none --options runtime \
                --entitlements "$INHERIT_ENTITLEMENTS" "$helper"
        done

        # 2d. Outer app bundle.
        codesign --force --sign - --timestamp=none --options runtime \
            --entitlements "$ENTITLEMENTS" "$app"

        echo "Verifying $app"
        codesign --verify --deep --strict --verbose=2 "$app"

        # 3. Build a DMG ourselves from the now-signed .app.
        arch_suffix="$(basename "$(dirname "$app")")"   # mac-arm64 | mac
        case "$arch_suffix" in
            mac-arm64) arch="arm64" ;;
            mac)       arch="x64"   ;;
            *)         arch="${arch_suffix#mac-}" ;;
        esac
        dmg_out="out/Runbooks-0.1.0-local-${arch}.dmg"
        rm -f "$dmg_out"

        staging="$(mktemp -d)"
        cp -R "$app" "$staging/"
        ln -s /Applications "$staging/Applications"
        hdiutil create -volname "Runbooks" -srcfolder "$staging" \
            -ov -format UDZO "$dmg_out" >/dev/null
        rm -rf "$staging"
        echo "Built $dmg_out"
    done

# Remove build artifacts
# Retries because macOS Finder can recreate .DS_Store between readdir and rmdir,
# causing "Directory not empty" on the first pass.
clean:
    #!/usr/bin/env bash
    set -u
    for i in 1 2 3; do
        rm -rf dist out resources/bin/runbooks-test resources/bin/runbooks-test.exe resources/bin/boilerplate resources/bin/boilerplate.exe resources/wasm resources/.boilerplate-version && exit 0
        sleep 0.3
    done
    exit 1

# --- Test ---

# Run all tests
test: test-unit test-e2e test-runbooks test-docs

# Run backend unit tests (Bun test runner)
# test/** is excluded: test/integration/ is the Node-environment Vitest suite
# (Bun 1.3.x has no tls.setDefaultCACertificates) — see `just test-integration`.
test-backend:
    mise x bun -- bun test --path-ignore-patterns='web/**' --path-ignore-patterns='docs/**' --path-ignore-patterns='node_modules/**' --path-ignore-patterns='**/e2e/**' --path-ignore-patterns='test/**'

# Run web unit tests (Vitest — jsdom)
test-web:
    cd web && mise x bun -- bun install --frozen-lockfile && mise x bun -- bun run vitest run

# Run TLS integration tests (Vitest — Node environment; needs APIs Bun lacks)
test-integration:
    mise x node -- npx vitest run --config vitest.integration.config.ts

# Run all unit tests
test-unit: test-backend test-web test-integration

# Run Playwright E2E tests (requires build)
test-e2e: build fetch-boilerplate
    mise x bun -- bunx playwright test --config web/playwright.config.ts
    mise x bun -- bunx playwright test --config electron/e2e/playwright.config.ts --workers=1

# Run Playwright E2E tests without rebuilding (CI calls `just build` separately)
test-e2e-run: fetch-boilerplate
    mise x bun -- bunx playwright test --config web/playwright.config.ts
    mise x bun -- bunx playwright test --config electron/e2e/playwright.config.ts --workers=1

# Run automated runbook tests via compiled CLI
test-runbooks: build compile-test-cli
    resources/bin/runbooks-test test testdata/...

# Run docs tests (spellcheck + link check)
test-docs:
    cd docs && mise x bun -- bun install && mise x bun -- bun run spellcheck && mise x bun -- bun run build && mise x bun -- bun run linkcheck

# --- Code Quality ---

# Lint with oxlint
lint:
    mise x bun -- bunx oxlint . --ignore-pattern '**/*.astro' --ignore-pattern 'testdata/**'

# Format with oxfmt (when available, placeholder for now)
fmt:
    @echo "oxfmt not yet available — skipping"

# Check formatting without writing
fmt-check:
    @echo "oxfmt not yet available — skipping"

# Type check with TypeScript compiler
typecheck:
    mise x bun -- bunx tsc --noEmit

# Run all checks (lint + format check + typecheck)
check: lint fmt-check typecheck
