/**
 * Dashboard view (Req 8.1–8.6; Story 6.1).
 *
 * An at-a-glance overview of subscription spending. It reads the live
 * subscription list and settings from the client stores via
 * `useStore`/`useStoreData` (`useSyncExternalStore` adapters), so it re-renders
 * whenever subscription data changes after any mutation (Req 8.6) — the stores
 * are reloaded on the `onDataChanged` broadcast by `initStores`.
 *
 * Story 6.1 kills the Story-3.3 naive minor-unit sum. The "This month" / "Per
 * year" figures are now the ONE honest Home-Currency convert-before-sum totals
 * from `core/totalsV2.homeMonthlyTotal`/`homeYearlyTotal` (which wrap the single
 * `core/money.homeTotal`), fed the bundled FX `RateSnapshot` fetched over the
 * read-only `fx:snapshot` IPC. The stale-rate guard (`core/money.rateConfidence`)
 * decides whether a confident single total is honest: on stale rates the cards
 * show a focusable "rates are ~N months old" affordance instead. Figures count
 * up on load (snapping under `prefers-reduced-motion`) and a cold load shows
 * `Skeleton` placeholders, not a spinner.
 *
 *   - "This month" / "Per year": Active-spend subset only (Trials AND Paused
 *     excluded — AD-17) in Home Currency (Req 8.1, 8.2).
 *   - "Active" count: Active + Trial (both are live) via `activeCount` (Req 8.3).
 *   - Trials-convert sub-line: the FX-correct Home monthly figure the Trial
 *     subset would add once converted (Story 5.1 figure, now convert-before-sum).
 *   - Renewing within 7 days (Req 8.4) and recently-changed (Req 8.5) sublists.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CalendarClock,
  History,
  Wallet,
  CalendarRange,
  ListChecks,
  type LucideIcon,
} from "lucide-react";
import type { SubscriptionV2 } from "core/models/subscription";
import {
  activeSpendSubscriptionsV2,
  trialSubscriptionsV2,
} from "core/subscriptionsV2";
import { activeCount, recentlyChanged, renewingWithin } from "core/analytics";
import { homeMonthlyTotal, homeYearlyTotal } from "core/totalsV2";
import {
  exponentOf,
  monthsStale,
  rateConfidence,
  type RateSnapshot,
} from "core/money";
import { subscriptionsStore, settingsStore } from "@/stores";
import { useStore, useStoreData } from "@/stores/hooks";
import { getFxSnapshotSafe, onDataChanged } from "@/api/subby";
import CategoryColorDot from "@/components/CategoryColorDot";
import LogoTile from "@/components/LogoTile";
import CountUp from "@/components/CountUp";
import Skeleton from "@/components/Skeleton";
import StaleRateNote from "@/components/StaleRateNote";

/** Number of upcoming days considered "renewing soon" on the dashboard (Req 8.4). */
const RENEWAL_WINDOW_DAYS = 7;

/** How many "recently changed" subscriptions to surface (Req 8.5). */
const RECENT_CHANGED_COUNT = 5;

/** Today as an ISO date (`YYYY-MM-DD`); passed to the pure date helpers. */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Convert integer Home **minor units** to a major-unit number for the currency
 * formatter. The totals come from `homeTotal` (already Home minor units), so a
 * scale by the Home Currency's exponent is the honest display. An unknown
 * currency falls back to a 2-decimal scale rather than throwing in the UI.
 */
function minorToMajorNumber(minor: number, currency: string): number {
  let exponent: number;
  try {
    exponent = exponentOf(currency);
  } catch {
    exponent = 2;
  }
  return minor / 10 ** exponent;
}

/** Build a currency formatter for the Home Currency. */
function makeCurrencyFormatter(currency: string): Intl.NumberFormat {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    });
  } catch {
    // Fall back to a plain decimal format if the currency code is unsupported.
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  }
}

