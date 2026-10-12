/**
 * Zod validators and default constants (Req 1.5, 6.3, 7.1, 14.4).
 *
 * Platform-independent. MUST NOT import from `electron`, `react`, or Node's `fs`.
 *
 * These schemas mirror the TypeScript interfaces in `core/models/*` and are the
 * single source of truth for runtime validation used by subscription
 * submission (Req 3.5, 3.6), import (Req 16.1), and safe file reads (Req 19).
 */

import { z } from "zod";

import type { BillingCycle, CustomInterval, Subscription, SubscriptionsFile } from "core/models/subscription";
import type {
  SubscriptionState,
  TrialV2,
  PriceEntryV2,
  SubscriptionV2,
  SubscriptionsFileV2,
} from "core/models/subscription";
import type { ReminderLeadTime, Settings, SettingsFile } from "core/models/settings";
import type { OnlineSettingsV2, SettingsV2, SettingsFileV2 } from "core/models/settings";
import type { Category, CategoriesFile } from "core/models/category";

// --- Primitive / enum schemas ------------------------------------------------

/** YYYY-MM-DD calendar date (Req 5.3, design: ISO date). */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date (YYYY-MM-DD)");

/** ISO datetime string (e.g. from `new Date().toISOString()`). */
const isoDateTime = z
  .string()
  .min(1)
  .refine((v) => !Number.isNaN(Date.parse(v)), "must be a valid ISO datetime");

export const billingCycleSchema = z.enum([
  "Weekly",
  "Monthly",
  "Quarterly",
  "Half-Yearly",
  "Yearly",
  "Custom",
]);

export const reminderLeadTimeSchema = z.enum([
  "same-day",
  "one-day",
  "three-days",
]);

/** Custom interval: positive integer count with a unit (Req 5.4). */
export const customIntervalSchema = z.object({
  unit: z.enum(["day", "week", "month", "year"]),
  count: z.number().int().positive(), // positive integer
});

// --- Subscription ------------------------------------------------------------

/**
 * Subscription validator.
 *
 * Enforces a non-empty name (Req 3.5), a non-negative finite amount (Req 3.6),
 * a valid billing cycle enum, and a valid custom interval when present. When
 * the billing cycle is "Custom", a `customInterval` is required (Req 5.4).
 */
export const subscriptionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1, "name is required"), // Req 3.5
    provider: z.string(),
    category: z.string(),
    amount: z.number().nonnegative("amount must be a non-negative number"), // Req 3.6
    currency: z.string(),
    billingCycle: billingCycleSchema,
    customInterval: customIntervalSchema.optional(),
    nextRenewal: isoDate,
    startDate: isoDate,
    paymentMethod: z.string(),
    website: z.string(),
    notes: z.string(),
    color: z.string(),
    icon: z.string(),
    isActive: z.boolean(),
    autoRenew: z.boolean(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  })
  .superRefine((sub, ctx) => {
    // A Custom billing cycle requires a custom interval (Req 5.4).
    if (sub.billingCycle === "Custom" && sub.customInterval === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "customInterval is required when billingCycle is 'Custom'",
        path: ["customInterval"],
      });
    }
  });

/** Root file shape for `subscriptions.json` (Req 1.2). */
export const subscriptionsFileSchema = z.object({
  version: z.number().int().nonnegative(),
  subscriptions: z.array(subscriptionSchema),
});

// --- Settings ----------------------------------------------------------------

/** Settings validator (Req 15.1, 6.3, 14.4). */
export const settingsSchema = z.object({
  defaultCurrency: z.string().min(1),
  notification: z.object({
    enabled: z.boolean(),
    leadTimes: z.array(reminderLeadTimeSchema),
  }),
  backupFrequency: z.enum(["off", "daily", "weekly"]),
  theme: z.enum(["dark", "light", "system"]),
  accentColor: z.string(),
  trayMode: z.boolean(),
  dataFolder: z.string().nullable(),
});

/** Root file shape for `settings.json` (Req 1.2): Settings + version. */
export const settingsFileSchema = settingsSchema.extend({
  version: z.number().int().nonnegative(),
});

// --- Category ----------------------------------------------------------------

/** Category validator (Req 7.1). */
export const categorySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  isDefault: z.boolean(),
  color: z.string().optional(),
});

/** Root file shape for `categories.json` (Req 1.2). */
export const categoriesFileSchema = z.object({
  version: z.number().int().nonnegative(),
  categories: z.array(categorySchema),
});

// --- v2 schemas (additive; lockstep with the v2 interfaces) ------------------
// These validate the schema-v2 shapes defined in `core/models/*`. They are the
// single runtime-validation source for v2 records consumed by the migrator
// (Story 1.3), the storage cutover (1.4), multi-currency (Epic 2), and the
// renderer/IPC cutover (Epic 3). The v1 schemas above are untouched.

