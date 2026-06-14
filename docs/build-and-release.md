# Build & Release

## Bundling (electron-vite)

`npm run build` runs `typecheck` then `electron-vite build`, producing `out/`:

```
out/
├── main/main.js        # main process bundle
├── preload/preload.js  # CommonJS preload bridge
└── renderer/           # index.html + JS/CSS chunks (Calendar/Analytics lazy-split)
```

Because electron-vite bundles all runtime code (main, preload, renderer + their
npm deps) into `out/`, the packaged app ships only `out/` plus the Electron
runtime — `node_modules` is intentionally **not** shipped, keeping installers
small.

## Packaging (electron-builder)

Configured in `electron-builder.yml`. The app id is `com.opsalchemist.subby`,
the product name is `Subby`, the include list is `out/**` + `package.json`, and
the app is packed into an asar. Installers are emitted to `release/`.

| Platform | Targets | Artifact names |
| --- | --- | --- |
| macOS | `.dmg` + `.zip` (x64 + arm64) | `Subby-<version>-<arch>.dmg` / `.zip` |
| Windows | NSIS `.exe` (x64) | `Subby-Setup-<version>.exe` |
| Linux | `.AppImage` + `.deb` (x64) | `Subby-<version>-<arch>.AppImage` / `.deb` |

Local commands (build each on its own platform):

```bash
npm run dist:mac
npm run dist:win
npm run dist:linux
npm run pack       # unpacked app dir only (fast smoke test)
```

> **Icons:** until you add `build/icon.{icns,ico,png}`, electron-builder uses the
> default Electron icon (a warning, not an error). See `build/README.md`.
>
> **Signing:** beta builds are unsigned/un-notarized. macOS Gatekeeper and
> Windows SmartScreen will warn. Code signing is on the roadmap to stable.

## CI/CD (GitHub Actions)

Two workflows under `.github/workflows/`:

### `ci.yml` — verify

Triggered on push/PR to `main`. On `ubuntu-latest` it runs `npm ci`, `typecheck`,
`test`, and `build`. Uses npm caching and cancels superseded runs.

### `release.yml` — build & publish installers

Triggered by pushing a `v*` tag (or manual `workflow_dispatch` against a tag):

1. **`build`** matrix on `macos-latest` / `ubuntu-latest` / `windows-latest`:
   installs, typechecks, tests, builds, then runs
   `electron-builder --<platform> --publish never` (with
   `CSC_IDENTITY_AUTO_DISCOVERY=false` so unsigned beta builds don't fail looking
   for certs), and uploads the installers as artifacts.
2. **`release`**: downloads all artifacts and creates/updates a **draft** GitHub
   Release via `softprops/action-gh-release`, auto-flagging it as a pre-release
   when the tag contains a hyphen (semver pre-release), with generated notes.

The draft lets you review and publish manually.

## Cutting a release

1. Ensure `main` is green (CI passes).
2. Set `package.json` `version` to match the intended tag (without the leading
   `v`).
3. Tag and push:
   ```bash
   git tag v0.1.0-beta.1
   git push origin main --tags
   ```
4. The release workflow builds all three platforms and creates a draft
   pre-release with installers attached.
5. Review the draft on GitHub, edit notes, and **Publish**.

## Versioning

Semantic Versioning, with pre-release suffixes for channels: `alpha`, `beta`,
`rc`, then stable. Any tag containing a hyphen (e.g. `v0.1.0-beta.1`) is treated
as a pre-release. The git tag and `package.json` `version` must match.

The current build is the first public beta: `0.1.0-beta.1`.

> The full release plan — channels, the pre-release→stable checklist, known beta
> limitations, the roadmap (signing, notarization, auto-update), and required
> repository secrets — lives in [`../RELEASE.md`](../RELEASE.md).
