# Subby Documentation

Subby is a **privacy-first, offline subscription tracker** built as a
cross-platform Electron desktop app. All data lives locally as plain JSON
files — no database, no accounts, no network.

This directory contains the full project documentation.

## Contents

| Document | What's inside |
| --- | --- |
| [Overview](./overview.md) | What Subby is, design principles, and the technology stack. |
| [Getting Started](./getting-started.md) | Prerequisites, install, run, build, test, and the npm scripts. |
| [Architecture](./architecture.md) | The three-layer design, process model, data flow, and folder layout. |
| [Data Model](./data-model.md) | `Subscription`, `Settings`, `Category`, on-disk file shapes, and defaults. |
| [Core Reference](./core-reference.md) | API reference for every platform-independent `core/` module. |
| [Storage & Recovery](./storage-and-recovery.md) | JSON storage, safe reads, backups, the data folder, and error handling. |
| [IPC & Renderer API](./ipc-api.md) | IPC channels, the typed `window.subby` bridge, and result/error contracts. |
| [UI Guide](./ui-guide.md) | Views, components, client stores, theming, and accessibility. |
| [Notifications & Tray](./notifications-and-tray.md) | The reminder scheduler, lead times, and Tray_Mode. |
| [Requirements](./requirements.md) | The functional requirements the app satisfies. |
| [Testing](./testing.md) | Test strategy, property-based testing, and the correctness properties. |
| [Build & Release](./build-and-release.md) | Packaging with electron-builder and the CI/CD pipelines. |
| [Privacy & Security](./privacy-and-security.md) | Privacy guarantees and the renderer security posture. |
| [Contributing](./contributing.md) | Dev workflow, conventions, and where things live. |

## Quick links

- **Run it:** `npm install && npm run dev`
- **Test it:** `npm test`
- **Build installers:** `npm run dist:mac` / `dist:win` / `dist:linux`
- **Release process:** see [`../RELEASE.md`](../RELEASE.md)

## At a glance

- **Status:** beta (`0.1.0-beta.1`)
- **Platforms:** macOS, Windows, Linux
- **Stack:** Electron · React + TypeScript (strict) · electron-vite · TailwindCSS · zod · Vitest + fast-check
- **Storage:** local JSON files in a per-platform app data directory
- **Tests:** 186 tests across 24 files (unit, integration, and 23 property-based)