/** Integer minor units, non-negative (AD-10: amounts at rest). */
const minorUnits = z.number().int().nonnegative("must be a non-negative integer (minor units)");

/** Three-way subscription State (AD-17). */
export const subscriptionStateSchema = z.enum(["Active", "Paused", "Trial"]);

/**
 * Embedded trial validator (AD-17 / AD-18). A trial is specified either by an
 * explicit `endDate` OR by `startDate` + a whole number of `lengthDays`.
 * **Months are unrepresentable** — the shape only admits days or an end date.
 */
export const trialSchema = z.union([
  z
    .object({
      endDate: isoDate,
      startDate: isoDate.optional(),
      postAmountMinor: minorUnits,
    })
    .strict()
    .superRefine((trial, ctx) => {
      // When both dates are present, the trial cannot end before it starts.
      // YYYY-MM-DD compares correctly lexicographically.
      if (trial.startDate !== undefined && trial.startDate > trial.endDate) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "trial startDate must be on or before endDate",
          path: ["startDate"],
        });
      }
    }),
  z
    .object({
      startDate: isoDate,
      lengthDays: z.number().int().positive("trial lengthDays must be a positive integer number of days"),
      postAmountMinor: minorUnits,
    })
    .strict(),
]);

/** One append-only price-history entry (AD-21). */
export const priceEntrySchema = z.object({
  amountMinor: minorUnits,
  currency: z.string().min(1),
  date: isoDate,
});

/**
 * v2 Subscription validator. Mirrors `SubscriptionV2`: integer `amountMinor`,
 * three-way `state` with an optional embedded `trial`, append-only
 * `priceHistory`, and free-form `tags`.
 */
export const subscriptionV2Schema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1, "name is required"),
    provider: z.string(),
    category: z.string(),
    amountMinor: minorUnits,
    currency: z.string().min(1),
    billingCycle: billingCycleSchema,
    customInterval: customIntervalSchema.optional(),
    nextRenewal: isoDate,
    startDate: isoDate,
    paymentMethod: z.string(),
    website: z.string(),
    notes: z.string(),
    color: z.string(),
    icon: z.string(),
    state: subscriptionStateSchema,
    trial: trialSchema.optional(),
    priceHistory: z.array(priceEntrySchema),
    tags: z.array(z.string()),
    autoRenew: z.boolean(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  })
  .superRefine((sub, ctx) => {
    // A Custom billing cycle requires a custom interval (Req 5.4, carried over).
    if (sub.billingCycle === "Custom" && sub.customInterval === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "customInterval is required when billingCycle is 'Custom'",
        path: ["customInterval"],
      });
    }
    // A trial is embedded only when the subscription is in the Trial state.
    if (sub.state === "Trial" && sub.trial === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "trial is required when state is 'Trial'",
        path: ["trial"],
      });
    }
    if (sub.state !== "Trial" && sub.trial !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "trial must be absent unless state is 'Trial'",
        path: ["trial"],
      });
    }
  });

/** Root file shape for `subscriptions.json` under schema v2 (`version: 2`). */
export const subscriptionsFileV2Schema = z.object({
  version: z.literal(2),
  subscriptions: z.array(subscriptionV2Schema),
});

/** Opt-in online-feature toggles (AD-22). */
export const onlineSettingsV2Schema = z.object({
  liveLogoFetch: z.boolean(),
  fxRefresh: z.boolean(),
});

/** v2 Settings validator: `homeCurrency` + the `online` block (AD-22). */
export const settingsV2Schema = z.object({
  homeCurrency: z.string().min(1),
  notification: z.object({
    enabled: z.boolean(),
    leadTimes: z.array(reminderLeadTimeSchema),
  }),
  backupFrequency: z.enum(["off", "daily", "weekly"]),
  theme: z.enum(["dark", "light", "system"]),
  accentColor: z.string(),
  trayMode: z.boolean(),
  dataFolder: z.string().nullable(),
  online: onlineSettingsV2Schema,
});

/** Root file shape for `settings.json` under schema v2 (`version: 2`). */
export const settingsFileV2Schema = settingsV2Schema.extend({
  version: z.literal(2),
});

// --- Defaults (Req 1.5, 6.3, 7.1, 14.4) --------------------------------------

/**
 * Default categories created when `categories.json` is first initialized
 * (Req 7.1). Order matches the requirements/design exactly.
 */
export const DEFAULT_CATEGORIES: readonly string[] = [
  "Entertainment",
  "Productivity",
  "Cloud Hosting",
  "Streaming",
  "AI",
  "Music",
  "Gaming",
  "Fitness",
  "Utilities",
  "Education",
  "Development",
];

