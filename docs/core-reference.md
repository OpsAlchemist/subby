# Core Reference

Everything under `core/` is **pure, platform-independent TypeScript** — no
imports from `electron`, `react`, or Node's `fs`. Functions never read the wall
clock or the filesystem; callers pass `now`/`today` for determinism. This makes
the core trivially unit-testable and reusable on other platforms.

Date convention: dates are ISO strings (`YYYY-MM-DD` for dates, full ISO for
datetimes). Because `YYYY-MM-DD` is lexicographically ordered, plain string
comparison is valid for chronological ordering. Date arithmetic uses UTC to
avoid timezone drift.

---

## `core/billing.ts` — billing normalization

```ts
monthsInCustomInterval(interval: CustomInterval): number
monthlyAmount(s: Pick<Subscription, "amount" | "billingCycle" | "customInterval">): number
yearlyAmount(s: Pick<Subscription, "amount" | "billingCycle" | "customInterval">): number
sumMonthly(subs: Subscription[]): number
```

`monthlyAmount` normalizes any billing cycle to a monthly figure:

| Cycle | Monthly amount |
| --- | --- |
| Monthly | `amount` |
| Yearly | `amount / 12` |
| Half-Yearly | `amount / 6` |
| Quarterly | `amount / 3` |
| Weekly | `amount * 52 / 12` |
| Custom | `amount / monthsInCustomInterval(customInterval)` |

`monthsInCustomInterval` converts an interval to months using a documented
constant of 30 days/month: `day → count/30`, `week → count*7/30`,
`month → count`, `year → count*12`.

`yearlyAmount = monthlyAmount * 12`. `sumMonthly` sums directly with no currency
conversion.

---

## `core/renewal.ts` — renewal calculation

```ts
type ISODate = string; // "YYYY-MM-DD"
advanceRenewal(date: ISODate, cycle: BillingCycle, custom?: CustomInterval): ISODate
rollForward(s: Subscription, today: ISODate): Subscription
```

- `advanceRenewal` adds exactly one billing interval (Weekly +7d, Monthly +1mo,
  Quarterly +3mo, Half-Yearly +6mo, Yearly +12mo, Custom = configured interval).
  Month math clamps month-end days (e.g. Jan 31 + 1 month → Feb 28/29).
- `rollForward` advances a past `nextRenewal` forward by whole intervals until it
  is on/after `today` — but only when `autoRenew` is true. Returns the same
  object reference when nothing changes.

---

## `core/search.ts` — fuzzy search

```ts
fuzzySearch(subs: Subscription[], query: string): Subscription[]
bestScore(query: string, candidates: string[]): number
```

A lightweight subsequence matcher over `name` and `provider`:

- An empty/whitespace query returns all subscriptions unchanged.
- A query matches when it is a case-insensitive **subsequence** of a candidate
  (so `"net"` matches `Netflix`, `Internet`, `Network`).
- Results are filtered to positive scores and sorted by score descending;
  contiguous and earlier matches rank higher.

---

## `core/subscriptions.ts` — mutations & filtering

Pure helpers; none mutate their inputs. IDs use `crypto.randomUUID()`.

```ts
createSubscription(existing, input: SubscriptionInput, now): Subscription[]   // createdAt === updatedAt === now
editSubscription(existing, id, patch: SubscriptionPatch, now): Subscription[] // advances updatedAt
toggleActive(existing, id, value, now): Subscription[]
deleteSubscription(existing, id): Subscription[]

// Predicates / filtering
type SubscriptionPredicate = (s: Subscription) => boolean
filterByPredicate(subs, predicate): Subscription[]
byCategory(category): SubscriptionPredicate
byStatus(isActive): SubscriptionPredicate
byCycle(cycle): SubscriptionPredicate
isActive: SubscriptionPredicate
and(...predicates): SubscriptionPredicate
or(...predicates): SubscriptionPredicate
activeSubscriptions(subs): Subscription[]
```

`SubscriptionPatch = Partial<Omit<Subscription, "id" | "createdAt" | "updatedAt">>`
keeps system-managed fields immutable.

---

## `core/categories.ts` — categories & settings merge

```ts
type CreateCategoryResult =
  | { ok: true; categories: Category[]; created: Category }
  | { ok: false; reason: "duplicate"; name: string };

createCategory(existing: Category[], name: string): CreateCategoryResult
categoryAssignmentCount(subs: Subscription[], categoryName: string): number
isCategoryInUse(subs: Subscription[], categoryName: string): boolean
deleteCategory(existing: Category[], id: string): Category[]
mergeSettings(current: Settings, patch: Partial<Settings>): Settings
```

- `createCategory` rejects duplicate names (case-insensitive, trimmed) via a
  discriminated result rather than throwing; the rejected result echoes the
  existing colliding name.
- `isCategoryInUse` / `categoryAssignmentCount` let the UI prompt before
  deleting a category still assigned to subscriptions.
