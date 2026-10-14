/**
 * Add / Edit subscription modal (Story 3.3; Req 3.5, 3.6, 4.1, 4.2, 4.3, 4.4,
 * AD-17, AD-18).
 *
 * A single accessible modal dialog used for BOTH creating and editing a
 * {@link SubscriptionV2}:
 *
 *   - CREATE mode (no `subscription` prop): all fields start empty/sensible, and
 *     the currency is pre-filled from {@link settingsStore}.homeCurrency (Req
 *     4.3). On save it calls `subscriptionsApi.create(input)` with a
 *     {@link SubscriptionInputV2}: a user-entered MAJOR amount string plus the
 *     Native currency (core parses it into integer `amountMinor` via the money
 *     seam and assigns id/createdAt/updatedAt).
 *   - EDIT mode (`subscription` provided): every field is pre-populated from the
 *     subscription's current values, the stored `amountMinor` rendered back to a
 *     major string via `toMajor` (Req 4.2). On save it calls
 *     `subscriptionsApi.update(id, patch)` with a v2 patch (`amountMinor` parsed
 *     from the entered major amount), preserving every untouched field including
 *     `priceHistory`/`tags`/`trial`.
 *
 * State (AD-17): the old `isActive` boolean toggle is replaced by a **segmented
 * State control** — an accessible `radiogroup` of Active / Paused / Trial, each
 * a text-labelled option. Selecting Trial reveals a minimal trial block (end
 * date + post-trial amount) so the v2 schema invariant holds (`trial` present
 * iff state === 'Trial'); non-Trial states carry no `trial`. The full Epic-5
 * trial setup/conversion is out of scope.
 *
 * The form exposes inputs for every editable field (Req 4.1) and a custom-
 * interval control shown only when the billing cycle is "Custom". Client-side
 * validation mirrors {@link subscriptionV2Schema}: a non-empty name (Req 3.5),
 * a non-negative amount parsed through `core/money.minorUnits` (Req 3.6), a
 * positive-integer custom interval, and a valid minimal trial when state ===
 * 'Trial'. Inline messages name the offending field.
 *
 * Cancel (the Cancel button, the backdrop, or Escape) closes WITHOUT persisting
 * (Req 4.4). Any {@link SubbyError} from the bridge is caught and shown inline
 * so the modal never crashes (Req 19.4).
 *
 * Accessibility: `role="dialog"` + `aria-modal`, a labelled title, initial focus
 * on the first field, Escape to close, focus return to the previously focused
 * element, a simple focus trap, and visible focus rings (Req 22.1, 22.3).
 */

import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";

import type {
  BillingCycle,
  CustomInterval,
  SubscriptionState,
  SubscriptionV2,
  TrialV2,
} from "core/models/subscription";
import { minorUnits, toMajor } from "core/money";
import type { SubscriptionInputV2 } from "shared/types";
import { cn } from "@/lib/utils";
import {
  categoriesApi,
  isSubbyError,
  subscriptionsApi,
  toAppError,
} from "@/api/subby";
import TagEditor from "@/components/TagEditor";
import { categoriesStore } from "@/stores/categoriesStore";
import { settingsStore } from "@/stores/settingsStore";
import { errorStore } from "@/stores/errorStore";
import { useStoreData } from "@/stores/hooks";

// --- Constants ---------------------------------------------------------------

/** The six billing cycles (design: Billing_Cycle). */
const BILLING_CYCLES: readonly BillingCycle[] = [
  "Weekly",
  "Monthly",
  "Quarterly",
  "Half-Yearly",
  "Yearly",
  "Custom",
];

/** Units for a custom billing interval (mirrors {@link customIntervalSchema}). */
const CUSTOM_UNITS: readonly CustomInterval["unit"][] = [
  "day",
  "week",
  "month",
  "year",
];

/** The three-way State options for the segmented control (AD-17). */
const STATES: readonly SubscriptionState[] = ["Active", "Paused", "Trial"];

/** Default custom interval used until the user edits it. */
const DEFAULT_CUSTOM_INTERVAL: CustomInterval = { unit: "month", count: 1 };

/** Shared focus-ring utility, consistent with the app shell (Req 22.1, 22.3). */
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/** Shared input/select styling tokens. */
const CONTROL_CLASS = cn(
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground",
  FOCUS_RING,
);

