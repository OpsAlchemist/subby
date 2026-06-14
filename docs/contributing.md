# Contributing

## Development workflow

```bash
npm install      # or: npm ci
npm run dev      # run the app with HMR
npm test         # run the suite
npm run typecheck
npm run build    # production bundle
```

Before opening a PR, make sure `npm run typecheck`, `npm test`, and
`npm run build` all pass — these are exactly what CI runs.

## Where things go

| You're changing… | Put it in… | Notes |
| --- | --- | --- |
| Business logic (billing, renewal, search, analytics, import/export, backup, notify, mutations) | `core/` | Pure TypeScript only — **no** `electron`/`react`/`fs` imports, no wall-clock/`fs` reads. |
| Data shapes / validation | `core/models/` | Keep the TS interface and the zod schema in lockstep. |
| Storage behavior | `electron/storage/` | The adapter is the only place that touches the filesystem. |
| Main-process orchestration | `electron/appWiring.ts`, `electron/ipc/`, `electron/services/` | The composition root is the impure boundary (`now`, services). |
| Renderer UI | `src/views/`, `src/components/` | Derive from `core/`; never re-implement logic. |
| Client state | `src/stores/` | Framework-light stores; keep them DOM-free. |
| IPC contracts | `shared/types.ts`, `shared/subbyApi.ts`, `electron/ipc/channels.ts` | Update all three together when adding a channel. |

## Conventions

- **TypeScript strict.** No `any` escape hatches; keep `tsc --noEmit` clean.
- **Purity in `core/`.** Functions take `now`/`today` as parameters and never
  mutate inputs. This is what makes property testing possible.
- **No exceptions across IPC.** Handlers return `IpcResult<T>`; map failures to
  `AppError`. See [IPC & Renderer API](./ipc-api.md).
- **Dates** are ISO strings; date math is UTC; `YYYY-MM-DD` comparisons are
  lexicographic.
- **Accessibility.** Icon-only controls get `aria-label`s; interactive elements
  are keyboard-operable with visible focus rings; don't break accessible names
  that tests rely on (e.g. "Add subscription", "Select all subscriptions").
- **Security.** Never add network calls or telemetry. Don't weaken the renderer
  sandbox or the CSP. The privacy test will fail if you do.

## Adding a feature (typical path)

1. Add/extend the pure logic in `core/` with a **property test** (and example
   tests for edge cases). Tag properties `Feature: subby, Property {n}: {text}`.
2. If it needs persistence, extend the `StoragePort` and its adapter, and add an
   app-service method in `electron/appWiring.ts`.
3. Add the IPC channel (constant + handler + preload facade method + shared
   type), and broadcast `evt:dataChanged` on success if it mutates.
4. Wire the renderer: a store (if needed), the `src/api/subby.ts` wrapper, and
   the view/component. Add jsdom tests with a fake `SubbyApi`.
5. Run `typecheck`, `test`, `build`.

## Testing expectations

- Pure core → property tests + examples.
- Renderer → jsdom + Testing Library with an injected fake facade.
- Main-process services → integration tests against real temp directories;
  inject the scheduler clock/notifier seams.

See [Testing](./testing.md) for the full strategy and the list of correctness
properties.

## Commit & release

- Keep `main` green; the CI workflow runs typecheck + tests + build on every
  push/PR.
- Releases are tag-driven; see [Build & Release](./build-and-release.md) and
  [`../RELEASE.md`](../RELEASE.md).
