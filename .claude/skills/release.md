---
name: release
description: Cut a new release of crateforge. Use when the user says "release", "新しいバージョンを切る", "新しいリリースを作る", "v0.x.y をリリース", "リリースして", or anything that maps to "bump the version + write changelog + tag".
---

# Release Skill

## Goal
Cut a clean release: write changelog → bump version everywhere → commit → tag → push.
The GitHub Actions workflow (`release.yml`) picks the tag up, builds every platform
(Windows / macOS / Linux) in parallel, and then a dedicated `release` job — which `needs` all
build jobs — publishes a **single** GitHub Release with all assets attached at once
(Windows `.exe` / portable zip / `.msi` / NSIS, macOS `.dmg`, Linux `.AppImage` / `.deb`).

The same tag also builds the **Android (Android Auto) APK** in GitHub Actions (`build-android`: `expo prebuild` + Gradle
`assembleRelease`, signed with the repo Secrets — EAS Build is **not** used for Android). A separate `release-android` job attaches
`crateforge-android-<version>.apk` + `.apk.sha256` to the same Release **only after both the desktop `release` job and the APK build succeed**,
and removes the APK assets again if that step fails. An APK failure never blocks or alters the desktop Release.

The release is created **only after the Windows build succeeds and all builds have finished**,
so the GitHub Release never appears before the Windows artifacts exist — the in-app updater
(Windows-only) will never see a version it cannot download.

## Pre-flight checks

Before doing anything, run these in parallel and surface the results:

```
git status --short                 # Working tree must be clean (or only contain changes you want in this release)
git rev-parse --abbrev-ref HEAD    # Must be on `main`
git log --oneline -20              # See what's been merged since the last tag
git tag --sort=-version:refname | head -5   # Latest tags
```

- If the working tree is dirty with stuff that's NOT part of this release: stop and ask the user to commit / stash first.
- If we're not on `main`: stop and confirm with the user.

## Android APK prerequisites (check before pushing the tag)

```
gh secret list | grep CRATEFORGE_ANDROID                  # KEYSTORE_BASE64 / KEYSTORE_PASSWORD / KEY_ALIAS / KEY_PASSWORD
gh variable list | grep CRATEFORGE_ANDROID_CERT_SHA256    # expected signing-cert SHA-256 (warn-only in CI when unset)
```

If missing, point the user at the "メンテナ向け" section of `clients/apps/mobile/README.md` (it covers the one-time EAS keystore export).
Never read, print, or commit key material. The APK `versionName` is the root `package.json` version; `versionCode` is derived from it
(`100000000 + major*1000000 + minor*10000 + patch*100 + (pre-release N | 99)`; minor/patch must be <= 99, pre-release number <= 98,
and a pre-release tag must end in a number, e.g. `v0.16.0-alpha.1`).

## Version bump

1. **Decide the next version** from the current latest tag (`v0.X.Y`). Default rule:
   - Bug fixes only → bump patch (`0.0.X`)
   - New backward-compatible features → bump minor (`0.X.0`)
   - Breaking change / major UI redesign → bump major (`X.0.0`)
   - If the user gave an explicit version (e.g. "v0.2.0 で"), use that.
   - Otherwise, propose a version derived from the commit log and ASK the user before continuing.

2. **Update three files in lockstep** (they must agree, or builds break):
   - `package.json` → `version`
   - `src-tauri/Cargo.toml` → `[package] version`
   - `src-tauri/tauri.conf.json` → `version`

3. Run `cargo update -p crateforge --offline` is NOT needed; `cargo` picks up the new version from `Cargo.toml` automatically. But the lockfile changes — run `nix develop --command bash -c "cd src-tauri && cargo check"` once to update `Cargo.lock` so the lockfile in the repo matches the new version.

4. **dj-curator プラグインが前回タグ以降に変更されていれば、その version も上げる**
   （アプリ本体とは独立した SemVer。プラグインは marketplace から個別配信されるため、機能追加なら minor、修正なら patch）:
   - `plugins/dj-curator/.claude-plugin/plugin.json` → `version`
   - `.claude-plugin/marketplace.json` → 該当 plugin の `version`（plugin.json と一致させる）

   変更有無は `git diff <previous-tag>..HEAD --stat -- plugins .claude-plugin` で確認する。

