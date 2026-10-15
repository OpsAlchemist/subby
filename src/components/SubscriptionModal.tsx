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
 * Price history (Story 5.3; AD-21): in EDIT mode, when the submitted amount
 * differs from the stored amount, the modal OFFERS an opt-in "Record this as a
 * price change" checkbox (shown only then, defaulting checked). When opted in it
 * appends a forward-log {@link PriceEntryV2} (the NEW amount + currency + the
 * renderer's local today) into the `priceHistory` patch via the pure
 * `core/priceHistory.appendPriceEntry` — persisting append-only through the same
 * `subs:update` channel (no new IPC surface). An unchanged amount or an unchecked
 * box records nothing. The modal also renders a READ-ONLY per-subscription price
 * history list (via `PriceHistoryList`) in edit mode.
 *
 * State (AD-17): the old `isActive` boolean toggle is replaced by a **segmented
 * State control** — an accessible `radiogroup` of Active / Paused / Trial, each
 * a text-labelled option. Selecting Trial reveals the trial block so the v2
 * schema invariant holds (`trial` present iff state === 'Trial'); non-Trial
 * states carry no `trial`.
 *
 * Trial length (Story 5.1; AD-18 — months unrepresentable): the reveal offers a
 * two-way choice — "Trial ends on [date]" (an explicit `endDate`) OR "Trial lasts
 * [N] days from [start]" (`startDate` + a whole number of `lengthDays`) —
 * producing the matching schema-valid {@link TrialV2} variant on save. The
 * post-trial amount carries a short dated hint ("$X/mo after {conversionDate}")
 * computed via `core/trial.conversionDate`. The end-date variant is the DEFAULT
 * choice (back-compat with the pre-5.1 behavior).
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
import { trialSchema } from "core/models/schema";
import { conversionDate } from "core/trial";
import { appendPriceEntry, priceChanged } from "core/priceHistory";
import { isSeedStale, type PriceSuggestion } from "core/priceSeed";
import type { SubscriptionInputV2 } from "shared/types";
import { cn } from "@/lib/utils";
import {
  categoriesApi,
  isSubbyError,
  subscriptionsApi,
  suggestPriceSafe,
  toAppError,
} from "@/api/subby";
import PriceHistoryList from "@/components/PriceHistoryList";
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

/**
 * The ~1-year staleness guard for the suggested-price seed (Story 5.4; FR-13).
 * A seed whose `asOf` is strictly MORE than this many days before the local
 * today is stale: its suggestion is shown as a non-filling hint but is NEVER
 * silently auto-filled. 365 days is the "~1yr" guard from the spec.
 */
const SUGGESTION_MAX_AGE_DAYS = 365;

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
  // Opt-in "record this as a price change" toggle (Story 5.3; AD-21). Only
  // meaningful in EDIT mode when the parsed amount differs from the stored
  // amount; the checkbox is shown ONLY then. Defaults CHECKED (recording the
  // change is the common intent), but the user can uncheck to make a correction
  // without polluting the append-only history.
  recordPriceChange: boolean;
  // Free-form tags, edited via the TagEditor (de-duplicated by core helpers).
  tags: string[];
  // Trial fields (used only when state === 'Trial'). The length is specified by
  // ONE of two variants — an explicit end date OR start + a whole number of DAYS
  // (never months) — selected by `trialLengthMode` (AD-18, Story 5.1).
  trialLengthMode: TrialLengthMode;
  trialEndDate: string; // used when trialLengthMode === 'endDate'
  trialStartDate: string; // used when trialLengthMode === 'startDays'
  trialLengthDays: string; // whole-days string; used when trialLengthMode === 'startDays'
  trialPostAmount: string; // major-unit string
}

/** Which trial-length variant the modal is editing (Story 5.1; AD-18). */
type TrialLengthMode = "endDate" | "startDays";

