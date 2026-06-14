/**
 * Add / Edit subscription modal (task 19.1, Req 3.5, 3.6, 4.1, 4.2, 4.3, 4.4).
 *
 * A single accessible modal dialog used for BOTH creating and editing a
 * {@link Subscription}:
 *
 *   - CREATE mode (no `subscription` prop): all fields start empty/sensible,
 *     and the currency is pre-filled from {@link settingsStore}.defaultCurrency
 *     (Req 4.3). On save it calls `subscriptionsApi.create(input)` with a
 *     {@link SubscriptionInput} (no id/createdAt/updatedAt — those are assigned
 *     by core).
 *   - EDIT mode (`subscription` provided): every field is pre-populated with the
 *     subscription's current values (Req 4.2). On save it calls
 *     `subscriptionsApi.update(id, patch)`.
 *
 * The form exposes inputs for every editable Subscription field (Req 4.1) and a
 * custom-interval control shown only when the billing cycle is "Custom"
 * (design: Add/Edit Modal). Client-side validation mirrors
 * {@link subscriptionSchema}: a non-empty name (Req 3.5) and a non-negative
 * numeric amount (Req 3.6); inline messages name the offending field.
 *
 * Cancel (the Cancel button, the backdrop, or Escape) closes WITHOUT persisting
 * (Req 4.4). Any {@link SubbyError} from the bridge is caught and shown inline
 * so the modal never crashes (Req 19.4).
 *
 * Accessibility: `role="dialog"` + `aria-modal`, a labelled title, initial
 * focus on the first field, Escape to close, focus return to the previously
 * focused element, a simple focus trap, and visible focus rings (Req 22.1, 22.3).
 */

import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";

import type {
  BillingCycle,
  CustomInterval,
  Subscription,
} from "core/models/subscription";
import type { SubscriptionInput } from "shared/types";
import { cn } from "@/lib/utils";
import { isSubbyError, subscriptionsApi, toAppError } from "@/api/subby";
import { categoriesStore } from "@/stores/categoriesStore";
import { settingsStore } from "@/stores/settingsStore";
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
 * Editable form state. `amount` and the custom-interval `count` are kept as
 * strings so the user can type freely; they are parsed/validated on submit.
 */
interface FormState {
  name: string;
  provider: string;
  category: string;
  amount: string;
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
  isActive: boolean;
  autoRenew: boolean;
}

/** Per-field validation messages (only populated for fields that fail). */
interface FieldErrors {
  name?: string;
  amount?: string;
  customCount?: string;
}

/** Build the initial form state for create or edit mode. */
function initialState(
  subscription: Subscription | undefined,
  defaultCurrency: string,
  defaultColor: string,
): FormState {
  if (subscription) {
    // EDIT: pre-populate from the current subscription (Req 4.2).
    return {
      name: subscription.name,
      provider: subscription.provider,
      category: subscription.category,
      amount: String(subscription.amount),
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
      isActive: subscription.isActive,
      autoRenew: subscription.autoRenew,
    };
  }
  // CREATE: empty/sensible defaults; currency from settings (Req 4.3).
  return {
    name: "",
    provider: "",
    category: "",
    amount: "",
    currency: defaultCurrency,
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
    isActive: true,
    autoRenew: true,
  };
}

/**
 * Validate the form, mirroring {@link subscriptionSchema}'s field rules. Returns
 * field-level messages that NAME the offending field (Req 3.5, 3.6) and the
 * parsed numeric values when valid.
 */
function validate(form: FormState): {
  errors: FieldErrors;
  amount: number;
  customCount: number;
} {
  const errors: FieldErrors = {};

  // Non-empty name (Req 3.5).
  if (form.name.trim() === "") {
    errors.name = "Name is required.";
  }

  // Non-negative finite numeric amount (Req 3.6).
  const amount = Number(form.amount);
  if (form.amount.trim() === "" || !Number.isFinite(amount) || amount < 0) {
    errors.amount = "Amount must be a non-negative number.";
  }

  // A Custom cycle needs a positive-integer interval count (mirrors zod).
  const customCount = Number(form.customCount);
  if (
    form.billingCycle === "Custom" &&
    (!Number.isInteger(customCount) || customCount <= 0)
  ) {
    errors.customCount = "Interval count must be a positive whole number.";
  }

  return { errors, amount, customCount };
}

// --- Props -------------------------------------------------------------------

export interface SubscriptionModalProps {
  /** Whether the modal is rendered/open. */
  open: boolean;
  /** Close handler — invoked on cancel, backdrop click, Escape, or save success. */
  onClose: () => void;
  /** When provided, the modal is in EDIT mode pre-populated from this value (Req 4.2). */
  subscription?: Subscription;
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

  const [form, setForm] = useState<FormState>(() =>
    initialState(subscription, settings.defaultCurrency, settings.accentColor),
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

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
      initialState(subscription, settings.defaultCurrency, settings.accentColor),
    );
    setErrors({});
    setSubmitError(null);
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

  /** Build the editable payload shared by create (input) and update (patch). */
  function buildPayload(amount: number, customCount: number): SubscriptionInput {
    const base: SubscriptionInput = {
      name: form.name.trim(),
      provider: form.provider.trim(),
      category: form.category,
      amount,
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
      isActive: form.isActive,
      autoRenew: form.autoRenew,
    };
    return base;
  }

  /** Validate, then create or update; close on success (Req 3.1, 3.2, 4.4). */
  async function handleSubmit(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setSubmitError(null);

    const { errors: nextErrors, amount, customCount } = validate(form);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    const payload = buildPayload(amount, customCount);
    setSaving(true);
    try {
      if (isEdit) {
        await subscriptionsApi.update(subscription.id, payload);
      } else {
        await subscriptionsApi.create(payload);
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
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-xl"
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

            {/* Category */}
            <Field label="Category" htmlFor="sub-category">
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

            {/* Toggles */}
            <Toggle
              id="sub-active"
              label="Active"
              checked={form.isActive}
              onChange={(checked) => set("isActive", checked)}
            />
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
                "inline-flex items-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary/60",
                FOCUS_RING,
              )}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className={cn(
                "inline-flex items-center rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50",
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