## CHANGELOG

If `CHANGELOG.md` does not exist, create it with a "Keep a Changelog" header.

Add a new section at the top:

```markdown
## [vX.Y.Z] - YYYY-MM-DD

### Added
- ...

### Changed
- ...

### Fixed
- ...
```

Populate from the commit log between the previous tag and `HEAD`:

```
git log <previous-tag>..HEAD --pretty=format:'%h %s'
```

Group commits by their conventional-commit-style prefix when present:
- `feat:` / `Add` → **Added**
- `fix:` / `Fix` → **Fixed**
- `refactor:` / `Change` / `Update` → **Changed**
- `docs:` → **Docs**
- `ci:` / `chore:` → omit (unless user-visible)

Keep entries to 1 line each, user-visible language. Drop internal-only commits.

## Commit + tag + push

Show the user a summary of:
- New version
- Files changed (`package.json`, `Cargo.toml`, `tauri.conf.json`, `Cargo.lock`, `CHANGELOG.md`; plus `plugin.json` / `marketplace.json` if the dj-curator plugin changed)
- Proposed CHANGELOG section
- Proposed commit message
- Proposed tag name

**Get explicit user confirmation before committing or pushing.**

After approval:

```
git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/Cargo.lock CHANGELOG.md
# プラグインを上げた場合は一緒に:
#   git add plugins/dj-curator/.claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore(release): vX.Y.Z

<paste the CHANGELOG section body here>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"

git tag -a vX.Y.Z -m "vX.Y.Z

<paste the CHANGELOG section body here>"

git push origin main
git push origin vX.Y.Z
```

## Watch the release build

After the tag push, the `release.yml` workflow starts and builds every platform.
Only once all build jobs finish (and the Windows build succeeded) does the final `release`
job create the GitHub Release with every platform's assets attached. This means the release
will not show up immediately — it intentionally waits for the builds so the in-app updater
never sees a release without the Windows exe / portable zip.

```
gh run watch --repo tainakanchu/crateforge
gh release view vX.Y.Z --repo tainakanchu/crateforge
```

The Android jobs run in parallel (`build-android`, then `release-android` once the desktop `release` job has also succeeded). The final asset list
should include `crateforge-android-<version>.apk` and `crateforge-android-<version>.apk.sha256`, and the release body gains an "Android" section
with the SHA-256 and signing-certificate SHA-256.

Report the release URL back to the user, then remind them to download the **real release asset**, verify its SHA-256 / signing certificate, and record
device / DHU results in `docs/android-auto/verification-checklist.md` (note unverified items in the release notes).

## Failure recovery

- **Only the APK failed** (desktop Release is already published): do not retag. Fix the cause (usually missing/incorrect Secrets), then use
  "Re-run failed jobs" on the workflow run (`gh run rerun <run-id> --failed`). `gh workflow run` only produces an artifact and does not attach to the Release.
  A failed `release-android` deletes the APK and `.sha256` assets it uploaded, so no half-published state remains.
- **Tag pushed but build failed**: do NOT delete the tag silently. Tell the user, share the failure log, and let them decide whether to delete the tag (`git push origin :vX.Y.Z`) or fix-forward with a patch release.
- **Forgot to bump one file**: bump it, commit a fix-up, retag (`git tag -d vX.Y.Z && git push origin :vX.Y.Z && git tag -a vX.Y.Z ...`). Only do this if no release was published yet.

## Conventions

- Tag format: `vX.Y.Z` (lowercase `v`).
- Date format in CHANGELOG: `YYYY-MM-DD` in UTC.
- Commit message subject: `chore(release): vX.Y.Z`.
- Android: do not use `eas build` for the mobile Android app (EAS versionCodes are lower than the GitHub APK's, so such a build could not update it).
  EAS stays in use for iOS builds, JS-only OTA (`ota:prod`, production channel, applied only when the fingerprint matches) and the TV app.
- Never skip the changelog; if there's truly nothing user-visible, the version probably shouldn't be bumped.
