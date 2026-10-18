# Release Plan

This document describes how Subby is built, versioned, and released. Releases
are produced automatically by GitHub Actions and published as GitHub Releases
with installers for **macOS**, **Linux**, and **Windows**.

## Pipelines

| Workflow                      | Trigger                          | What it does                                                                 |
| ----------------------------- | -------------------------------- | ---------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`    | push / PR to `main`              | Typecheck, run the full test suite, and build the electron-vite bundle.      |
| `.github/workflows/release.yml` | push a `v*` tag (or manual run) | Build native installers on all 3 OSes and attach them to a **draft** Release.|

### Installer matrix

| Platform | Targets                  | Artifact names                          |
| -------- | ------------------------ | --------------------------------------- |
| macOS    | `.dmg`, `.zip` (x64+arm64) | `Subby-<version>-<arch>.dmg` / `.zip`   |
| Windows  | NSIS `.exe` (x64)        | `Subby-Setup-<version>.exe`             |
| Linux    | `.AppImage`, `.deb` (x64)| `Subby-<version>-<arch>.AppImage` / `.deb` |

Packaging is handled by **electron-builder** (`electron-builder.yml`). Because
electron-vite bundles all runtime code into `out/`, installers ship only the
bundled app + the Electron runtime (no `node_modules`).

## Versioning

We follow [Semantic Versioning](https://semver.org): `MAJOR.MINOR.PATCH`, with
optional pre-release suffixes.

- **Stable:** `vX.Y.Z` (e.g. `v1.0.0`) → published as a normal release.
- **Pre-release:** `vX.Y.Z-<channel>.<n>` (e.g. `v0.1.0-beta.1`, `v1.2.0-rc.1`).
  Any tag containing a hyphen is flagged as a GitHub **pre-release** automatically.

The git tag and `package.json` `version` must match (electron-builder derives
installer names and the in-app version from `package.json`).

### Channels

| Channel | Tag pattern            | Audience                          |
| ------- | ---------------------- | --------------------------------- |
| alpha   | `vX.Y.Z-alpha.N`       | internal / experimental           |
| beta    | `vX.Y.Z-beta.N`        | early adopters (current channel)  |
| rc      | `vX.Y.Z-rc.N`          | release-candidate hardening       |
| stable  | `vX.Y.Z`               | general availability              |

## Current status: Beta

The current build is the **first public beta**. `package.json` is set to
`0.1.0-beta.1`, to be released under the tag **`v0.1.0-beta.1`** as a GitHub
pre-release.

## How to cut a release

1. **Ensure `main` is green** — CI must pass (typecheck, tests, build).
2. **Set the version** in `package.json` to match the tag you intend to push
   (without the leading `v`). For the current beta it is already
   `0.1.0-beta.1`. Commit the change:
   ```bash
   # example for the next beta
   npm version 0.1.0-beta.2 --no-git-tag-version
   git commit -am "chore: release v0.1.0-beta.2"
   git push origin main
   ```
3. **Tag and push** (the tag triggers the release workflow):
   ```bash
   git tag v0.1.0-beta.1
   git push origin v0.1.0-beta.1
   ```
   > Or run the **Release** workflow manually from the Actions tab via
   > `workflow_dispatch`, passing the existing tag name.
4. **Wait for the build** — the `release` workflow builds installers on macOS,
   Linux, and Windows and creates a **draft** GitHub Release with all artifacts
   attached and auto-generated notes.
5. **Review & publish** — open the draft Release on GitHub, edit the notes,
   confirm all installers are attached, keep "This is a pre-release" checked for
   beta/rc, then click **Publish release**.

## Pre-release → stable checklist

- [ ] All CI checks green on `main`.
- [ ] Manual smoke test of each installer (launch, add/edit subscription,
      import/export, restart persistence, notifications, tray mode).
- [ ] **Zero-outbound packet-capture (release-QA).** See
      "[Network privacy verification](#network-privacy-verification)" — confirm a
      packaged build with all Online Features OFF makes NO outbound request.
- [ ] `package.json` version bumped and committed.
- [ ] Release notes drafted (highlights, fixes, known issues).
- [ ] (Stable) Code signing & notarization configured — see below.

## Network privacy verification

Subby's promise is "private by default": with every **Online Features** toggle
OFF the app makes **zero** outbound network requests. This is verified **two
ways**, and both must pass before a release.

1. **Static scan (automated, in CI).** `tests/privacy.test.ts` fails if any
   network primitive (`fetch`/XHR/WebSocket/EventSource) or networking module
   appears anywhere outside the single audited site `electron/net/gateway.ts`
   (a sibling under `net/` with a primitive still fails), hard-bans
   telemetry/tracking/`sendBeacon` everywhere (including inside `net/`), and
   asserts the production CSP carries no remote origin while toggles are off.
   `tests/net/gateway.test.ts` proves the gate refuses an off-toggle or
   unregistered-host request **before** the network primitive is ever invoked
   (the injected primitive spy records zero calls).

2. **Runtime packet-capture (manual release-QA step; addendum §SM-3).** The
   pure-Node CI harness cannot packet-capture a running Chromium, so this is a
   **documented manual step**, not faked in CI. On a **packaged** build with all
   Online Features **OFF**:
   - Launch the app behind a capture tool — e.g. **Little Snitch** / **LuLu**
     (macOS), **Wireshark** / **mitmproxy**, or a monitoring proxy — with all of
     Subby's process egress logged.
   - Exercise the app for a few minutes (open each screen, add/edit a
     subscription, open Settings → Online Features but leave every toggle off).
   - **Expected:** zero outbound **TCP/HTTPS connections to any remote host**
     from the Subby process — no logo provider (`t2.gstatic.com`), no FX host
     (`api.frankfurter.dev`), and none of Chromium's own phone-home surfaces
     (component updater, domain-reliability, spellcheck dictionary CDN), which
     are disabled at app init. DNS name lookups themselves (UDP/53 to the system
     resolver) are **excluded** from this assertion — what must be zero is any
     connection that carries application data to a remote endpoint.
   - Then enable a single toggle and confirm the ONLY new egress is that one
     feature's registered host over HTTPS, matching the CSP `connect-src`.

## Known beta limitations

- **Unsigned builds.** Installers are not code-signed or notarized yet:
  - macOS: Gatekeeper will warn — right-click → Open, or
    `xattr -dr com.apple.quarantine /Applications/Subby.app`.
  - Windows: SmartScreen may warn — choose "More info" → "Run anyway".
- **No auto-update.** Users download new versions manually from Releases.
- **Default app icon.** Branded icons can be added under `build/`
  (see `build/README.md`).

## Roadmap to stable (planned)

1. **Code signing & notarization**
   - macOS: Apple Developer ID cert + notarization (`CSC_LINK`, `CSC_KEY_PASSWORD`,
     `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` as repo secrets;
     enable `hardenedRuntime` + `entitlements`).
   - Windows: Authenticode cert (`CSC_LINK`, `CSC_KEY_PASSWORD`).
2. **Auto-update** via `electron-updater` (the `publish: github` block and the
   `latest*.yml` metadata are already emitted to support this).
3. **Branded icons** in `build/`.
4. Promote `v0.1.0` → `v1.0.0` once the feature set and stability bar are met.

## Required repository secrets

| Secret                     | Used for                                  | Needed now? |
| -------------------------- | ----------------------------------------- | ----------- |
| `GITHUB_TOKEN` (built-in)  | Creating releases / uploading artifacts   | Yes (auto)  |
| `CSC_LINK` / `CSC_KEY_PASSWORD` | Code signing (mac/win)               | Stable only |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | macOS notarization | Stable only |