/** Today's date as `YYYY-MM-DD` for sensible create-mode date defaults. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// --- Form state --------------------------------------------------------------

/**
 * Editable form state. Monetary fields (`amount`, `trialPostAmount`) and the
 * custom-interval `count` are kept as strings so the user can type freely; they
 * are parsed/validated on submit.
 */
interface FormState {
  name: string;
  provider: string;
  category: string;
  amount: string; // major-unit string
  currency: string;
  billingCycle: BillingCycle;
  customUnit: CustomInterval["unit"];
  customCount: string;
  nextRenewal: string;
  startDate: string;
  paymentMethod: string;
  website: string;
  notes: string;
  color: string;
  icon: string;
  state: SubscriptionState;
  autoRenew: boolean;
  // Free-form tags, edited via the TagEditor (de-duplicated by core helpers).
  tags: string[];
  // Minimal trial fields (used only when state === 'Trial').
  trialEndDate: string;
  trialPostAmount: string; // major-unit string
}

/** Per-field validation messages (only populated for fields that fail). */
interface FieldErrors {
  name?: string;
  amount?: string;
  customCount?: string;
  trialEndDate?: string;
  trialPostAmount?: string;
}

/** Build the initial form state for create or edit mode. */
function initialState(
  subscription: SubscriptionV2 | undefined,
  homeCurrency: string,
  defaultColor: string,
): FormState {
  if (subscription) {
    // EDIT: pre-populate from the current subscription (Req 4.2). The stored
    // minor units render back to a major string; the trial fields are seeded
    // from the embedded trial when present.
    const trial = subscription.trial;
    return {
      name: subscription.name,
      provider: subscription.provider,
      category: subscription.category,
      amount: minorToMajor(subscription.amountMinor, subscription.currency),
      currency: subscription.currency,
      billingCycle: subscription.billingCycle,
      customUnit: subscription.customInterval?.unit ?? DEFAULT_CUSTOM_INTERVAL.unit,
      customCount: String(
        subscription.customInterval?.count ?? DEFAULT_CUSTOM_INTERVAL.count,
      ),
      nextRenewal: subscription.nextRenewal,
      startDate: subscription.startDate,
      paymentMethod: subscription.paymentMethod,
      website: subscription.website,
      notes: subscription.notes,
      color: subscription.color,
      icon: subscription.icon,
      state: subscription.state,
      autoRenew: subscription.autoRenew,
      tags: [...subscription.tags],
      trialEndDate: trial?.endDate ?? todayIso(),
      trialPostAmount:
        trial !== undefined
          ? minorToMajor(trial.postAmountMinor, subscription.currency)
          : "",
    };
  }
  // CREATE: empty/sensible defaults; currency from Home Currency (Req 4.3).
  return {
    name: "",
    provider: "",
    category: "",
    amount: "",
    currency: homeCurrency,
    billingCycle: "Monthly",
    customUnit: DEFAULT_CUSTOM_INTERVAL.unit,
    customCount: String(DEFAULT_CUSTOM_INTERVAL.count),
    nextRenewal: todayIso(),
    startDate: todayIso(),
    paymentMethod: "",
    website: "",
    notes: "",
    color: defaultColor,
    icon: "",
    state: "Active",
    autoRenew: true,
    tags: [],
    trialEndDate: todayIso(),
    trialPostAmount: "",
  };
}

/**
 * Render stored minor units back to a major display string for the amount
 * field, falling back to the raw integer when the currency is unknown so an
 * edit-mode open never crashes (validation catches a bad currency on save).
 */
function minorToMajor(minor: number, currency: string): string {
  try {
    return toMajor(minor, currency);
  } catch {
    return String(minor);
  }
}

/**
 * Validate the form, mirroring {@link subscriptionV2Schema}'s field rules.
 * Returns field-level messages that NAME the offending field (Req 3.5, 3.6) and
 * the parsed values when valid: `amountMinor` (integer minor units in the Native
 * currency), the custom interval count, and — when state === 'Trial' — the
 * minimal trial. The amount is parsed through `core/money.minorUnits`, so an
 * invalid/over-precise amount surfaces as an inline error and nothing persists.
 */