/** Per-field validation messages (only populated for fields that fail). */
interface FieldErrors {
  name?: string;
  amount?: string;
  customCount?: string;
  trialEndDate?: string;
  trialStartDate?: string;
  trialLengthDays?: string;
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
      // Default CHECKED: if the user changes the amount, recording the change is
      // the common intent (Story 5.3 Design Notes). Inert until the amount
      // actually differs (and the checkbox is only shown then).
      recordPriceChange: true,
      tags: [...subscription.tags],
      // Detect the stored variant: a `lengthDays` trial seeds the start+days
      // mode; everything else (endDate variant, or no trial) defaults to the
      // explicit end-date mode (back-compat).
      trialLengthMode:
        trial?.lengthDays !== undefined ? "startDays" : "endDate",
      trialEndDate: trial?.endDate ?? todayIso(),
      trialStartDate: trial?.startDate ?? todayIso(),
      trialLengthDays:
        trial?.lengthDays !== undefined ? String(trial.lengthDays) : "",
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
    recordPriceChange: true,
    tags: [],
    trialLengthMode: "endDate",
    trialEndDate: todayIso(),
    trialStartDate: todayIso(),
    trialLengthDays: "",
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

  // A Trial state requires a valid trial so the v2 schema invariant holds
  // (AD-17, AD-18 — months unrepresentable). The length is specified by ONE of
  // two variants: an explicit end date, OR start + a whole number of DAYS.
  // Non-Trial states carry no trial.
  let trial: TrialV2 | undefined;
  if (form.state === "Trial") {
    // Post-trial amount is common to both variants; parse it through the money
    // seam so an invalid/over-precise value surfaces inline (nothing persists).
    let postAmountMinor = 0;
    let postAmountOk = false;
    if (form.trialPostAmount.trim() === "") {
      errors.trialPostAmount = "Enter the amount charged after the trial.";
    } else {
      try {
        postAmountMinor = minorUnits(form.trialPostAmount.trim(), form.currency);
        postAmountOk = true;
      } catch {
        errors.trialPostAmount = "Enter a valid post-trial amount.";
      }
    }

    if (form.trialLengthMode === "startDays") {
      // start + N whole days. The start date must be a valid ISO date and the
      // length a positive whole number of days (mirrors `trialSchema`).
      let startOk = false;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(form.trialStartDate)) {
        errors.trialStartDate = "Enter a valid trial start date.";
      } else {
        startOk = true;
      }
      const lengthDays = Number(form.trialLengthDays);
      let lengthOk = false;
      if (
        form.trialLengthDays.trim() === "" ||
        !Number.isInteger(lengthDays) ||
        lengthDays <= 0
      ) {
        errors.trialLengthDays =
          "Enter a positive whole number of days.";
      } else {
        lengthOk = true;
      }
      if (startOk && lengthOk && postAmountOk) {
        trial = {
          startDate: form.trialStartDate,
          lengthDays,
          postAmountMinor,
        };
      }
    } else {
      // Explicit end date variant (the default). The end date must be a valid
      // ISO date (an invalid end date is an inline error).
      let endOk = false;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(form.trialEndDate)) {
        errors.trialEndDate = "Enter a valid trial end date.";
      } else {
        endOk = true;
      }
      if (endOk && postAmountOk) {
        trial = { endDate: form.trialEndDate, postAmountMinor };
      }
    }

    // Authority: the fast pre-checks above are for UX; the ZOD `trialSchema` is
    // the single runtime source of truth (frozen spec). Parse the built trial
    // through it and, if it rejects (e.g. end-before-start, or any rule the
    // pre-checks don't fully mirror), surface a field-named inline error on the
    // offending field so nothing invalid persists.
    if (trial !== undefined) {
      const parsed = trialSchema.safeParse(trial);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const field = trialFieldForPath(issue?.path, form.trialLengthMode);
        if (errors[field] === undefined) {
          errors[field] = issue?.message ?? "Enter a valid trial.";
        }
        // Do not carry an unschema-valid trial forward.
        trial = undefined;
      }
    }
  }

  return { errors, amountMinor, customCount, trial };
}

/**
 * Map a zod {@link trialSchema} issue path onto the form field it belongs to,
 * so a schema rejection names the right inline field. `startDate` maps to the
 * active variant's date field, `lengthDays`/`endDate` to their inputs, and
 * `postAmountMinor` to the post-amount field; anything else falls back to the
 * variant's primary date field.
 */
function trialFieldForPath(
  path: (string | number)[] | undefined,
  mode: TrialLengthMode,
): keyof FieldErrors {
  const key = path?.[0];
  switch (key) {
    case "postAmountMinor":
      return "trialPostAmount";
    case "lengthDays":
      return "trialLengthDays";
    case "endDate":
      return "trialEndDate";
    case "startDate":
      return mode === "startDays" ? "trialStartDate" : "trialEndDate";
    default:
      return mode === "startDays" ? "trialStartDate" : "trialEndDate";
  }
}

