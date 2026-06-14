# Architecture

Subby is organized around a strict separation between three layers:

1. **Platform-independent core** (`core/`) — pure TypeScript for billing,
   renewal, search, analytics, import, export, backup, and notification
   decisions. No React, no Electron, no Node `fs`. Fully unit-testable and
   portable.
2. **Storage port + Electron adapter** (`electron/storage/`) — a repository
   interface (the *port*) plus a JSON-file implementation that performs all disk
   I/O in the Electron main process.
3. **Renderer UI** (`src/`) — a thin, secure React app. It owns no file access;
   every data operation flows over IPC through a typed preload bridge.

## Process model

```
┌──────────────────────────────────────────────────────────────────┐
│                          ELECTRON APP                              │
│                                                                    │
│  ┌────────────────────────┐        ┌──────────────────────────┐   │
│  │     MAIN PROCESS        │        │       RENDERER           │   │
│  │  (Node, full fs access) │        │  (Chromium, sandboxed)   │   │
│  │                         │  IPC   │                          │   │
│  │  - App lifecycle        │◄──────►│  - React UI (views)      │   │
│  │  - JsonFileStorage      │ invoke │  - Client stores         │   │
│  │  - App services         │ +events│  - Theme manager (CSS)   │   │
│  │  - Backup / Import /     │        │  - window.subby.*        │   │
│  │    Export (via core)    │        │                          │   │
│  │  - Notification + Tray  │        │   NO direct fs access    │   │
│  │  - Scheduler            │        │   contextIsolation: true │   │
│  │                         │        │   nodeIntegration: false │   │
│  └────────────────────────┘        └────────────┬─────────────┘   │
│            ▲                                     │                 │
│            │            preload.ts (contextBridge)│                │
│            └─────────────────────────────────────┘                 │
│                   exposes typed window.subby API                   │
└──────────────────────────────────────────────────────────────────┘
```

**Security posture:** the renderer runs with `contextIsolation: true`,
`nodeIntegration: false`, and `sandbox: true`. It never imports `fs`, `path`, or
`electron`. The only bridge is the preload-exposed `window.subby` surface. See
[Privacy & Security](./privacy-and-security.md).

## Layered view

```
┌─────────────────────────────────────────────────────────────┐
│  PRESENTATION (Renderer / React)                              │
│  Views: Dashboard, List, Calendar, Analytics, Settings,       │
│         About, Add/Edit Modal, Global Search                  │
│  Concerns: rendering, interaction, theming, a11y              │
└───────────────────────────┬─────────────────────────────────┘
                            │  window.subby (typed IPC bridge)
┌───────────────────────────▼─────────────────────────────────┐
│  APPLICATION (Main-process orchestration)                     │
│  IPC handlers → App services. Sequences: backup-before-       │
│  destructive, validate-before-import, persist-then-notify.    │
└───────────────────────────┬─────────────────────────────────┘
            ┌────────────────┼─────────────────┐
┌───────────▼──────┐ ┌───────▼────────┐ ┌───────▼───────────────┐
│ CORE             │ │ STORAGE         │ │ PLATFORM SERVICES     │
│ (pure, portable) │ │ (port+adapter)  │ │ (Electron-specific)   │
│ billing, renewal,│ │ StoragePort     │ │ Notification, Tray,   │
│ search, import,  │ │ JsonFileStorage │ │ Scheduler, Dialogs    │
│ export, backup,  │ │                 │ │                       │
│ analytics, notify│ │                 │ │                       │
└──────────────────┘ └───────┬─────────┘ └───────────────────────┘
                            │
                    ┌───────▼─────────┐
                    │  JSON FILES      │
                    │  App_Data_Dir    │
                    └─────────────────┘
```

## Data flow (a mutation, end to end)

A typical write — e.g. creating a subscription — flows like this:

1. **Renderer** calls `window.subby.createSubscription(input)` (via the
   `src/api/subby.ts` wrapper).
2. The **preload bridge** forwards it as `ipcRenderer.invoke("subs:create", input)`.
3. The **IPC handler** (`electron/ipc/handlers.ts`) calls the matching **app
   service** method (`electron/appWiring.ts`).
4. The service reads the current data via the **StoragePort**, applies a **pure
   core** function (`core/subscriptions.createSubscription`) using the current
   timestamp, and writes the result back through the port (atomically).