function validate(form: FormState): {
  errors: FieldErrors;
  amountMinor: number;
  customCount: number;
  trial: TrialV2 | undefined;
} {
  const errors: FieldErrors = {};

  // Non-empty name (Req 3.5).
  if (form.name.trim() === "") {
    errors.name = "Name is required.";
  }

  // Non-negative amount parsed into minor units (Req 3.6). An empty string or a
  // value the money seam rejects (negative, over-precise, unknown currency) is
  // an inline error.
  let amountMinor = 0;
  if (form.amount.trim() === "") {
    errors.amount = "Amount must be a non-negative number.";
  } else {
    try {
      amountMinor = minorUnits(form.amount.trim(), form.currency);
    } catch {
      errors.amount = "Enter a valid amount for this currency.";
    }
  }

  // A Custom cycle needs a positive-integer interval count (mirrors zod).
  const customCount = Number(form.customCount);
  if (
    form.billingCycle === "Custom" &&
    (!Number.isInteger(customCount) || customCount <= 0)
  ) {
    errors.customCount = "Interval count must be a positive whole number.";
  }

  // A Trial state requires a minimal trial (end date + post-trial amount) so the
  // v2 schema invariant holds (AD-17, AD-18 — months unrepresentable; an end
  // date is used). Non-Trial states carry no trial.
  let trial: TrialV2 | undefined;
  if (form.state === "Trial") {
    let postAmountMinor = 0;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.trialEndDate)) {
      errors.trialEndDate = "Enter a valid trial end date.";
    }
    if (form.trialPostAmount.trim() === "") {
      errors.trialPostAmount = "Enter the amount charged after the trial.";
    } else {
      try {
        postAmountMinor = minorUnits(form.trialPostAmount.trim(), form.currency);
      } catch {
        errors.trialPostAmount = "Enter a valid post-trial amount.";
      }
    }
    if (
      errors.trialEndDate === undefined &&
      errors.trialPostAmount === undefined
    ) {
      trial = { endDate: form.trialEndDate, postAmountMinor };
    }
  }

  return { errors, amountMinor, customCount, trial };
}

// --- Props -------------------------------------------------------------------

export interface SubscriptionModalProps {
  /** Whether the modal is rendered/open. */
  open: boolean;
  /** Close handler — invoked on cancel, backdrop click, Escape, or save success. */
  onClose: () => void;
  /** When provided, the modal is in EDIT mode pre-populated from this value (Req 4.2). */
  subscription?: SubscriptionV2;
}

// --- Component ---------------------------------------------------------------

