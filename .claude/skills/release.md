---
name: release
description: Cut a new release of itunes-playlist-viewer. Use when the user says "release", "新しいバージョンを切る", "新しいリリースを作る", "v0.x.y をリリース", "リリースして", or anything that maps to "bump the version + write changelog + tag".
---

# Release Skill

## Goal
Cut a clean release: write changelog → bump version everywhere → commit → tag → push.
The GitHub Actions workflow (`build-windows.yml`) will pick the tag up and attach `.exe` / `.msi` / NSIS installer to the GitHub Release.

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

3. Run `cargo update -p itunes-playlist-viewer --offline` is NOT needed; `cargo` picks up the new version from `Cargo.toml` automatically. But the lockfile changes — run `nix develop --command bash -c "cd src-tauri && cargo check"` once to update `Cargo.lock` so the lockfile in the repo matches the new version.

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
- Files changed (`package.json`, `Cargo.toml`, `tauri.conf.json`, `Cargo.lock`, `CHANGELOG.md`)
- Proposed CHANGELOG section
- Proposed commit message
- Proposed tag name

**Get explicit user confirmation before committing or pushing.**

After approval:

```
git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/Cargo.lock CHANGELOG.md
git commit -m "chore(release): vX.Y.Z

<paste the CHANGELOG section body here>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"

git tag -a vX.Y.Z -m "vX.Y.Z

<paste the CHANGELOG section body here>"

git push origin main
git push origin vX.Y.Z
```

## Watch the release build

After the tag push, the `build-windows.yml` workflow will start and, on success, create a GitHub Release with the `.exe` / `.msi` / NSIS installer attached.

```
gh run watch --repo tainakanchu/itunes-playlist-viewer
gh release view vX.Y.Z --repo tainakanchu/itunes-playlist-viewer
```

Report the release URL back to the user.

## Failure recovery

- **Tag pushed but build failed**: do NOT delete the tag silently. Tell the user, share the failure log, and let them decide whether to delete the tag (`git push origin :vX.Y.Z`) or fix-forward with a patch release.
- **Forgot to bump one file**: bump it, commit a fix-up, retag (`git tag -d vX.Y.Z && git push origin :vX.Y.Z && git tag -a vX.Y.Z ...`). Only do this if no release was published yet.

## Conventions

- Tag format: `vX.Y.Z` (lowercase `v`).
- Date format in CHANGELOG: `YYYY-MM-DD` in UTC.
- Commit message subject: `chore(release): vX.Y.Z`.
- Never skip the changelog; if there's truly nothing user-visible, the version probably shouldn't be bumped.