/**
 * Default settings applied on first run (Req 6.3, 14.4): dark theme,
 * INR currency, weekly backup, notifications enabled with all lead times.
 */
export const DEFAULT_SETTINGS: Settings = {
  defaultCurrency: "INR", // Req 6.3
  notification: {
    enabled: true,
    leadTimes: ["same-day", "one-day", "three-days"],
  },
  backupFrequency: "weekly",
  theme: "dark", // dark-first default (Req 14.4)
  accentColor: "#7C5CFF",
  trayMode: false,
  dataFolder: null,
};

// --- Compile-time alignment checks (no runtime cost) -------------------------
// These ensure the zod schemas stay in lockstep with the TypeScript interfaces
// in `core/models/*`. They are never executed; a divergence is a type error.

/* eslint-disable @typescript-eslint/no-unused-vars */
function _assertSchemaAlignment(): void {
  const _billingCycle: BillingCycle = "Monthly" as z.infer<typeof billingCycleSchema>;
  const _leadTime: ReminderLeadTime = "same-day" as z.infer<typeof reminderLeadTimeSchema>;

  const _customIn = {} as z.infer<typeof customIntervalSchema>;
  const _custom: CustomInterval = _customIn;

  const _subIn = {} as z.infer<typeof subscriptionSchema>;
  const _sub: Subscription = _subIn;
  const _subBack: z.infer<typeof subscriptionSchema> = {} as Subscription;

  const _subsFile: SubscriptionsFile = {} as z.infer<typeof subscriptionsFileSchema>;

  const _settingsIn = {} as z.infer<typeof settingsSchema>;
  const _settings: Settings = _settingsIn;
  const _settingsBack: z.infer<typeof settingsSchema> = {} as Settings;
  const _settingsFile: SettingsFile = {} as z.infer<typeof settingsFileSchema>;

  const _catIn = {} as z.infer<typeof categorySchema>;
  const _cat: Category = _catIn;
  const _catBack: z.infer<typeof categorySchema> = {} as Category;
  const _catsFile: CategoriesFile = {} as z.infer<typeof categoriesFileSchema>;

  // v2 lockstep: the v2 zod schemas and the v2 interfaces must agree both ways.
  const _state: SubscriptionState = "Active" as z.infer<typeof subscriptionStateSchema>;
  const _stateBack: z.infer<typeof subscriptionStateSchema> = "Active" as SubscriptionState;

  const _trialIn = {} as z.infer<typeof trialSchema>;
  const _trial: TrialV2 = _trialIn;
  const _trialBack: z.infer<typeof trialSchema> = {} as TrialV2;

  const _priceIn = {} as z.infer<typeof priceEntrySchema>;
  const _price: PriceEntryV2 = _priceIn;
  const _priceBack: z.infer<typeof priceEntrySchema> = {} as PriceEntryV2;

  const _subV2In = {} as z.infer<typeof subscriptionV2Schema>;
  const _subV2: SubscriptionV2 = _subV2In;
  const _subV2Back: z.infer<typeof subscriptionV2Schema> = {} as SubscriptionV2;
  const _subsFileV2: SubscriptionsFileV2 = {} as z.infer<typeof subscriptionsFileV2Schema>;
  const _subsFileV2Back: z.infer<typeof subscriptionsFileV2Schema> = {} as SubscriptionsFileV2;

  const _onlineIn = {} as z.infer<typeof onlineSettingsV2Schema>;
  const _online: OnlineSettingsV2 = _onlineIn;
  const _onlineBack: z.infer<typeof onlineSettingsV2Schema> = {} as OnlineSettingsV2;

  const _settingsV2In = {} as z.infer<typeof settingsV2Schema>;
  const _settingsV2: SettingsV2 = _settingsV2In;
  const _settingsV2Back: z.infer<typeof settingsV2Schema> = {} as SettingsV2;
  const _settingsFileV2: SettingsFileV2 = {} as z.infer<typeof settingsFileV2Schema>;
  const _settingsFileV2Back: z.infer<typeof settingsFileV2Schema> = {} as SettingsFileV2;

  void [
    _billingCycle,
    _leadTime,
    _custom,
    _sub,
    _subBack,
    _subsFile,
    _settings,
    _settingsBack,
    _settingsFile,
    _cat,
    _catBack,
    _catsFile,
    _state,
    _stateBack,
    _trial,
    _trialBack,
    _price,
    _priceBack,
    _subV2,
    _subV2Back,
    _subsFileV2,
    _subsFileV2Back,
    _online,
    _onlineBack,
    _settingsV2,
    _settingsV2Back,
    _settingsFileV2,
    _settingsFileV2Back,
  ];
}
void _assertSchemaAlignment;
/* eslint-enable @typescript-eslint/no-unused-vars */