export default function SubscriptionModal({
  open,
  onClose,
  subscription,
}: SubscriptionModalProps): JSX.Element | null {
  const categories = useStoreData(categoriesStore);
  const settings = useStoreData(settingsStore);

  const isEdit = subscription !== undefined;
  const titleId = useId();
  const stateGroupId = useId();

  const [form, setForm] = useState<FormState>(() =>
    initialState(subscription, settings.homeCurrency, settings.accentColor),
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Inline "+ add new" category affordance next to the Category select: when
  // open, a small labelled input creates a category via `categoriesApi.create`
  // and selects the result WITHOUT leaving the modal. Its own inline error echoes
  // a duplicate name.
  const [addingCategory, setAddingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const newCategoryRef = useRef<HTMLInputElement>(null);

  const firstFieldRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  /**
   * Re-seed the form whenever the modal opens or the target subscription /
   * relevant defaults change, so EDIT pre-population (Req 4.2) and CREATE
   * currency pre-fill (Req 4.3) are always fresh on open.
   */
  useEffect(() => {
    if (!open) return;
    setForm(
      initialState(subscription, settings.homeCurrency, settings.accentColor),
    );
    setErrors({});
    setSubmitError(null);
    setAddingCategory(false);
    setNewCategoryName("");
    setCategoryError(null);
    // We intentionally re-seed only on (re)open or identity change of the
    // target subscription, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, subscription]);

  /** Focus management: focus the first field on open, return focus on close. */
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current =
      (document.activeElement as HTMLElement | null) ?? null;
    // Focus the first field after paint.
    const id = window.setTimeout(() => firstFieldRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(id);
      // Return focus to whatever was focused before the modal opened.
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  /** Patch a single form field. */
  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  /**
   * Create a category inline and select it on the Category field, without
   * leaving the modal (Story 3.4). A duplicate name (case-insensitive, trimmed)
   * surfaces as an inline error echoing the existing name; the store reloads via
   * the `onDataChanged` broadcast so the new option appears in the select.
   */
  async function createAndSelectCategory(): Promise<void> {
    const name = newCategoryName.trim();
    if (name === "") return;
    setCategoryError(null);
    try {
      const { created } = await categoriesApi.create(name);
      set("category", created.name);
      setAddingCategory(false);
      setNewCategoryName("");
    } catch (err) {
      // Inline-resolvable failures (duplicate name → `conflict`, bad name →
      // `validation`) show inline next to the field; system failures
      // (io/corrupt/unknown) go to the global error surface instead.
      const appError = toAppError(err);
      if (
        isSubbyError(err) &&
        (appError.code === "conflict" || appError.code === "validation")
      ) {
        setCategoryError(appError.message);
      } else {
        errorStore.set(appError);
      }
    }
  }

  /**
   * Build the editable payload shared by create (input) and update (patch). The
   * entered major amount is carried as `amountMajor` for create (core parses it)
   * and as a pre-parsed `amountMinor` for update. The trial block is included
   * only when state === 'Trial'.
   */
  function buildInput(trial: TrialV2 | undefined, customCount: number): SubscriptionInputV2 {
    return {
      name: form.name.trim(),
      provider: form.provider.trim(),
      category: form.category,
      amountMajor: form.amount.trim(),
      currency: form.currency,
      billingCycle: form.billingCycle,
      // Only a Custom cycle carries a custom interval; otherwise clear it.
      customInterval:
        form.billingCycle === "Custom"
          ? { unit: form.customUnit, count: customCount }
          : undefined,
      nextRenewal: form.nextRenewal,
      startDate: form.startDate,
      paymentMethod: form.paymentMethod.trim(),
      website: form.website.trim(),
      notes: form.notes,
      color: form.color,
      icon: form.icon.trim(),
      state: form.state,
      trial,
      // `priceHistory` is not edited here; `tags` ARE edited via the TagEditor
      // (already trimmed + de-duplicated by core helpers) and carried through.
      priceHistory: subscription?.priceHistory ?? [],
      tags: form.tags,
      autoRenew: form.autoRenew,
    };
  }

  /** Validate, then create or update; close on success (Req 3.1, 3.2, 4.4). */
  async function handleSubmit(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setSubmitError(null);

    const { errors: nextErrors, amountMinor, customCount, trial } = validate(form);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSaving(true);
    try {
      if (isEdit) {
        // EDIT: a v2 patch carrying the pre-parsed minor units and the resolved
        // trial, preserving every untouched field (priceHistory/tags/etc.).
        await subscriptionsApi.update(subscription.id, {
          name: form.name.trim(),
          provider: form.provider.trim(),
          category: form.category,
          amountMinor,
          currency: form.currency,
          billingCycle: form.billingCycle,
          customInterval:
            form.billingCycle === "Custom"
              ? { unit: form.customUnit, count: customCount }
              : undefined,
          nextRenewal: form.nextRenewal,
          startDate: form.startDate,
          paymentMethod: form.paymentMethod.trim(),
          website: form.website.trim(),
          notes: form.notes,
          color: form.color,
          icon: form.icon.trim(),
          state: form.state,
          trial,
          tags: form.tags,
          autoRenew: form.autoRenew,
        });
      } else {
        await subscriptionsApi.create(buildInput(trial, customCount));
      }
      onClose();
    } catch (err) {
      // Surface a friendly inline error; if the bridge named a field, attach
      // the message to that field as well (Req 19.4, 3.5, 3.6).
      const appError = toAppError(err);
      if (isSubbyError(err) && appError.field) {
        setErrors((prev) => ({ ...prev, [appError.field as string]: appError.message }));
      }
      setSubmitError(appError.message);
    } finally {
      setSaving(false);
    }
  }

  /** Escape closes without persisting (Req 4.4). */
  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    // Minimal focus trap: keep Tab within the dialog.
    if (event.key === "Tab") {
      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  const title = isEdit ? "Edit subscription" : "Add subscription";

  return (
    <div
      // Backdrop: clicking it cancels without persisting (Req 4.4).
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={handleKeyDown}
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 id={titleId} className="text-lg font-semibold tracking-tight">
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className={cn(
              "inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
              FOCUS_RING,
            )}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* Body (scrollable form) */}
        <form
          onSubmit={(e) => void handleSubmit(e)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-auto px-6 py-5 sm:grid-cols-2">
            {/* Name */}
            <Field label="Name" htmlFor="sub-name" required error={errors.name}>
              <input
                id="sub-name"
                ref={firstFieldRef}
                type="text"
                className={CONTROL_CLASS}
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                aria-invalid={errors.name ? true : undefined}
                aria-describedby={errors.name ? "sub-name-error" : undefined}
              />
            </Field>

            {/* Provider */}
            <Field label="Provider" htmlFor="sub-provider">
              <input
                id="sub-provider"
                type="text"
                className={CONTROL_CLASS}
                value={form.provider}
                onChange={(e) => set("provider", e.target.value)}
              />
            </Field>

            {/* Category — with an inline "+ add new" affordance (Story 3.4). */}
            <Field label="Category" htmlFor="sub-category">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <select
                    id="sub-category"
                    className={CONTROL_CLASS}
                    value={form.category}
                    onChange={(e) => set("category", e.target.value)}
                  >
                    <option value="">Uncategorized</option>
                    {/* Keep the current value selectable even if it is no longer a known category. */}
                    {form.category !== "" &&
                      !categories.some((c) => c.name === form.category) && (
                        <option value={form.category}>{form.category}</option>
                      )}
                    {categories.map((c) => (
                      <option key={c.id} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => {
                      setAddingCategory(true);
                      setCategoryError(null);
                      window.setTimeout(() => newCategoryRef.current?.focus(), 0);
                    }}
                    className={cn(
                      "inline-flex shrink-0 items-center rounded-md border border-input bg-background px-2.5 py-2 text-sm font-medium text-foreground hover:bg-secondary/60",
                      FOCUS_RING,
                    )}
                  >
                    + Add new
                  </button>
                </div>
                {addingCategory && (
                  <div className="space-y-1.5">
                    <label
                      htmlFor="sub-new-category"
                      className="block text-sm font-medium text-foreground"
                    >
                      New category name
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        id="sub-new-category"
                        ref={newCategoryRef}
                        type="text"
                        className={CONTROL_CLASS}
                        value={newCategoryName}
                        onChange={(e) => setNewCategoryName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void createAndSelectCategory();
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            e.stopPropagation();
                            setAddingCategory(false);
                            setNewCategoryName("");
                            setCategoryError(null);
                          }
                        }}
                        aria-invalid={categoryError ? true : undefined}
                        aria-describedby={
                          categoryError ? "sub-new-category-error" : undefined
                        }
                      />
                      <button
                        type="button"
                        onClick={() => void createAndSelectCategory()}
                        className={cn(
                          "inline-flex shrink-0 items-center rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground hover:opacity-90",
                          FOCUS_RING,
                        )}
                      >
                        Add
                      </button>
                    </div>
                    {categoryError && (
                      <p
                        id="sub-new-category-error"
                        role="alert"
                        className="text-sm text-destructive"
                      >
                        {categoryError}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </Field>

            {/* Amount */}
            <Field
              label="Amount"
              htmlFor="sub-amount"
              required
              error={errors.amount}
            >
              <input
                id="sub-amount"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                className={CONTROL_CLASS}
                value={form.amount}
                onChange={(e) => set("amount", e.target.value)}
                aria-invalid={errors.amount ? true : undefined}
                aria-describedby={errors.amount ? "sub-amount-error" : undefined}
              />
            </Field>

            {/* Currency */}
            <Field label="Currency" htmlFor="sub-currency">
              <input
                id="sub-currency"
                type="text"
                className={CONTROL_CLASS}
                value={form.currency}
                onChange={(e) => set("currency", e.target.value)}
              />
            </Field>

            {/* Billing cycle */}
            <Field label="Billing cycle" htmlFor="sub-cycle">
              <select
                id="sub-cycle"
                className={CONTROL_CLASS}
                value={form.billingCycle}
                onChange={(e) =>
                  set("billingCycle", e.target.value as BillingCycle)
                }
              >
                {BILLING_CYCLES.map((cycle) => (
                  <option key={cycle} value={cycle}>
                    {cycle}
                  </option>
                ))}
              </select>
            </Field>

            {/* Custom interval — only when billingCycle === "Custom". */}
            {form.billingCycle === "Custom" && (
              <Field
                label="Custom interval"
                htmlFor="sub-custom-count"
                error={errors.customCount}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Every</span>
                  <input
                    id="sub-custom-count"
                    type="number"
                    min={1}
                    step={1}
                    className={cn(CONTROL_CLASS, "w-20")}
                    value={form.customCount}
                    onChange={(e) => set("customCount", e.target.value)}
                    aria-invalid={errors.customCount ? true : undefined}
                    aria-describedby={
                      errors.customCount ? "sub-custom-count-error" : undefined
                    }
                  />
                  <select
                    aria-label="Custom interval unit"
                    className={cn(CONTROL_CLASS, "w-28")}
                    value={form.customUnit}
                    onChange={(e) =>
                      set("customUnit", e.target.value as CustomInterval["unit"])
                    }
                  >
                    {CUSTOM_UNITS.map((unit) => (
                      <option key={unit} value={unit}>
                        {unit}
                        {Number(form.customCount) === 1 ? "" : "s"}
                      </option>
                    ))}
                  </select>
                </div>
              </Field>
            )}

            {/* Next renewal */}
            <Field label="Next renewal" htmlFor="sub-next-renewal">
              <input
                id="sub-next-renewal"
                type="date"
                className={CONTROL_CLASS}
                value={form.nextRenewal}
                onChange={(e) => set("nextRenewal", e.target.value)}
              />
            </Field>

            {/* Start date */}
            <Field label="Start date" htmlFor="sub-start-date">
              <input
                id="sub-start-date"
                type="date"
                className={CONTROL_CLASS}
                value={form.startDate}
                onChange={(e) => set("startDate", e.target.value)}
              />
            </Field>

            {/* Payment method */}
            <Field label="Payment method" htmlFor="sub-payment">
              <input
                id="sub-payment"
                type="text"
                className={CONTROL_CLASS}
                value={form.paymentMethod}
                onChange={(e) => set("paymentMethod", e.target.value)}
              />
            </Field>

            {/* Website */}
            <Field label="Website" htmlFor="sub-website">
              <input
                id="sub-website"
                type="text"
                className={CONTROL_CLASS}
                value={form.website}
                onChange={(e) => set("website", e.target.value)}
              />
            </Field>

            {/* Color */}
            <Field label="Color" htmlFor="sub-color">
              <div className="flex items-center gap-3">
                <input
                  id="sub-color"
                  type="color"
                  className={cn(
                    "h-9 w-16 cursor-pointer rounded-md border border-input bg-background",
                    FOCUS_RING,
                  )}
                  value={form.color}
                  onChange={(e) => set("color", e.target.value)}
                />
                <span className="text-sm text-muted-foreground">
                  {form.color}
                </span>
              </div>
            </Field>

            {/* Icon */}
            <Field label="Icon" htmlFor="sub-icon">
              <input
                id="sub-icon"
                type="text"
                placeholder="lucide icon key or provider slug"
                className={CONTROL_CLASS}
                value={form.icon}
                onChange={(e) => set("icon", e.target.value)}
              />
            </Field>

            {/* State — segmented Active / Paused / Trial radiogroup (AD-17). */}
            <div className="sm:col-span-2">
              <StateControl
                groupId={stateGroupId}
                value={form.state}
                onChange={(next) => set("state", next)}
              />
            </div>

            {/* Trial reveal — only when state === "Trial" (AD-18 minimal fields). */}
            {form.state === "Trial" && (
              <>
                <Field
                  label="Trial end date"
                  htmlFor="sub-trial-end"
                  required
                  error={errors.trialEndDate}
                >
                  <input
                    id="sub-trial-end"
                    type="date"
                    className={CONTROL_CLASS}
                    value={form.trialEndDate}
                    onChange={(e) => set("trialEndDate", e.target.value)}
                    aria-invalid={errors.trialEndDate ? true : undefined}
                    aria-describedby={
                      errors.trialEndDate ? "sub-trial-end-error" : undefined
                    }
                  />
                </Field>
                <Field
                  label="Amount after trial"
                  htmlFor="sub-trial-amount"
                  required
                  error={errors.trialPostAmount}
                >
                  <input
                    id="sub-trial-amount"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    className={CONTROL_CLASS}
                    value={form.trialPostAmount}
                    onChange={(e) => set("trialPostAmount", e.target.value)}
                    aria-invalid={errors.trialPostAmount ? true : undefined}
                    aria-describedby={
                      errors.trialPostAmount ? "sub-trial-amount-error" : undefined
                    }
                  />
                </Field>
              </>
            )}

            {/* Tags (full width) — add/remove chips, de-duplicated by core. */}
            <div className="sm:col-span-2">
              <TagEditor
                tags={form.tags}
                onChange={(tags) => set("tags", tags)}
              />
            </div>

            {/* Notes (full width) */}
            <div className="sm:col-span-2">
              <Field label="Notes" htmlFor="sub-notes">
                <textarea
                  id="sub-notes"
                  rows={3}
                  className={cn(CONTROL_CLASS, "resize-y")}
                  value={form.notes}
                  onChange={(e) => set("notes", e.target.value)}
                />
              </Field>
            </div>

            {/* Auto-renew toggle */}
            <Toggle
              id="sub-auto-renew"
              label="Auto-renew"
              checked={form.autoRenew}
              onChange={(checked) => set("autoRenew", checked)}
            />
          </div>

          {/* Inline submit error (Req 19.4). */}
          {submitError && (
            <p
              role="alert"
              className="px-6 text-sm text-destructive"
            >
              {submitError}
            </p>
          )}

          {/* Footer actions */}
          <div className="flex items-center justify-end gap-3 border-t border-border px-6 py-4">
            <button
              type="button"
              onClick={onClose}
              className={cn(
                "inline-flex items-center rounded-lg border border-input bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary/60",
                FOCUS_RING,
              )}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className={cn(
                "inline-flex items-center rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50",
                FOCUS_RING,
              )}
            >
              {saving ? "Saving…" : isEdit ? "Save changes" : "Add subscription"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// --- Small presentational helpers -------------------------------------------

/** A labelled field with optional required marker and inline error message. */
function Field({
  label,
  htmlFor,
  required,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      <label
        htmlFor={htmlFor}
        className="block text-sm font-medium text-foreground"
      >
        {label}
        {required && (
          <span className="ml-0.5 text-destructive" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {children}
      {error && (
        <p id={`${htmlFor}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The segmented three-way State control (AD-17): an accessible `radiogroup` of
 * text-labelled Active / Paused / Trial options. Each option is a real
 * `role="radio"` button reached by Tab (each is a focusable button; there is no
 * roving tabindex, so Arrow keys do not move selection) and selected with
 * Space/Enter (native button activation), with a visible focus ring. State is
 * conveyed by its TEXT label, never color alone.
 */
function StateControl({
  groupId,
  value,
  onChange,
}: {
  groupId: string;
  value: SubscriptionState;
  onChange: (next: SubscriptionState) => void;
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      <span id={`${groupId}-label`} className="block text-sm font-medium text-foreground">
        State
      </span>
      <div
        role="radiogroup"
        aria-labelledby={`${groupId}-label`}
        className="inline-flex rounded-md border border-input p-0.5"
      >
        {STATES.map((option) => {
          const selected = value === option;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(option)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                FOCUS_RING,
                selected
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** An accessible switch-style boolean toggle backed by a checkbox. */
function Toggle({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <label
      htmlFor={id}
      className="flex cursor-pointer items-center justify-between gap-4 rounded-md border border-border bg-background px-3 py-2"
    >
      <span className="text-sm font-medium text-foreground">{label}</span>
      <span className="relative inline-flex shrink-0">
        <input
          id={id}
          type="checkbox"
          role="switch"
          className={cn("peer sr-only", FOCUS_RING)}
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span
          aria-hidden="true"
          className="h-6 w-11 rounded-full bg-input transition-colors peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background"
        />
        <span
          aria-hidden="true"
          className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-background shadow transition-transform peer-checked:translate-x-5"
        />
      </span>
    </label>
  );
}
