# Privacy & Security

Privacy is a core product promise, not an afterthought. Subby is designed and
verified to keep your data on your device.

## Privacy guarantees

- **No analytics, telemetry, or tracking.** There are no tracking SDKs and no
  usage reporting anywhere in the code.
- **No network.** No accounts, no cloud sync, and no outbound requests of any
  kind. The app is fully functional offline — including desktop notifications,
  which are delivered locally by the OS.
- **Local-only storage.** All data is stored as JSON files in the local
  application data directory (or a folder you choose). Nothing leaves your
  machine.

These are enforced and continuously verified — see "Verification" below.

## Renderer security posture

The renderer is treated as untrusted and tightly sandboxed:

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`

The renderer cannot import `fs`, `path`, or `electron`. Its only capability is
the typed `window.subby` bridge exposed by the preload — which forwards solely
through centralized channel constants, never raw strings. All filesystem access
happens in the main process.

## Content Security Policy

A CSP disallows remote origins in two places (defense in depth):

- **`src/index.html`** meta CSP — `default-src 'self'`, `object-src 'none'`, and
  a `connect-src` that permits no remote `http(s)` origins (dev-only `ws:`/`wss:`
  for Vite HMR).
- **`electron/main.ts`** production CSP applied via `onHeadersReceived` —
  `connect-src 'self'`, `object-src 'none'`, no remote origins.

## Error handling never leaks or crashes

Bad data never crashes the app or escapes as an exception across the IPC bridge.
Reads are classified (`missing`/`malformed`/`corrupt`) and recovered; failures
are returned as user-friendly `AppError` values. See
[Storage & Recovery](./storage-and-recovery.md).

## Verification

Privacy and security properties are checked automatically by the test suite
(`tests/privacy.test.ts`, `tests/accessibility.test.tsx`):

- A static scan of `core/`, `electron/`, `src/`, and `shared/` asserts there is
  **no** use of `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`,
  `sendBeacon`, no imports of network modules (`http`/`https`/`net`/`dgram`/
  `dns`/`tls`/`http2`), no HTTP clients, and no telemetry SDKs.
  (The app's own spending *analytics* module is unrelated and not flagged.)
- The meta CSP and production CSP are asserted to block remote origins.
- The storage layer is asserted to use only `node:fs`.

## Beta caveats

- **Unsigned builds.** Beta installers are not code-signed or notarized:
  - macOS: right-click → Open, or
    `xattr -dr com.apple.quarantine /Applications/Subby.app`.
  - Windows: SmartScreen "More info" → "Run anyway".
- Code signing and notarization are planned for the stable release (see
  [`../RELEASE.md`](../RELEASE.md)).