- `mergeSettings` returns a new object; the nested `notification` object is
  deep-merged and `leadTimes` is defensively copied.

---

## `core/analytics.ts` — aggregations & orderings

Consumed by the Dashboard and Analytics views. All pure; sorts operate on copies
and produce stable permutations.

```ts
totalMonthly(active: Subscription[]): number
totalYearly(active: Subscription[]): number
activeCount(subs: Subscription[]): number
renewingWithin(subs: Subscription[], days: number, today: ISODate): Subscription[]
recentlyChanged(subs: Subscription[], n: number): Subscription[]                  // updatedAt desc
categoryDistribution(active: Subscription[]): { category: string; monthly: number }[]
topByMonthly(active: Subscription[], n: number): Subscription[]                   // monthly amount desc
renewalTimeline(subs: Subscription[], today: ISODate): { date: ISODate; subs: Subscription[] }[]
```

`categoryDistribution` conserves total spend (the group sum equals
`totalMonthly`). `renewalTimeline` partitions upcoming subscriptions so each
appears exactly once, keyed by its own `nextRenewal`, ordered by date.

---

## `core/export.ts` — serialization

```ts
const EXPORT_VERSION = 1
interface ExportFile { version: number; subscriptions: Subscription[]; settings: Settings; }
exportJson(subs: Subscription[], settings: Settings): string
exportCsv(subs: Subscription[]): string
const CSV_COLUMNS: readonly (keyof Subscription)[]
```

- **JSON export** is the `ExportFile` shape (`SubscriptionsFile` + a `settings`
  object), pretty-printed. It is importer-compatible, guaranteeing round-trip.
- **CSV export** has a header row + one row per subscription, RFC-4180 escaped
  (fields with `,`/`"`/CR/LF are quoted; embedded quotes doubled), rows joined
  with CRLF. `customInterval` is serialized as a JSON cell (or empty); booleans
  as `true`/`false`; `amount` numeric. The column order is `CSV_COLUMNS`.

---

## `core/import.ts` — parse, validate, resolve

```ts
interface ImportOutcome {
  applied: Subscription[];                 // full new set to persist
  imported: number;
  skipped: number;
  rejected: { row: number; reason: string }[];
}
planImport(existing: Subscription[], incomingRaw: string,
           format: "json" | "csv", mode: ConflictMode): ImportOutcome
```

Pipeline:

1. Parse by format. JSON reads the `subscriptions` array (also tolerates a bare
   array). CSV is parsed with a hand-rolled RFC-4180 tokenizer.
2. Validate each record against `subscriptionSchema`; failures are collected with
   their row index and reason. A whole-file parse failure is reported as row 0
   and leaves existing data untouched.
3. Detect duplicates against the working set by `id`, falling back to
   `name + provider`.
4. Resolve via `ConflictMode`:
   - **Replace** — overwrite the existing record with the incoming one.
   - **Merge** — fill only the existing record's missing/empty fields, preserving
     existing non-empty values and the existing `id`.
   - **Skip** — keep the existing record.

`applied` always starts from `existing`, so partial failures never discard valid
data.

---

## `core/backup.ts` — backup naming & payload (pure parts)

```ts
const BACKUP_SCHEMA_VERSION = 1
backupFileName(now: Date): string                                  // "YYYY-MM-DD-HH-MM.json" (UTC)
assembleBackupPayload(source: Subscription[] | SubscriptionsFile): SubscriptionsFile
```

The side-effecting file write lives in the storage adapter; this module only
generates the timestamped name (UTC, zero-padded, deterministic) and assembles
the versioned payload.

---

## `core/notify.ts` — due-lead-time decision

```ts
dueLeadTimes(sub: Subscription, today: ISODate, enabled: ReminderLeadTime[]): ReminderLeadTime[]
```

Returns the subset of `enabled` lead times whose target date equals `today`:

- `same-day` → `nextRenewal === today`
- `one-day` → `nextRenewal === today + 1 day`
- `three-days` → `nextRenewal === today + 3 days`

Output is in canonical order (same-day, one-day, three-days) and de-duplicated.
The scheduler maps each returned lead time to a desktop notification.

---

## `core/ports/storagePort.ts` — the storage port

The platform-independent repository interface implemented by the Electron
adapter. See [Storage & Recovery](./storage-and-recovery.md).

```ts
interface StoragePort {
  readSubscriptions(): Promise<Subscription[]>;
  writeSubscriptions(subs: Subscription[]): Promise<void>;
  readSettings(): Promise<Settings>;
  writeSettings(settings: Settings): Promise<void>;
  readCategories(): Promise<Category[]>;
  writeCategories(categories: Category[]): Promise<void>;
  createBackup(reason: string): Promise<string>;   // returns backup filename
  listBackups(): Promise<string[]>;
  readBackup(name: string): Promise<SubscriptionsFile>;
  getDataFolder(): string;
  setDataFolder(path: string | null): Promise<void>;
}
```
