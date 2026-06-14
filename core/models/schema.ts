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
import type { ReminderLeadTime, Settings, SettingsFile } from "core/models/settings";
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
  ];
}
void _assertSchemaAlignment;
/* eslint-enable @typescript-eslint/no-unused-vars */
