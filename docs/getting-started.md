# Getting Started

## Prerequisites

- **Node.js 20+** (the CI pipeline uses Node 20).
- **npm** (the repo ships a `package-lock.json`; use `npm ci` for reproducible
  installs).
- A desktop OS: macOS, Windows, or Linux.

## Install

```bash
npm install
```

## Run in development

```bash
npm run dev
```

This launches `electron-vite dev`, which:

- builds the main and preload processes,
- starts the Vite dev server for the renderer (with HMR), and
- opens the Electron window.

On first run, Subby creates its application data directory and seeds default
files (see [Storage & Recovery](./storage-and-recovery.md)).

## Build the production bundle

```bash
npm run build
```

`build` runs `typecheck` first, then `electron-vite build`, emitting the bundled
app to `out/`:

```
out/
├── main/main.js        # main process bundle (Node side)
├── preload/preload.js  # CommonJS preload bridge
└── renderer/           # renderer assets (index.html + JS/CSS chunks)
```

The Calendar and Analytics views are code-split into their own lazy chunks to
protect cold-start time.

## Run the tests

```bash
npm test          # single run (CI mode)
npm run test:watch  # watch mode
```

See [Testing](./testing.md) for the full strategy.

## Build installers

These produce native installers under `release/` (see
[Build & Release](./build-and-release.md)):

```bash
npm run dist:mac     # .dmg + .zip (x64 + arm64)
npm run dist:win     # NSIS .exe (x64)
npm run dist:linux   # .AppImage + .deb (x64)
npm run pack         # unpacked app dir only (fast smoke test)
```

> Build each platform's installer **on that platform** (or in the CI release
> workflow). Cross-compiling installers is not supported here.

## npm scripts reference

| Script | Description |
| --- | --- |
| `dev` | Run the app in development with HMR. |
| `build` | Typecheck, then build the electron-vite bundle into `out/`. |
| `preview` | Preview the production build. |
| `typecheck` | `tsc --noEmit` against `tsconfig.json` (strict). |
| `test` | Run the full Vitest suite once. |
| `test:watch` | Run Vitest in watch mode. |
| `pack` | Build, then package an unpacked app directory (`electron-builder --dir`). |
| `dist` | Build, then package installers for the current platform. |
| `dist:mac` / `dist:win` / `dist:linux` | Build, then package installers for a specific platform. |

## Project layout (top level)

```
subby/
├── core/        # platform-independent business logic (pure TS)
├── electron/    # Electron main + preload + services + storage adapter
├── shared/      # types shared across the IPC boundary
├── src/         # React renderer (UI)
├── tests/       # unit, integration, and property-based tests
├── build/       # electron-builder resources (icons, etc.)
├── docs/        # this documentation
├── electron.vite.config.ts
├── electron-builder.yml
├── vitest.config.ts
├── tailwind.config.js
├── tsconfig.json
└── package.json
```

See [Architecture](./architecture.md) for a detailed tour.
