# Data Model

All models are defined as TypeScript interfaces in `core/models/` with matching
[zod](https://zod.dev) schemas in `core/models/schema.ts`. The schemas are the
single source of truth for runtime validation used by subscription submission,
import, and safe file reads.

## Subscription

A tracked recurring payment.

```ts
type BillingCycle =
  | "Weekly" | "Monthly" | "Quarterly" | "Half-Yearly" | "Yearly" | "Custom";

interface CustomInterval {
  unit: "day" | "week" | "month" | "year";
  count: number; // positive integer; used only when billingCycle === "Custom"
}

interface Subscription {
  id: string;                 // unique (uuid v4)
  name: string;               // required, non-empty
  provider: string;
  category: string;           // a Category name
  amount: number;             // non-negative
  currency: string;           // e.g. "INR"
  billingCycle: BillingCycle;
  customInterval?: CustomInterval; // present when billingCycle === "Custom"
  nextRenewal: string;        // ISO date "YYYY-MM-DD"
  startDate: string;          // ISO date
  paymentMethod: string;
  website: string;
  notes: string;
  color: string;              // hex, for UI accent
  icon: string;               // lucide icon key or provider slug
  isActive: boolean;
  autoRenew: boolean;
  createdAt: string;          // ISO datetime
  updatedAt: string;          // ISO datetime
}
```

**Validation rules (enforced by `subscriptionSchema`):**

- `name` must be non-empty.
- `amount` must be a non-negative, finite number.
- `billingCycle` must be one of the six values.
- `nextRenewal` / `startDate` must match `YYYY-MM-DD`; `createdAt` / `updatedAt`
  must be valid ISO datetimes.
- When `billingCycle === "Custom"`, `customInterval` is required, and its
  `count` must be a positive integer.

## Settings

Persisted user preferences.

```ts
type ReminderLeadTime = "same-day" | "one-day" | "three-days";

interface Settings {
  defaultCurrency: string;          // "INR" for this build
  notification: {
    enabled: boolean;
    leadTimes: ReminderLeadTime[];  // any subset enabled
  };
  backupFrequency: "off" | "daily" | "weekly";
  theme: "dark" | "light" | "system";
  accentColor: string;              // hex
  trayMode: boolean;
  dataFolder: string | null;        // null = default App_Data_Directory
}
```

## Category

A label used to group subscriptions.

```ts
interface Category {
  id: string;
  name: string;
  isDefault: boolean;
  color?: string;
}
```

## On-disk file shapes

Each JSON file carries a `version` for forward compatibility.

```ts
interface SubscriptionsFile { version: number; subscriptions: Subscription[]; }
interface CategoriesFile    { version: number; categories: Category[]; }
interface SettingsFile extends Settings { version: number; } // Settings + version
```

The current on-disk schema version is `1`.

## Defaults

Defined in `core/models/schema.ts`, applied on first run / file recreation.

**Default categories** (11, created when `categories.json` is first initialized,
each with `isDefault: true`):

```
Entertainment, Productivity, Cloud Hosting, Streaming, AI, Music,
Gaming, Fitness, Utilities, Education, Development
```

**Default settings:**

```ts
const DEFAULT_SETTINGS: Settings = {
  defaultCurrency: "INR",
  notification: { enabled: true, leadTimes: ["same-day", "one-day", "three-days"] },
  backupFrequency: "weekly",
  theme: "dark",            // dark-first default
  accentColor: "#7C5CFF",
  trayMode: false,
  dataFolder: null,
};
```

## On-disk layout

Files live in the **App Data Directory** (overridable via
`settings.dataFolder`):

```
<App_Data_Directory>/
├── subscriptions.json   # { version, subscriptions: [...] }
├── settings.json        # { version, ...Settings }
├── categories.json      # { version, categories: [...] }
└── backup/
    └── YYYY-MM-DD-HH-MM.json   # timestamped subscription backups
```

Default per-platform locations (Electron `app.getPath('userData')`):

| Platform | Path |
| --- | --- |
| macOS | `~/Library/Application Support/Subby` |
| Windows | `%APPDATA%\Subby` (Roaming) |
| Linux | `~/.config/Subby` |

See [Storage & Recovery](./storage-and-recovery.md) for how files are read,
recovered, and backed up.
