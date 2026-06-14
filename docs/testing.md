# Testing

The suite has **186 tests across 24 files**, combining unit, integration, and
property-based tests. Run it with:

```bash
npm test          # single run
npm run test:watch
```

Configuration is in `vitest.config.ts`: node environment by default (with the
same `core`/`shared`/`@` path aliases as the build), and renderer/DOM tests opt
into jsdom with a `// @vitest-environment jsdom` pragma per file.

## Layers of testing

| Kind | Where | What it covers |
| --- | --- | --- |
| **Property-based** (fast-check) | `tests/*.property.test.ts` | Universal correctness properties of the pure core (≥100 iterations each). |
| **Unit / example** | `tests/*.test.ts(x)` | Edge cases and specific behaviors (analytics, categories, calendar grid, stores, theme, views). |
| **Integration** | `tests/*.integration.test.ts` | The app-service + storage layer end to end against real temp directories, plus scheduler behavior. |
| **Accessibility** | `tests/accessibility.test.tsx` | Automated axe scans + keyboard-navigation checks. |
| **Privacy** | `tests/privacy.test.ts` | Static source scan asserting no network/telemetry usage and CSP correctness. |

## Property-based testing

Subby is developed against formal correctness properties encoded with
[fast-check](https://github.com/dubzzz/fast-check). Each property runs at least
100 random iterations and is tagged `Feature: subby, Property {n}: {text}`.

| # | Property | Module under test |
| --- | --- | --- |
| 1 | Monthly amount normalization per billing cycle | billing |
| 2 | Yearly amount equals monthly times twelve | billing |
| 3 | Totals sum directly and are order-independent | billing |
| 4 | Active totals and active count use only active subscriptions | analytics |
| 5 | Renewal roll-forward lands in the future on a whole interval | renewal |
| 6 | Creating a subscription grows the list with a unique id and equal timestamps | subscriptions |
| 7 | Editing a subscription applies the change and advances updatedAt | subscriptions |
| 8 | Toggling active sets the chosen value | subscriptions |
| 9 | Deleting a subscription removes exactly that subscription | subscriptions |
| 10 | Invalid subscription input is rejected with the offending field | schema |
| 11 | Category names are unique | categories |
| 12 | Derived orderings are sorted permutations | analytics |
| 13 | Filtering returns a faithful subset | subscriptions |
| 14 | Partitions conserve and correctly key all subscriptions | analytics |
| 15 | Fuzzy search matches subsequences on name or provider | search |
| 16 | Empty search returns all subscriptions | search |
| 17 | Due lead times are exactly the enabled ones whose target date is today | notify |
| 18 | Settings update round-trips | categories (mergeSettings) |
| 19 | Export then import reproduces the subscription set | export + import |
| 20 | Import validates per record and preserves existing valid data | import |
| 21 | Conflict modes resolve duplicates correctly | import |
| 22 | Backup file names follow the timestamp format | backup |
| 23 | Reading malformed data never crashes and identifies the file | storage/safeJson |

## Integration tests

- **`jsonFileStorage.integration.test.ts`** — bootstrap (dir + files
  auto-created), missing-file recreation, corrupt-file recovery offers, and
  backup round-trip, all against real temp dirs.
- **`ipc.integration.test.ts`** — app-service round-trips and the
  backup-before-destructive ordering (verified three ways: call-order spies,
  backup count increase, and pre-op state capture). Also source-level checks
  that the preload forwards only via channel constants and the renderer never
  imports `fs`/`path`/`electron`.
- **`exportDataFolder.integration.test.ts`** — export to a chosen path (JSON +
  CSV, with import round-trip) and data-folder switching.
- **`scheduler.integration.test.ts`** — offline emission, Tray_Mode on/off
  evaluation modeling, dedupe across cycles/days, and settings gating.

## Renderer tests (jsdom)

`dashboard`, `subscriptionModal`, `subscriptionList`, `settings`, `themeManager`,
and `stores` tests use Testing Library + a fake `SubbyApi` injected via
`setSubby(...)`. They verify reactivity (stores reload on `onDataChanged`),
modal validation/pre-population, list interactions (sort/filter/group/bulk/
quick-edit), settings persistence, and theme application.

## Writing new tests

- **Pure core logic** → prefer a property test in `tests/<module>.property.test.ts`
  (tag it `Feature: subby, Property {n}: {text}`), plus example tests for edge
  cases.
- **Renderer components/stores** → jsdom + Testing Library; inject a fake facade
  with `setSubby(...)` and drive reactivity by firing the captured
  `onDataChanged`/`onError` callbacks. Reset stores and call `setSubby(null)` in
  `afterEach`.
- **Main-process services** → integration tests against a real temp dir
  (`os.tmpdir()` + `fs.mkdtemp`), cleaned up afterwards. Inject the scheduler's
  clock/notifier seams rather than using real timers.