5. The handler returns an `IpcResult<T>` and broadcasts `evt:dataChanged`.
6. The renderer's **client stores** react to `onDataChanged`, reload, and the
   relevant views re-render.

Reads follow the same path without the write/broadcast steps. Destructive
operations (delete, import-apply, restore) create a backup *before* mutating.

## The impure boundary

`core/` functions are pure and deterministic — they never read the wall clock or
the filesystem. The single place that injects "now" (`new Date().toISOString()`)
is `electron/appWiring.ts`, the application composition root. The single place
that touches the filesystem is the storage adapter. This keeps the core testable
and the side effects centralized.

## Folder structure & responsibilities

```
subby/
├── electron/                       # Main + preload (Node side)
│   ├── main.ts                     # App lifecycle, window, CSP, tray, scheduler bootstrap
│   ├── preload.ts                  # contextBridge → window.subby
│   ├── appWiring.ts                # builds app services, injects the StoragePort (impure boundary)
│   ├── ipc/
│   │   ├── channels.ts             # CH: centralized IPC channel-name constants
│   │   └── handlers.ts             # ipcMain.handle registrations → services; IpcResult mapping
│   ├── storage/
│   │   ├── paths.ts                # App_Data_Directory resolution + file names
│   │   ├── safeJson.ts             # safe read/parse/validate + atomic write
│   │   └── jsonFileStorage.ts      # Electron StoragePort implementation
│   └── services/
│       ├── notificationService.ts  # Electron Notification emission
│       ├── scheduler.ts            # periodic + launch renewal evaluation
│       ├── tray.ts                 # Tray_Mode behavior
│       └── dialog.ts               # open/save dialogs + data-folder chooser
├── core/                           # Business logic (PLATFORM-INDEPENDENT)
│   ├── models/                     # TS interfaces + zod schemas + defaults
│   │   ├── subscription.ts
│   │   ├── settings.ts
│   │   ├── category.ts
│   │   └── schema.ts               # zod validators, DEFAULT_CATEGORIES, DEFAULT_SETTINGS
│   ├── billing.ts                  # monthly/yearly normalization
│   ├── renewal.ts                  # next-renewal advancement / roll-forward
│   ├── search.ts                   # fuzzy subsequence search
│   ├── subscriptions.ts            # pure mutation + filtering helpers
│   ├── categories.ts               # category create/delete + settings merge
│   ├── analytics.ts                # aggregations and orderings
│   ├── import.ts                   # parse + validate + conflict resolve
│   ├── export.ts                   # serialize to JSON / CSV
│   ├── backup.ts                   # backup naming + payload assembly (pure parts)
│   ├── notify.ts                   # due-lead-time decision (pure)
│   └── ports/
│       └── storagePort.ts          # StoragePort interface (the port)
├── src/                            # Renderer (React)
│   ├── main.tsx                    # React entry; initStores()
│   ├── App.tsx                     # shell: nav rail, top bar, routing, shortcuts, theme wiring
│   ├── api/subby.ts                # typed wrapper over window.subby
│   ├── views/                      # Dashboard, SubscriptionList, CalendarView, AnalyticsView, Settings, About
│   ├── components/                 # SubscriptionModal, GlobalSearch
│   ├── stores/                     # client state (subscriptions, settings, categories, error) + hooks
│   ├── theme/themeManager.ts       # theme + accent application
│   ├── lib/utils.ts                # cn() class helper
│   └── styles/globals.css          # Tailwind + theme tokens
├── shared/
│   ├── types.ts                    # IPC request/response contracts (IpcResult, AppError, …)
│   └── subbyApi.ts                 # the typed window.subby facade type
└── tests/                          # unit + integration + property-based tests
```

## Build configuration

- **`electron.vite.config.ts`** — three Vite build targets (main, preload,
  renderer) with shared path aliases (`core`, `shared`, `@` → `src`). The
  preload is forced to CommonJS because sandboxed preloads cannot be ES modules.
- **`tsconfig.json`** — TypeScript strict mode with the same path aliases.
- **`vitest.config.ts`** — mirrors the aliases; node environment by default,
  with renderer tests opting into jsdom per file.
- **`tailwind.config.js` / `postcss.config.js`** — Tailwind + autoprefixer.
- **`electron-builder.yml`** — installer packaging (see [Build & Release](./build-and-release.md)).