/** Format an ISO date (`YYYY-MM-DD`) for display, falling back to the raw value. */
function formatDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * The state of the FX-snapshot fetch for the current Home Currency. `loading`
 * gates the skeletons; `errored` (snapshot resolved to `null`) drives the "rates
 * unavailable" money state so the view never shows a wrong confident number.
 */
interface FxState {
  snapshot: RateSnapshot | null;
  loading: boolean;
  errored: boolean;
}

/**
 * Fetch the EFFECTIVE FX {@link RateSnapshot} for `homeCurrency`, re-fetching when
 * it changes AND on every `onDataChanged` (Story 8.6). The opt-in FX refresh
 * writes a fresher override and broadcasts `evt:dataChanged`; re-querying on that
 * swaps the newer `asOf`/rates in through the SAME path the stores reload through
 * (the override is transparent — same `RateSnapshot`). The initial per-Home-
 * Currency fetch shows skeletons (`loading: true`); a background `onDataChanged`
 * re-fetch does NOT reset to loading (no skeleton flash — the figures stay up and
 * recompute when the new snapshot lands). The fetch never throws
 * (`getFxSnapshotSafe` swallows a missing/corrupt bundle as `null`); a `null`
 * becomes `errored` so the cards degrade to "rates unavailable".
 */
function useFxSnapshot(homeCurrency: string): FxState {
  const [state, setState] = useState<FxState>({
    snapshot: null,
    loading: true,
    errored: false,
  });

  useEffect(() => {
    let cancelled = false;
    // Initial (per-Home-Currency) fetch: show skeletons until it resolves.
    setState({ snapshot: null, loading: true, errored: false });
    const apply = (snapshot: RateSnapshot | null): void => {
      if (cancelled) return;
      setState({ snapshot, loading: false, errored: snapshot === null });
    };
    void getFxSnapshotSafe(homeCurrency).then(apply);
    // Background re-fetch on any data change (an FX refresh swap-in) — no skeleton
    // flash: the figures stay rendered and recompute when the new snapshot lands.
    const off = onDataChanged(() => {
      void getFxSnapshotSafe(homeCurrency).then(apply);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [homeCurrency]);

  return state;
}

/**
 * A single metric card: a label, a prominent value, and an icon. An optional
 * `secondary` node renders beneath the value as a muted supporting line (used by
 * the month card for the trials-convert figure).
 */
function MetricCard({
  label,
  value,
  icon: Icon,
  secondary,
  primary = false,
}: {
  label: string;
  value: ReactNode;
  icon: LucideIcon;
  secondary?: ReactNode;
  /** The primary (This month) card gets the accent left-keyline. */
  primary?: boolean;
}): JSX.Element {
  return (
    <div
      className={`rounded-lg border border-border bg-card p-4${
        primary ? " border-l-2 border-l-accent" : ""
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-muted-foreground">
          {label}
        </span>
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-tight">{value}</p>
      {secondary}
    </div>
  );
}

/** The skeleton placeholder shown in a metric card during a cold load. */
function MetricCardSkeleton(): JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-4 w-4" />
      </div>
      <Skeleton className="mt-3 h-8 w-32" />
    </div>
  );
}

/**
 * The rendered VALUE for a converted money card (Monthly / Yearly), honoring the
 * stale-rate guard (Story 2.4 / AD-12):
 *   - errored  → "Rates unavailable" (never a wrong number);
 *   - stale    → a MUTED, "~"-prefixed APPROXIMATE figure — the number stays
 *                visible but is clearly NOT presented as a confident single
 *                total (the authoritative meaning lives in the stale affordance
 *                above the cards). No count-up on the unconfident figure.
 *   - confident→ the bold `<CountUp>` figure.
 */
function MoneyCardValue({
  errored,
  stale,
  value,
  formatMoney,
}: {
  errored: boolean;
  stale: boolean;
  value: number;
  formatMoney: (n: number) => string;
}): JSX.Element {
  if (errored) {
    return (
      <span className="text-base font-medium text-muted-foreground">
        Rates unavailable
      </span>
    );
  }
  if (stale) {
    // Muted + "~" to signal approximate — not an authoritative single total.
    return (
      <span className="font-normal text-muted-foreground tabular-nums">
        ~{formatMoney(value)}
      </span>
    );
  }
  return <CountUp value={value} format={formatMoney} />;
}

/**
 * A titled panel holding a list of subscriptions. Renders an accessible empty
 * state when there is nothing to show.
 */
function SubscriptionPanel({
  title,
  icon: Icon,
  emptyLabel,
  items,
  renderMeta,
}: {
  title: string;
  icon: LucideIcon;
  emptyLabel: string;
  items: SubscriptionV2[];
  renderMeta: (s: SubscriptionV2) => string;
}): JSX.Element {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span>{title}</span>
      </h3>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        <ul className="mt-3 flex flex-col divide-y divide-border">
          {items.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
            >
              <span className="flex min-w-0 items-center gap-2">
                <LogoTile name={s.name} website={s.website} />
                <span className="min-w-0 truncate">
                  <span className="font-medium">{s.name}</span>
                  {s.category && (
                    <span className="ml-2 inline-flex items-center text-sm text-muted-foreground">
                      <CategoryColorDot categoryName={s.category} />
                      {s.category}
                    </span>
                  )}
                </span>
              </span>
              <span className="shrink-0 text-sm text-muted-foreground">
                {renderMeta(s)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The skeleton placeholder shown in a sublist panel during a cold load. */
function SubscriptionPanelSkeleton(): JSX.Element {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <Skeleton className="h-4 w-36" />
      <div className="mt-3 flex flex-col gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center justify-between gap-3">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-20" />
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * The computed money figures for the three cards, plus the derived state the
 * view branches on. Exactly one of `errored` / stale-affordance / confident
 * display paths is taken for the money figures.
 */
interface MoneyFigures {
  /** True when the snapshot is unavailable OR a total computation threw. */
  errored: boolean;
  /** The convert-before-sum monthly figure in Home major units (0 when errored). */
  monthlyMajor: number;
  /** The convert-before-sum yearly figure in Home major units (0 when errored). */
  yearlyMajor: number;
  /** The trials-convert monthly figure in Home major units (0 when errored). */
  trialsMonthlyMajor: number;
  /** `confident` | `stale` from `rateConfidence`; `confident` when errored. */
  confidence: "confident" | "stale";
  /** The snapshot's `asOf` date (empty when errored). */
  asOf: string;
  /** Whole months the snapshot is behind today (for the stale affordance copy). */
  months: number;
}

/**
 * Build synthetic subscriptions whose `amountMinor` is each Trial's POST-trial
 * amount, so the trials-convert figure is the FX-correct convert-before-sum Home
 * total (`homeMonthlyTotal`) over what those trials WILL cost once converted —
 * aligning the Story-5.1 line with the one honest total (no native-minor sum).
 */
function trialPostTrialShadow(subs: readonly SubscriptionV2[]): SubscriptionV2[] {
  return trialSubscriptionsV2([...subs]).map((s) => ({
    ...s,
    amountMinor: s.trial?.postAmountMinor ?? 0,
  }));
}

/**
 * Compute the three money figures over the fetched snapshot. Returns `errored`
 * when the snapshot is unavailable OR any total computation throws (an unknown
 * currency / missing rate) — the view then shows "rates unavailable", NEVER a
 * wrong confident number. The totals route exclusively through the shared
 * `homeMonthlyTotal`/`homeYearlyTotal` (which wrap `homeTotal`): the view never
 * re-implements convert-and-sum.
 */
function computeFigures(
  active: readonly SubscriptionV2[],
  trialShadow: readonly SubscriptionV2[],
  snapshot: RateSnapshot | null,
  homeCurrency: string,
  fxRefreshOn: boolean,
  today: string,
): MoneyFigures {
  if (snapshot === null) {
    return {
      errored: true,
      monthlyMajor: 0,
      yearlyMajor: 0,
      trialsMonthlyMajor: 0,
      confidence: "confident",
      asOf: "",
      months: 0,
    };
  }
  try {
    const monthly = homeMonthlyTotal(active, snapshot, homeCurrency);
    const yearly = homeYearlyTotal(active, snapshot, homeCurrency);
    const trials = homeMonthlyTotal(trialShadow, snapshot, homeCurrency);
    const confidence = rateConfidence(snapshot.asOf, today, fxRefreshOn);
    return {
      errored: false,
      monthlyMajor: minorToMajorNumber(monthly.totalMinor, homeCurrency),
      yearlyMajor: minorToMajorNumber(yearly.totalMinor, homeCurrency),
      trialsMonthlyMajor: minorToMajorNumber(trials.totalMinor, homeCurrency),
      confidence,
      asOf: snapshot.asOf,
      months: confidence === "stale" ? monthsStale(snapshot.asOf, today) : 0,
    };
  } catch {
    // A currency without an exponent/rate, or an out-of-range total: degrade to
    // "rates unavailable" rather than crash the view or show a wrong figure.
    return {
      errored: true,
      monthlyMajor: 0,
      yearlyMajor: 0,
      trialsMonthlyMajor: 0,
      confidence: "confident",
      asOf: "",
      months: 0,
    };
  }
}

/**
 * Dashboard overview (Req 8). Default export so the application shell can
 * eager-import it (`@/views/Dashboard`).
 */
export default function Dashboard(): JSX.Element {
  const subsState = useStore(subscriptionsStore);
  const subs = subsState.data;
  const settings = useStoreData(settingsStore);

  const today = todayISO();
  const homeCurrency = settings.homeCurrency;

  const fx = useFxSnapshot(homeCurrency);

  // The subscription data is cold until the store has loaded once; the FX
  // snapshot is cold until its fetch resolves. Either keeps the skeletons up.
  const coldLoad = !subsState.loaded || fx.loading;

  // Derived subscription subsets (recompute only when inputs change). "This
  // month"/"Per year" sum the Active-spend subset (Trials AND Paused excluded —
  // AD-17); the "Active count" is Active + Trial via `activeCount`.
  const active = useMemo(() => activeSpendSubscriptionsV2(subs), [subs]);
  const trialShadow = useMemo(() => trialPostTrialShadow(subs), [subs]);
  const count = useMemo(() => activeCount(subs), [subs]);
  // The shadow is a 1:1 map over the Trial subset, so its length IS the trial
  // count — no second filter needed.
  const trialCount = trialShadow.length;
  const renewingSoon = useMemo(
    () => renewingWithin(subs, RENEWAL_WINDOW_DAYS, today),
    [subs, today],
  );
  const recent = useMemo(
    () => recentlyChanged(subs, RECENT_CHANGED_COUNT),
    [subs],
  );

  const figures = useMemo(
    () =>
      computeFigures(
        active,
        trialShadow,
        fx.snapshot,
        homeCurrency,
        settings.online.fxRefresh,
        today,
      ),
    [active, trialShadow, fx.snapshot, homeCurrency, settings.online.fxRefresh, today],
  );

  const currency = useMemo(
    () => makeCurrencyFormatter(homeCurrency),
    [homeCurrency],
  );
  const formatMoney = (n: number): string => currency.format(n);

  const isEmpty = subsState.loaded && subs.length === 0;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight">Dashboard</h2>
        <p className="text-muted-foreground">
          Overview of your subscription spending.
        </p>
      </header>

      {/* The single live-region "loading" announcement for the cold load. The
          Skeleton blocks themselves are aria-hidden decoration. */}
      {coldLoad && (
        <p className="sr-only" role="status" aria-live="polite">
          Loading your dashboard…
        </p>
      )}

      {/* Metric cards (Req 8.1, 8.2, 8.3). */}
      <section aria-label="Spending summary">
        {coldLoad ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <MetricCardSkeleton />
            <MetricCardSkeleton />
            <MetricCardSkeleton />
          </div>
        ) : (
          <>
            {/* Stale-rate guard (Story 2.4 / AD-12): when the snapshot is stale,
                do NOT present a confident single total — surface a focusable,
                text-labelled "N months old" NOTE above the cards (the cards
                themselves show a muted "~approximate" figure). It is a
                non-interactive note (there is no FX-refresh action until Epic 8),
                so it is a focusable `role="note"`, NOT a button that does
                nothing. Not shown when rates are unavailable (its own state). */}
            {!figures.errored && figures.confidence === "stale" && (
              <div className="mb-4">
                <StaleRateNote
                  months={figures.months}
                  asOf={formatDate(figures.asOf)}
                />
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <MetricCard
                label="Total Monthly Spend"
                primary
                icon={Wallet}
                value={
                  <MoneyCardValue
                    errored={figures.errored}
                    stale={figures.confidence === "stale"}
                    value={figures.monthlyMajor}
                    formatMoney={formatMoney}
                  />
                }
                secondary={
                  <MonthCardSecondary
                    errored={figures.errored}
                    asOf={figures.asOf}
                    trialCount={trialCount}
                    trialsMonthlyMajor={figures.trialsMonthlyMajor}
                    formatMoney={formatMoney}
                  />
                }
              />
              <MetricCard
                label="Total Yearly Spend"
                icon={CalendarRange}
                value={
                  <MoneyCardValue
                    errored={figures.errored}
                    stale={figures.confidence === "stale"}
                    value={figures.yearlyMajor}
                    formatMoney={formatMoney}
                  />
                }
                secondary={
                  !figures.errored ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Rates as of {formatDate(figures.asOf)}
                    </p>
                  ) : undefined
                }
              />
              <MetricCard
                label="Active Subscriptions"
                icon={ListChecks}
                value={
                  <CountUp
                    value={count}
                    format={(n) => String(Math.round(n))}
                  />
                }
              />
            </div>
          </>
        )}
      </section>

      {/* Empty state (no subscriptions tracked). Cards above already read 0. */}
      {isEmpty && (
        <p className="text-sm text-muted-foreground">
          Nothing tracked yet. Add your first subscription.
        </p>
      )}

      {/* Renewing soon + recently changed (Req 8.4, 8.5). */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {coldLoad ? (
          <>
            <SubscriptionPanelSkeleton />
            <SubscriptionPanelSkeleton />
          </>
        ) : (
          <>
            <SubscriptionPanel
              title="Renewing in 7 days"
              icon={CalendarClock}
              emptyLabel="Nothing renewing in the next seven days."
              items={renewingSoon}
              renderMeta={(s) => formatDate(s.nextRenewal)}
            />
            <SubscriptionPanel
              title="Recently changed"
              icon={History}
              emptyLabel="No subscriptions yet."
              items={recent}
              renderMeta={(s) => formatDate(s.updatedAt)}
            />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The month card's muted secondary line. When rates are available it carries
 * the "+ {money}/mo when N trials convert" trials-convert figure (Story 5.1,
 * rendered only for ≥1 Trial — it clears at zero) and the "rates as of {asOf}"
 * date; when rates are unavailable it shows nothing (the card body already says
 * "Rates unavailable").
 */
function MonthCardSecondary({
  errored,
  asOf,
  trialCount,
  trialsMonthlyMajor,
  formatMoney,
}: {
  errored: boolean;
  asOf: string;
  trialCount: number;
  trialsMonthlyMajor: number;
  formatMoney: (n: number) => string;
}): JSX.Element | null {
  if (errored) return null;
  return (
    <>
      {trialCount > 0 && (
        <p className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
          <span
            aria-hidden="true"
            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
          />
          <span>
            + {formatMoney(trialsMonthlyMajor)}/mo when {trialCount}{" "}
            {trialCount === 1 ? "trial converts" : "trials convert"}
          </span>
        </p>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        Rates as of {formatDate(asOf)}
      </p>
    </>
  );
}