/**
 * Build the dated post-trial hint string ("$X after {conversionDate}") from the
 * current form, or `null` when the inputs are not yet coherent. It mirrors the
 * save-path variant logic (end date OR start + whole days) to derive the
 * conversion day via the pure `core/trial.conversionDate`, and formats the
 * entered post-trial major amount in the form's currency. The amount carries NO
 * "/mo" suffix — it is the post-trial charge per the sub's own billing cycle,
 * not a monthly figure. Purely informational.
 */
function computeTrialHint(form: FormState): string | null {
  // The post-trial amount must parse to minor units before we can show a figure.
  if (form.trialPostAmount.trim() === "") return null;
  let postAmountMinor: number;
  try {
    postAmountMinor = minorUnits(form.trialPostAmount.trim(), form.currency);
  } catch {
    return null;
  }

  // Derive the conversion date from whichever variant is active, bailing out
  // (no hint) when the inputs are incomplete/invalid.
  let convertsOn: string;
  if (form.trialLengthMode === "startDays") {
    const lengthDays = Number(form.trialLengthDays);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(form.trialStartDate) ||
      form.trialLengthDays.trim() === "" ||
      !Number.isInteger(lengthDays) ||
      lengthDays <= 0
    ) {
      return null;
    }
    convertsOn = conversionDate({
      startDate: form.trialStartDate,
      lengthDays,
      postAmountMinor,
    });
  } else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.trialEndDate)) return null;
    convertsOn = conversionDate({
      endDate: form.trialEndDate,
      postAmountMinor,
    });
  }

  const amount = minorToMajor(postAmountMinor, form.currency);
  return `${amount} after ${convertsOn}`;
}

/**
 * Build the dated suggested-price note (Story 5.4; FR-13):
 * "Suggested {money} — typical as of {asOf}, please confirm. Approximate — always
 * verify against your own plan."
 *
 * The money is the seed amount formatted in the seed's own currency via the
 * money seam; an unknown currency falls back to "{currency} {amountMinor}" so
 * the note never crashes. The note NAMES the as-of date and the "please confirm"
 * / "approximate, always verify" disclaimer the spec requires, and is purely
 * informational — it never gates save and never overwrites the user's entry.
 */
function buildSuggestionNote(suggestion: PriceSuggestion): string {
  // The currency appears exactly ONCE: on the success path we join the major
  // string with the code ("15.49 USD"); on the unknown-currency fallback the
  // code already leads the raw minor units ("USD 1549"). The template never
  // appends the code again.
  let money: string;
  try {
    money = `${toMajor(suggestion.amountMinor, suggestion.currency)} ${suggestion.currency}`;
  } catch {
    money = `${suggestion.currency} ${suggestion.amountMinor}`;
  }
  return (
    `Suggested ${money} — typical as of ${suggestion.asOf}, ` +
    "please confirm. Approximate — always verify against your own plan."
  );
}

/**
 * Parse the amount field into integer minor units for the form's currency, or
 * `null` when it is empty / unparseable (Story 5.3). Used to drive the reactive
 * price-change offer without duplicating the money-seam parse — it mirrors
 * `validate`'s amount parse but never throws (an invalid amount yields `null`,
 * and the amount's own inline validation reports it on submit).
 */
