---
name: release
description: Cut a Runbooks release - uptick package.json, create the draft GitHub release pinned to a commit, run the Build and Release workflow, and write the release notes with recordings and screenshots while it builds. Use when asked to release, cut, ship or uptick a version, or to write release notes.
---

# Releasing Runbooks

A release is a draft GitHub release that pins one commit, plus a manually run workflow (`.github/workflows/release.yml`) that builds that commit and attaches the installers to the draft. A maintainer publishes the draft by hand; publishing creates the tag.

Work through the steps in order. Steps 1 to 4 are quick; step 5 fills the roughly 30 minutes the build takes.

**Ask before each outward-facing action**: opening the uptick PR, creating the draft, starting the workflow, and writing notes into the draft. Never publish the release, and never merge the uptick PR. Those are the maintainer's.

Throughout, `X.Y.Z` is the new version and `vX.Y.Z` its tag.

## 1. Uptick the version in package.json

Pick the version with the user if they didn't give one: a patch for fixes only, a minor otherwise.

1. Fetch, then branch `chore/uptick-X.Y.Z` from `origin/main` in a fresh worktree. Don't switch the main checkout's branch.
2. Change `"version"` in `package.json`. That is the whole commit: `bun.lock` doesn't record the version.
3. Commit as `chore: uptick to X.Y.Z`, push, and open a PR with the same title. In the body, list the PRs merged since the last release (`git log --oneline vPREV..origin/main`).
4. If Electron's major version changed since the last release, check that `MINIMUM_DARWIN_VERSION` in `.github/scripts/release/merge-mac-latest.mjs` still matches Electron's macOS floor (`LSMinimumSystemVersion` in `Electron.app/Contents/Info.plist`; macOS 13 = Darwin 22, 14 = 23, 15 = 24, 26 = 25). Raise it in its own PR before releasing if not.
5. Wait for CI and for the maintainer to merge.

## 2. Create the draft release

Create it only once the uptick is on `main`.

```bash
gh release create vX.Y.Z --draft --title vX.Y.Z --target <full 40-char SHA> --notes ""
```

The title is the tag. The notes come in step 5.

## 3. Point it at the commit to build

The draft's target is what gets built, so it must be a **full commit SHA**. The workflow rejects a branch name or a short SHA, so that no later commit can slip into the release.

- The usual target is the uptick's merge commit: `git rev-parse origin/main` right after it merges. Confirm the SHA with the user if `main` has moved past it.
- Check that the commit carries the new version. The workflow doesn't, and the installers and auto-update manifests take their version from it:

  ```bash
  git show <SHA>:package.json | grep '"version"'
  gh release view vX.Y.Z --json targetCommitish,isDraft
  ```

- To retarget an existing draft: `gh release edit vX.Y.Z --target <SHA>`.

## 4. Start the build

```bash
gh workflow run release.yml -f version=vX.Y.Z
sleep 5 && gh run list --workflow release.yml --limit 1 --json databaseId,status,url
```

The input is the tag with its `v`. The workflow file itself comes from `main`; the code it builds comes from the draft's target.

`validate` checks the draft, the semver tag and the SHA target. `build-macos`, `build-linux` and `build-windows` then run in parallel, and `upload-assets` attaches the results. Watch it in the background (`gh run watch <id> --exit-status`) and go on to step 5.

When it finishes, the draft should hold 11 assets:

- `Runbooks-X.Y.Z-mac-arm64.dmg` and `.zip`, `Runbooks-X.Y.Z-mac-x64.dmg` and `.zip`
- `Runbooks-X.Y.Z-linux-x86_64.AppImage`, `Runbooks-X.Y.Z-linux-amd64.deb`
- `Runbooks-X.Y.Z-win-x64.exe`
- `latest-mac.yml`, `latest-linux.yml`, `latest.yml`, `SHA256SUMS`

```bash
gh release view vX.Y.Z --json assets --jq '.assets[].name'
```

If a job fails, read its log (`gh run view <id> --log-failed`) and report it. A re-run is safe: uploads overwrite. If the fix needs a new commit, retarget the draft (step 3) and run the workflow again.

## 5. Write the release notes while it builds

### Gather the changes

```bash
git log --oneline vPREV..<SHA>
gh api repos/gruntwork-io/runbooks/releases/generate-notes \
  -f tag_name=vX.Y.Z -f target_commitish=<SHA> -f previous_tag_name=vPREV --jq .body
```

The second command gives GitHub's PR list, which goes at the bottom of the notes. Read each user-facing PR's description and diff rather than trusting its title. A commit pushed straight to `main` has no PR, so the generated list misses it: add it by hand.

### Format

Match the last few releases (`gh release view vPREV --json body --jq .body`). Keep the notes succinct, and write for someone who uses or authors runbooks, not for a contributor.

````markdown
## 🛠️ Behavior Changes        (only if something existing now acts differently; goes first)

## ✨ New Features

### Feature named for what the user can now do

```mdx
<the smallest snippet that shows it>
```

One short paragraph: what it does, where it works, the limits worth knowing. [Docs](https://runbooks.gruntwork.io/...) (#123)

📎 feature-name.mp4

### Also new

- One line for each small feature. (#124)

## 🐛 Fixes

- One line for each fix, saying what now works. (#125)

<details>
<summary>All changes</summary>

<the generated PR list>

</details>

**Full Changelog**: https://github.com/gruntwork-io/runbooks/compare/vPREV...vX.Y.Z
````

- Leave out sections with nothing in them. Dependency bumps, tests, CI and refactors appear only under "All changes".
- Check each Docs link against `docs/src/content/docs/` at the release commit, including the anchor.
- Put several PRs in one entry when they make one feature: `(#394, #395)`. GitHub doesn't link a range such as `#362–#365`, so list each number.
- If a feature needs the new version to open a runbook that uses it, say so.

### Media

Every GUI change a reader would want to see gets media:

| Change | Media |
| --- | --- |
| The feature is an interaction: several steps, state that changes over time, something that folds, moves or updates as you type | A recording (`.mp4`) |
| The change shows in one frame: a new dialog, field, label, layout or style | A screenshot (`.png`) |
| No visible change, or a fix whose "after" looks like any other screen | None |

Capture from a build of the release commit, never from a dev build with unreleased changes. [media.md](media.md) has the capture method and its pitfalls: read it before recording.

Save the files under one directory in the scratchpad, named after the feature (`auto-collapse.mp4`, `custom-ca.png`). Watch every recording and look at every screenshot before handing them over: check that nothing personal shows (home paths, account names, tokens) and that a person could follow each action.

### Hand over

GitHub has no API for the inline media a release body uses, so the maintainer drags the files in. `gh release upload` is wrong for this: it would list them among the downloads.

1. Write the notes to a file in the scratchpad, with a `📎 <file name>` line where each media file goes.
2. Show the user the notes and the full paths of the media files.
3. Once they approve, set the notes on the draft: `gh release edit vX.Y.Z --notes-file <file>`. Check afterwards that it is still a draft with the same target.
4. Tell the user what is left for them: drag each file onto its 📎 line in the release editor, confirm the 11 assets are attached, and publish.

## After publishing

Nothing in the repo changes. Installed apps pick the release up from `latest*.yml` through auto-update. If fixes are needed after the tag exists, they ship as a patch release: start again from step 1.