function parsedAmountMinorOrNull(form: FormState): number | null {
  if (form.amount.trim() === "") return null;
  try {
    return minorUnits(form.amount.trim(), form.currency);
  } catch {
    return null;
  }
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
  const trialModeGroupId = useId();

  const [form, setForm] = useState<FormState>(() =>
    initialState(subscription, settings.homeCurrency, settings.accentColor),
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Suggested price (Story 5.4; FR-13) — CREATE mode only. As the user types a
  // name, we look up a bundled suggestion over the IPC bridge and, on a FRESH
  // match while the amount is still untouched, pre-fill the amount (and
  // currency/cycle) ONCE and show a dated note. The user's entry is sacred: an
  // explicit "amount user-edited" flag (`amountUserEdited`) is set on the first
  // manual amount change; once set, a suggestion only ever shows the note and
  // never writes the field or re-fires. `suggestion` holds the current match (or
  // null for a miss / absent seed) so the note can render; `suggestionFilled`
  // records whether we already auto-filled from it (so we never re-fill).
  const suggestionSeqRef = useRef(0);
  const [suggestion, setSuggestion] = useState<PriceSuggestion | null>(null);
  const amountUserEdited = useRef(false);
  const suggestionFilled = useRef(false);

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
    // Reset the suggestion machinery on every (re)open so a fresh Add starts
    // with no note, an untouched amount, and no prior pre-fill (Story 5.4).
    setSuggestion(null);
    amountUserEdited.current = false;
    suggestionFilled.current = false;
    suggestionSeqRef.current += 1; // invalidate any in-flight lookup
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

  // Price-change offer visibility (Story 5.3; AD-21). The offer is shown ONLY in
  // EDIT mode, and ONLY when the price actually changed — either the amount field
  // parses to a different integer-minor-units value than the stored amount, OR
  // the Native currency differs (a currency-only switch, e.g. USD→EUR at the same
  // typed figure, is a real price change worth recording; the recorded entry
  // stores its own currency). A reactive check driven by the amount/currency
  // inputs. An empty/unparseable amount is "no amount change yet" (its own inline
  // validation handles invalidity on submit). Amount equality routes through the
  // pure `priceChanged` seam.
  const parsedAmountMinor = isEdit ? parsedAmountMinorOrNull(form) : null;
  const priceChangedForEdit =
    isEdit &&
    ((parsedAmountMinor !== null &&
      priceChanged(subscription.amountMinor, parsedAmountMinor)) ||
      form.currency !== subscription.currency);

  // Reset the opt-in to CHECKED whenever the offer transitions hidden→shown, so a
  // user who unchecked it for one edit (then reverted, hiding the offer) is not
  // silently left opted-OUT when a later genuine change re-reveals the offer.
  const priceChangeOfferShown = useRef(false);
  useEffect(() => {
    if (!open) {
      priceChangeOfferShown.current = false;
      return;
    }
    if (priceChangedForEdit && !priceChangeOfferShown.current) {
      // Hidden→shown edge: re-arm the default-checked intent.
      setForm((prev) => ({ ...prev, recordPriceChange: true }));
    }
    priceChangeOfferShown.current = priceChangedForEdit;
  }, [open, priceChangedForEdit]);

  // Suggested-price lookup (Story 5.4; FR-13) — CREATE mode only. On each name
  // change we query the bundled seed over the IPC bridge (via `suggestPriceSafe`,
  // which NEVER throws — any failure degrades to "no suggestion"). The lookup is
  // local and cheap, but a per-keystroke sequence guard (`suggestionSeqRef`)
  // discards a stale async result if the name changed again before it resolved.
  //
  // Behavior on resolve:
  //   - no match (null)  → clear the note (silent miss), never touch the amount.
  //   - a match          → store it so the note renders. Then AUTO-FILL exactly
  //     once IFF the seed is NOT stale AND the user has not edited the amount AND
  //     we have not already pre-filled: write amount/currency/cycle. A STALE seed
  //     (asOf > ~1yr before today, a UTC day) is NEVER auto-filled — the note
  //     shows as a non-filling hint. The user's typed value always wins.
  useEffect(() => {
    if (!open || isEdit) return;
    const name = form.name;
    // An empty / whitespace-only name can never match (the seed lookup is an
    // exact normalized-key match), so skip the query entirely and clear any
    // prior note — this also means the very first mount (name === "") never
    // fires a pointless lookup. Bump the sequence ref so ANY in-flight lookup
    // started by a prior keystroke is ignored when it resolves (otherwise a
    // late match could re-show a stale note on a now-empty field).
    if (name.trim() === "") {
      suggestionSeqRef.current += 1;
      setSuggestion(null);
      return;
    }
    const seq = ++suggestionSeqRef.current;
    void (async () => {
      const result = await suggestPriceSafe(name);
      // A newer keystroke superseded this lookup — drop the stale result.
      if (seq !== suggestionSeqRef.current) return;
      if (result === null) {
        setSuggestion(null);
        return;
      }
      setSuggestion(result);
      const stale = isSeedStale(result.asOf, todayIso(), SUGGESTION_MAX_AGE_DAYS);
      if (stale || amountUserEdited.current || suggestionFilled.current) {
        // Stale seed, user already edited the amount, or we already pre-filled:
        // show the note only, never (re)write the field.
        return;
      }
      // Fresh match on an untouched amount: pre-fill ONCE (amount + currency +
      // cycle), then latch so a later keystroke never re-fills.
      suggestionFilled.current = true;
      let major: string;
      try {
        major = toMajor(result.amountMinor, result.currency);
      } catch {
        // An unknown currency can't be rendered to a major string — skip the
        // amount pre-fill (the note still informs), but adopt currency/cycle.
        setForm((prev) => ({
          ...prev,
          currency: result.currency,
          billingCycle: result.billingCycle,
        }));
        return;
      }
      setForm((prev) => ({
        ...prev,
        amount: major,
        currency: result.currency,
        billingCycle: result.billingCycle,
      }));
    })();
    // Re-run on name change (and on open/mode flips, which reset above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isEdit, form.name]);

  if (!open) return null;

  /** Patch a single form field. */
  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  /**
   * Amount-field change handler (Story 5.4). Marks the amount as USER-EDITED on
   * the first manual change so a suggestion never clobbers the typed value and
   * never re-fires after an edit (the user's entry is sacred). It does NOT clear
   * the suggestion note — a dated note may still inform even once the user owns
   * the value. The auto-fill writes `form.amount` via `setForm` directly (not
   * this handler), so programmatic pre-fill never trips the flag.
   */
  function handleAmountChange(value: string): void {
    amountUserEdited.current = true;
    set("amount", value);
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
        // Price history (Story 5.3; AD-21). When the price actually changed
        // (amount OR Native currency) AND the user opted in, append a FORWARD-log
        // entry capturing the NEW amount+currency (the price that now takes
        // effect) dated the renderer's local today, via the pure
        // `appendPriceEntry` — so the latest entry matches the current amount. The
        // append rides this same `subs:update` patch (no new channel) and persists
        // append-only under the subscriptions lock. An unchanged price or an
        // unchecked box records nothing (the field is omitted, so the existing
        // `priceHistory` is preserved untouched by the merge).
        const didChange =
          priceChanged(subscription.amountMinor, amountMinor) ||
          form.currency !== subscription.currency;
        const priceHistory =
          didChange && form.recordPriceChange
            ? appendPriceEntry(subscription.priceHistory, {
                amountMinor,
                currency: form.currency,
                date: todayIso(),
              })
            : undefined;

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
          // Only include `priceHistory` when a change was recorded; otherwise
          // omit it so the merge leaves the stored history untouched.
          ...(priceHistory !== undefined ? { priceHistory } : {}),
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

  // Dated post-trial-amount hint ("$X/mo after {conversionDate}"), shown under
  // the "Amount after trial" field when the current trial inputs are coherent
  // enough to compute both a conversion date (via `core/trial.conversionDate`)
  // and a formatted amount. Purely informational — never gates save, and it
  // yields `null` (nothing rendered) when an input is still incomplete/invalid.
  const trialHint =
    form.state === "Trial" ? computeTrialHint(form) : null;

  // Dated suggested-price note (Story 5.4; FR-13) — CREATE mode only. When a
  // bundled suggestion matched the typed name, surface a note that NAMES the "as
  // of" date, says "please confirm", and carries the "approximate, always
  // verify" disclaimer. Shown whether or not the amount was auto-filled: a FRESH
  // match that pre-filled, AND a stale match that only hinted, both inform here.
  // Non-match (`suggestion === null`) or EDIT mode → no note.
  const suggestionNote =
    !isEdit && suggestion !== null
      ? buildSuggestionNote(suggestion)
      : null;

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
                onChange={(e) => handleAmountChange(e.target.value)}
                aria-invalid={errors.amount ? true : undefined}
                aria-describedby={
                  // Announce BOTH when present (space-joined), so a validation
                  // error never drops the suggestion note from the a11y name.
                  [
                    errors.amount ? "sub-amount-error" : null,
                    suggestionNote ? "sub-amount-suggestion" : null,
                  ]
                    .filter(Boolean)
                    .join(" ") || undefined
                }
              />
              {/* Dated suggestion note + "approximate, always verify" disclaimer
                  (Story 5.4; FR-13). Shown in CREATE mode on a seed match. It is
                  purely informational — the field stays fully editable and the
                  user's entry always wins. */}
              {suggestionNote && (
                <p
                  id="sub-amount-suggestion"
                  className="text-xs text-muted-foreground"
                >
                  {suggestionNote}
                </p>
              )}
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

            {/* Trial reveal — only when state === "Trial" (AD-18; Story 5.1). */}
            {form.state === "Trial" && (
              <div className="sm:col-span-2 grid grid-cols-1 gap-4 rounded-md border border-border bg-background/40 p-4 sm:grid-cols-2">
                {/* Trial-length variant choice: end date OR start + N days. */}
                <div className="sm:col-span-2">
                  <TrialLengthModeControl
                    groupId={trialModeGroupId}
                    value={form.trialLengthMode}
                    onChange={(next) => set("trialLengthMode", next)}
                  />
                </div>

                {form.trialLengthMode === "endDate" ? (
                  <Field
                    label="Trial ends on"
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
                ) : (
                  <>
                    <Field
                      label="Trial starts on"
                      htmlFor="sub-trial-start"
                      required
                      error={errors.trialStartDate}
                    >
                      <input
                        id="sub-trial-start"
                        type="date"
                        className={CONTROL_CLASS}
                        value={form.trialStartDate}
                        onChange={(e) => set("trialStartDate", e.target.value)}
                        aria-invalid={errors.trialStartDate ? true : undefined}
                        aria-describedby={
                          errors.trialStartDate
                            ? "sub-trial-start-error"
                            : undefined
                        }
                      />
                    </Field>
                    <Field
                      label="Trial length (days)"
                      htmlFor="sub-trial-days"
                      required
                      error={errors.trialLengthDays}
                    >
                      <input
                        id="sub-trial-days"
                        type="number"
                        inputMode="numeric"
                        min={1}
                        step={1}
                        className={CONTROL_CLASS}
                        value={form.trialLengthDays}
                        onChange={(e) => set("trialLengthDays", e.target.value)}
                        aria-invalid={errors.trialLengthDays ? true : undefined}
                        aria-describedby={
                          errors.trialLengthDays
                            ? "sub-trial-days-error"
                            : undefined
                        }
                      />
                    </Field>
                  </>
                )}

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
                      errors.trialPostAmount
                        ? "sub-trial-amount-error"
                        : trialHint
                          ? "sub-trial-amount-hint"
                          : undefined
                    }
                  />
                  {/* Dated post-amount hint: "$X/mo after {conversionDate}". */}
                  {trialHint && (
                    <p
                      id="sub-trial-amount-hint"
                      className="text-xs text-muted-foreground"
                    >
                      {trialHint}
                    </p>
                  )}
                </Field>
              </div>
            )}

            {/* Record-price-change offer (Story 5.3; AD-21) — EDIT mode only,
                shown ONLY when the price changed (amount OR currency). Defaults checked so
                recording the change is the common path; unchecking makes a silent
                correction without polluting the append-only history. */}
            {priceChangedForEdit && (
              <div className="sm:col-span-2">
                <Toggle
                  id="sub-record-price-change"
                  label="Record this as a price change"
                  checked={form.recordPriceChange}
                  onChange={(checked) => set("recordPriceChange", checked)}
                />
              </div>
            )}

            {/* Read-only price history (Story 5.3; AD-21) — EDIT mode only.
                Append-only, local; no edit/delete controls. */}
            {isEdit && (
              <div className="sm:col-span-2">
                <PriceHistoryList history={subscription.priceHistory} />
              </div>
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

/**
 * The two-way trial-length variant control (Story 5.1; AD-18): an accessible
 * `radiogroup` choosing "Trial ends on [date]" vs "Trial lasts [N] days from
 * start". Months are deliberately NOT offered. Each option is a real
 * `role="radio"` button reached by Tab (each is a focusable button; there is no
 * roving tabindex, so Arrow keys do not move selection) and selected with
 * Space/Enter (native button activation), with a visible focus ring — the same
 * pattern as {@link StateControl}.
 */
function TrialLengthModeControl({
  groupId,
  value,
  onChange,
}: {
  groupId: string;
  value: TrialLengthMode;
  onChange: (next: TrialLengthMode) => void;
}): JSX.Element {
  const options: readonly { mode: TrialLengthMode; label: string }[] = [
    { mode: "endDate", label: "Ends on a date" },
    { mode: "startDays", label: "Lasts N days from start" },
  ];
  return (
    <div className="space-y-1.5">
      <span
        id={`${groupId}-label`}
        className="block text-sm font-medium text-foreground"
      >
        Trial length
      </span>
      <div
        role="radiogroup"
        aria-labelledby={`${groupId}-label`}
        className="inline-flex rounded-md border border-input p-0.5"
      >
        {options.map(({ mode, label }) => {
          const selected = value === mode;
          return (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(mode)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                FOCUS_RING,
                selected
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
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
