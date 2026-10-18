/**
 * Analytics view (lazy-loaded) — Story 6.3.
 *
 * Presents lightweight spending analytics built from the platform-independent
 * `core/analytics` GROUPINGS (which subs are in a category, the top-N ranking,
 * the renewal date grouping) with every monetary figure computed as the ONE
 * honest Home-Currency convert-before-sum total via the shared spine
 * (`core/totalsV2.homeMonthlyTotal`/`homeYearlyTotal` → `core/money.homeTotal`):
 *
 *   - Overall monthly / yearly  — `homeMonthlyTotal`/`homeYearlyTotal(active)`
 *   - Category distribution     — `homeMonthlyTotal(subsInCategory)` per group
 *   - Most expensive            — `topByMonthly` membership, RE-RANKED by each
 *                                 sub's Home-converted monthly (a mixed-currency
 *                                 portfolio can't be ranked by native minor units)
 *   - Renewal timeline          — `renewalTimeline(subs, today)` (date grouping)
 *
 * Story 6.3 kills the Story-3.3 hardcoded single-currency INR sum (the `money`
 * formatter + `/100` `toMajorNumber`). It fetches the bundled FX `RateSnapshot`
 * for `settings.homeCurrency` over Story 6.1's read-only `fx:snapshot` IPC
 * (`getFxSnapshotSafe`), formats in Home Currency with `tabular-nums`, and
 * applies the SAME stale-rate guard as the Dashboard (`core/money.rateConfidence`):
 * on stale rates it does NOT present confident single totals — it surfaces the
 * shared `StaleRateNote` and marks figures approximate; an FX IPC error degrades
 * to a clear "rates unavailable" state (never a wrong confident number).
 *
 * The GROUPING stays currency-independent — only the per-group AMOUNTS become
 * Home-converted. Charts are hand-rolled inline `<svg>` (no chart library) that
 * are DECORATIVE (`aria-hidden`); every chart carries BOTH a visually-hidden
 * (`sr-only`) summary naming its key figures + ordering AND a keyboard-reachable
 * data equivalent — the stacked bar / category distribution gain a `<table>`;
 * the most-expensive and renewal timeline are already navigable `<ol>` lists
 * (Req 22.3). No spend-over-time trend is built (deferred).
 *
 * The view re-renders whenever the subscriptions store changes (Req 8.6) via the
 * `useStoreData` hook. This file MUST keep a default export for `React.lazy`.
 */

import { useEffect, useMemo, useState } from "react";
import { renewalTimeline } from "core/analytics";
import { activeSpendSubscriptionsV2 } from "core/subscriptionsV2";
import { homeMonthlyTotal, homeYearlyTotal } from "core/totalsV2";
import {
  exponentOf,
  monthsStale,
  rateConfidence,
  toMajor,
  type RateSnapshot,
} from "core/money";
import type { SubscriptionV2 } from "core/models/subscription";
import { subscriptionsStore, settingsStore } from "@/stores";
import { useStoreData } from "@/stores/hooks";
import { getFxSnapshotSafe, onDataChanged } from "@/api/subby";
import StaleRateNote from "@/components/StaleRateNote";

/** Number of "most expensive" subscriptions to surface (Req 11.4). */
const TOP_N = 5;

/** Today as an ISO date (`YYYY-MM-DD`); passed to the pure date/guard helpers. */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Convert integer Home **minor units** to a major-unit number for the currency
 * formatter. Figures come from `homeTotal` (already Home minor units), so a
 * scale by the Home Currency's exponent is the honest display; an unknown
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

/** Build a Home-Currency `Intl` formatter (falls back to plain decimal). */
function makeCurrencyFormatter(currency: string): Intl.NumberFormat {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    });
  } catch {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  }
}

/** Friendly date formatter for the renewal timeline + "as of" copy. */
const dateFmt = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** Format an ISO `YYYY-MM-DD` date for display (parsed in UTC to avoid drift). */
function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map((p) => Number.parseInt(p, 10));
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(parsed.getTime())) return iso;
  return dateFmt.format(parsed);
}

// --- FX snapshot fetch (mirrors Story 6.1's Dashboard pattern) ---------------

/**
 * The state of the FX-snapshot fetch for the current Home Currency. `loading`
 * gates the figures; `errored` (snapshot resolved to `null`) drives the "rates
 * unavailable" state so the view never shows a wrong confident number.
 */
interface FxState {
  snapshot: RateSnapshot | null;
  loading: boolean;
  errored: boolean;
}

/**
 * Fetch the EFFECTIVE FX {@link RateSnapshot} for `homeCurrency`, re-fetching when
 * it changes AND on every `onDataChanged` (Story 8.6 — mirrors the Dashboard). An
 * opt-in FX refresh writes a fresher override and broadcasts `evt:dataChanged`;
 * re-querying swaps the newer `asOf`/rates in through the SAME path the stores
 * reload through (the override is transparent — same `RateSnapshot`). The initial
 * per-Home-Currency fetch shows the loading state; a background `onDataChanged`
 * re-fetch does NOT reset to loading (no flash — figures stay up and recompute).
 * `getFxSnapshotSafe` never throws; a `null` becomes `errored` so the view
 * degrades to "rates unavailable" rather than crashing.
 */
function useFxSnapshot(homeCurrency: string): FxState {
  const [state, setState] = useState<FxState>({
    snapshot: null,
    loading: true,
    errored: false,
  });

  useEffect(() => {
    let cancelled = false;
    setState({ snapshot: null, loading: true, errored: false });
    const apply = (snapshot: RateSnapshot | null): void => {
      if (cancelled) return;
      setState({ snapshot, loading: false, errored: snapshot === null });
    };
    void getFxSnapshotSafe(homeCurrency).then(apply);
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

// --- Home-converted analytics figures ----------------------------------------

/** A category with its Home-converted monthly figure (minor units). */
interface CategoryFigure {
  category: string;
  monthlyMinor: number;
}

/** A most-expensive sub with its Home-converted monthly figure (minor units). */
interface RankedSub {
  sub: SubscriptionV2;
  monthlyMinor: number;
}

/**
 * The computed, Home-converted analytics figures plus the derived state the view
 * branches on. Exactly one of `errored` / stale / confident paths is taken for
 * the money figures — on `errored` all monetary fields are zeroed and the view
 * shows "rates unavailable".
 */
interface AnalyticsFigures {
  /** True when the snapshot is unavailable OR a total computation threw. */
  errored: boolean;
  /** Overall convert-before-sum monthly figure in Home minor units. */
  monthlyMinor: number;
  /** Overall convert-before-sum yearly figure in Home minor units. */
  yearlyMinor: number;
  /** Per-category Home monthly figures, in first-appearance (grouping) order. */
  categories: CategoryFigure[];
  /** Most-expensive subs, RE-RANKED by Home-converted monthly (desc). */
  mostExpensive: RankedSub[];
  /** `confident` | `stale` from `rateConfidence`; `confident` when errored. */
  confidence: "confident" | "stale";
  /** The snapshot's `asOf` date (empty when errored). */
  asOf: string;
  /** Whole months the snapshot is behind today (for the stale affordance copy). */
  months: number;
}

/**
 * Compute every chart's money as a Home-Currency convert-before-sum total over
 * the fetched snapshot (Req 11, AD-11). The GROUPING stays currency-independent
 * (category membership is a first-appearance-ordered group-by — the same
 * ordering `core/analytics.categoryDistribution` guarantees; `renewalTimeline`
 * decides the date grouping); only the per-group AMOUNTS become Home-converted
 * here, each routed through the shared `homeMonthlyTotal`/`homeYearlyTotal` so
 * the view never re-implements convert-and-sum.
 *
 * Most-expensive is ranked by each sub's Home-converted monthly: a native
 * minor-unit ranking (`core/analytics.topByMonthly`) is wrong for a
 * mixed-currency portfolio (a ¥ amount and a $ amount aren't comparable as
 * integers), so we rank the active subs by their Home-converted monthly and
 * keep the top N — genuinely the most expensive in the user's Home Currency.
 *
 * Returns `errored` when the snapshot is unavailable OR any total computation
 * throws (an unknown currency / missing rate) — the view then shows "rates
 * unavailable", NEVER a wrong confident number.
 */
function computeFigures(
  active: readonly SubscriptionV2[],
  snapshot: RateSnapshot | null,
  homeCurrency: string,
  fxRefreshOn: boolean,
  today: string,
): AnalyticsFigures {
  const errored = (): AnalyticsFigures => ({
    errored: true,
    monthlyMinor: 0,
    yearlyMinor: 0,
    categories: [],
    mostExpensive: [],
    confidence: "confident",
    asOf: "",
    months: 0,
  });

  if (snapshot === null) return errored();

  try {
    // Group the subs by category in ONE pass. A `Map` preserves insertion
    // order, so this is the same first-appearance ordering `core/analytics`'s
    // `categoryDistribution` guarantees — the currency-independent grouping — but
    // here we keep each category's subs so the per-group AMOUNT can be the
    // Home-converted total (`categoryDistribution` only returns native sums).
    const subsByCategory = new Map<string, SubscriptionV2[]>();
    for (const s of active) {
      const bucket = subsByCategory.get(s.category);
      if (bucket === undefined) subsByCategory.set(s.category, [s]);
      else bucket.push(s);
    }

    const monthly = homeMonthlyTotal(active, snapshot, homeCurrency);
    const yearly = homeYearlyTotal(active, snapshot, homeCurrency);

    const categories: CategoryFigure[] = [...subsByCategory.entries()].map(
      ([category, subs]) => ({
        category,
        monthlyMinor: homeMonthlyTotal(subs, snapshot, homeCurrency).totalMinor,
      }),
    );

    // Most-expensive: rank the active subs by their Home-converted monthly (the
    // honest order for a mixed-currency portfolio) and keep the top N. `sort` is
    // stable (ES2019+), so equal-keyed subs preserve their relative input order,
    // matching `core/analytics.topByMonthly`'s stable-ordering contract.
    const mostExpensive: RankedSub[] = active
      .map((sub) => ({
        sub,
        monthlyMinor: homeMonthlyTotal([sub], snapshot, homeCurrency).totalMinor,
      }))
      .sort((a, b) => b.monthlyMinor - a.monthlyMinor)
      .slice(0, TOP_N);

    const confidence = rateConfidence(snapshot.asOf, today, fxRefreshOn);
    return {
      errored: false,
      monthlyMinor: monthly.totalMinor,
      yearlyMinor: yearly.totalMinor,
      categories,
      mostExpensive,
      confidence,
      asOf: snapshot.asOf,
      months: confidence === "stale" ? monthsStale(snapshot.asOf, today) : 0,
    };
  } catch {
    // A currency without an exponent/rate, or an out-of-range total: degrade to
    // "rates unavailable" rather than crash the view or show a wrong figure.
    return errored();
  }
}

export default function AnalyticsView(): JSX.Element {
  const subscriptions = useStoreData(subscriptionsStore);
  const settings = useStoreData(settingsStore);

  const today = todayISO();
  const homeCurrency = settings.homeCurrency;

  const fx = useFxSnapshot(homeCurrency);

  const active = useMemo(
    () => activeSpendSubscriptionsV2(subscriptions),
    [subscriptions],
  );

  const timeline = useMemo(
    () => renewalTimeline(subscriptions, today),
    [subscriptions, today],
  );

  const figures = useMemo(
    () =>
      computeFigures(
        active,
        fx.snapshot,
        homeCurrency,
        settings.online.fxRefresh,
        today,
      ),
    [active, fx.snapshot, homeCurrency, settings.online.fxRefresh, today],
  );

  const currency = useMemo(
    () => makeCurrencyFormatter(homeCurrency),
    [homeCurrency],
  );
  const formatMoney = (minor: number): string =>
    currency.format(minorToMajorNumber(minor, homeCurrency));

  const stale = !figures.errored && figures.confidence === "stale";

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight">Analytics</h2>
        <p className="text-muted-foreground">
          Spending patterns across {active.length} active{" "}
          {active.length === 1 ? "subscription" : "subscriptions"}.
        </p>
      </header>

      {active.length === 0 ? (
        <Card>
          <p className="text-muted-foreground">
            No active subscriptions yet. Add a subscription to see your spending
            analytics.
          </p>
        </Card>
      ) : figures.errored ? (
        /* FX unavailable (IPC error / missing rate): a clear "rates unavailable"
           state — never a wrong confident number, never a crash. */
        <Card>
          <p className="font-medium text-muted-foreground">Rates unavailable</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Exchange rates could not be loaded, so converted spending analytics
            cannot be shown right now.
          </p>
        </Card>
      ) : (
        <>
          {/* Stale-rate guard (Story 2.4 / AD-12): when the snapshot is stale,
              do NOT present confident single totals — surface the shared,
              focusable, text-labelled "N months old" note; the figures below
              are marked approximate ("~"). */}
          {stale && <StaleRateNote months={figures.months} asOf={formatDate(figures.asOf)} />}

          {/* Headline figures: monthly spend (Req 11.1) + yearly projection (Req 11.3) */}
          <div className="grid gap-4 sm:grid-cols-2">
            <StatCard
              label="Monthly spend"
              value={formatMoney(figures.monthlyMinor)}
              approximate={stale}
              hint={`Home-currency total · rates as of ${formatDate(figures.asOf)}`}
            />
            <StatCard
              label="Yearly projection"
              value={formatMoney(figures.yearlyMinor)}
              approximate={stale}
              hint={`Home-currency total · rates as of ${formatDate(figures.asOf)}`}
            />
          </div>

          {/* Monthly spend composition by category (Req 11.1) */}
          <Card>
            <CardHeader
              title="Monthly spend by category"
              subtitle="Share of your Home-currency monthly spend"
            />
            <StackedBar
              segments={figures.categories}
              totalMinor={figures.monthlyMinor}
              formatMoney={formatMoney}
              approximate={stale}
            />
          </Card>

          {/* Category distribution (Req 11.2) */}
          <Card>
            <CardHeader
              title="Category distribution"
              subtitle="Home-currency monthly spend per category"
            />
            <CategoryBars
              categories={figures.categories}
              totalMinor={figures.monthlyMinor}
              formatMoney={formatMoney}
              approximate={stale}
            />
          </Card>

          {/* Most expensive subscriptions (Req 11.4) */}
          <Card>
            <CardHeader
              title="Most expensive"
              subtitle={`Top ${Math.min(TOP_N, figures.mostExpensive.length)} by Home-currency monthly amount`}
            />
            <MostExpensiveList
              subs={figures.mostExpensive}
              formatMoney={formatMoney}
              approximate={stale}
            />
          </Card>

          {/* Upcoming renewal timeline (Req 11.5) */}
          <Card>
            <CardHeader
              title="Renewal timeline"
              subtitle="Upcoming renewals grouped by date"
            />
            <RenewalTimeline timeline={timeline} />
          </Card>
        </>
      )}
    </div>
  );
}

// --- Presentational building blocks -----------------------------------------

function Card({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <section className="rounded-lg border border-border bg-card p-5 text-card-foreground">
      {children}
    </section>
  );
}

function CardHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}): JSX.Element {
  return (
    <div className="mb-4 space-y-0.5">
      <h3 className="text-base font-medium tracking-tight">{title}</h3>
      <p className="text-sm text-muted-foreground">{subtitle}</p>
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  approximate,
}: {
  label: string;
  value: string;
  hint: string;
  /** On stale rates the figure is prefixed "~" and muted — not a confident total. */
  approximate: boolean;
}): JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card p-5 text-card-foreground">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p
        className={`mt-1 text-3xl font-semibold tracking-tight tabular-nums${
          approximate ? " font-normal text-muted-foreground" : ""
        }`}
      >
        {approximate ? `~${value}` : value}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

/** Prefix a money string with "~" when the figures are approximate (stale rates). */
function approx(value: string, approximate: boolean): string {
  return approximate ? `~${value}` : value;
}

/**
 * Render a sub's NATIVE amount for the renewal timeline, degrading to the raw
 * minor-unit value when the currency is off the money seam's exponent table.
 * The timeline runs over ALL subscriptions (outside the Home-total errored
 * guard), so one off-table currency must NOT throw and blank the whole view —
 * `toMajor` throws `UnknownCurrencyError` for such a currency.
 */
function safeToMajor(minor: number, currency: string): string {
  try {
    return toMajor(minor, currency);
  } catch {
    return String(minor);
  }
}

/**
 * The percentage a category's monthly figure is of the (safe) total, clamped to
 * 100. Per-category Home totals round independently from the overall total, so
 * the summed shares can land at 99/101% — clamping each share keeps the SVG
 * offset from overflowing 100% and the displayed share from ever reading >100%
 * (display-only; no full reconciliation of the rounding residue is attempted).
 */
function sharePct(monthlyMinor: number, totalMinor: number): number {
  const safeTotal = totalMinor > 0 ? totalMinor : 1;
  return Math.min(100, Math.round((monthlyMinor / safeTotal) * 100));
}

/**
 * A single horizontal stacked bar showing each category's share of the monthly
 * total (Req 11.1). The SVG is DECORATIVE (`aria-hidden`); the chart carries BOTH
 * a visually-hidden (`sr-only`) summary AND a keyboard-reachable `<table>` of
 * each category's Home amount + share, so a keyboard/AT user can walk the data
 * (Req 22.3), not just hear a one-line summary.
 */
function StackedBar({
  segments,
  totalMinor,
  formatMoney,
  approximate,
}: {
  segments: CategoryFigure[];
  totalMinor: number;
  formatMoney: (minor: number) => string;
  approximate: boolean;
}): JSX.Element {
  const safeTotal = totalMinor > 0 ? totalMinor : 1;
  let offset = 0;
  const width = 100; // percentage-based viewBox for fluid layout

  const summary =
    segments.length === 0
      ? "No spend to display."
      : `Monthly spend by category, total ${approx(formatMoney(totalMinor), approximate)}: ` +
        segments
          .map((seg) => `${seg.category} ${sharePct(seg.monthlyMinor, totalMinor)}%`)
          .join(", ") +
        ".";

  return (
    <div className="space-y-3">
      <p className="sr-only">{summary}</p>
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${width} 8`}
        preserveAspectRatio="none"
        className="h-3 w-full overflow-hidden rounded-full bg-muted"
        role="presentation"
      >
        {segments.map((seg, i) => {
          const x = offset;
          // Clamp each segment's end to `width` so cumulative rounding residue
          // across independently-converted categories never overflows the bar.
          const w = Math.min((seg.monthlyMinor / safeTotal) * width, width - x);
          offset += w;
          return (
            <rect
              key={seg.category}
              x={x}
              y={0}
              width={w}
              height={8}
              fill="var(--accent)"
              opacity={1 - (i % 4) * 0.18}
            />
          );
        })}
      </svg>

      {/* Keyboard-reachable data equivalent (Req 22.3): a real table in the
          normal tab/reading order, so the stacked-bar data is navigable — the
          sr-only summary above is the quick overview, this is the detail. */}
      <table className="w-full text-sm">
        <caption className="sr-only">
          Monthly spend by category, with each category's Home-currency amount
          and share of the monthly total.
        </caption>
        <thead>
          <tr className="text-left text-muted-foreground">
            <th scope="col" className="py-1 pr-3 font-medium">
              Category
            </th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">
              Monthly
            </th>
            <th scope="col" className="py-1 text-right font-medium">
              Share
            </th>
          </tr>
        </thead>
        <tbody>
          {segments.map((seg, i) => (
            <tr key={seg.category} className="border-t border-border">
              <th scope="row" className="py-1 pr-3 text-left font-normal">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="inline-block h-2.5 w-2.5 rounded-sm"
                    style={{
                      background: "var(--accent)",
                      opacity: 1 - (i % 4) * 0.18,
                    }}
                  />
                  {seg.category}
                </span>
              </th>
              <td className="py-1 pr-3 text-right tabular-nums">
                {approx(formatMoney(seg.monthlyMinor), approximate)}
              </td>
              <td className="py-1 text-right tabular-nums text-muted-foreground">
                {sharePct(seg.monthlyMinor, totalMinor)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Horizontal bar chart of Home-currency monthly spend per category (Req 11.2).
 * Each decorative inline-SVG bar is `aria-hidden`; the chart carries BOTH an
 * `sr-only` summary AND the keyboard-reachable `<table>` detail (Req 22.3).
 */
function CategoryBars({
  categories,
  totalMinor,
  formatMoney,
  approximate,
}: {
  categories: CategoryFigure[];
  totalMinor: number;
  formatMoney: (minor: number) => string;
  approximate: boolean;
}): JSX.Element {
  const max = categories.reduce((m, c) => Math.max(m, c.monthlyMinor), 0) || 1;

  const summary =
    categories.length === 0
      ? "No category spend to display."
      : "Home-currency monthly spend per category: " +
        categories
          .map(
            (c) =>
              `${c.category} ${approx(formatMoney(c.monthlyMinor), approximate)}, ${sharePct(
                c.monthlyMinor,
                totalMinor,
              )}%`,
          )
          .join("; ") +
        ".";

  return (
    <div className="space-y-3">
      <p className="sr-only">{summary}</p>

      {/* Decorative bars (aria-hidden) — the keyboard data lives in the table. */}
      <ul aria-hidden="true" className="space-y-3">
        {categories.map((c) => {
          const barPct = (c.monthlyMinor / max) * 100;
          return (
            <li key={c.category} className="space-y-1">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="font-medium">{c.category}</span>
                <span className="text-muted-foreground tabular-nums">
                  {approx(formatMoney(c.monthlyMinor), approximate)}
                  <span className="ml-2">
                    {sharePct(c.monthlyMinor, totalMinor)}%
                  </span>
                </span>
              </div>
              <svg
                aria-hidden="true"
                viewBox="0 0 100 6"
                preserveAspectRatio="none"
                className="h-2.5 w-full overflow-hidden rounded-full bg-muted"
                role="presentation"
              >
                <rect x={0} y={0} width={barPct} height={6} rx={0} fill="var(--accent)" />
              </svg>
            </li>
          );
        })}
      </ul>

      {/* Keyboard-reachable data equivalent (Req 22.3). */}
      <table className="w-full text-sm">
        <caption className="sr-only">
          Home-currency monthly spend per category, with each category's amount
          and share of the monthly total.
        </caption>
        <thead>
          <tr className="text-left text-muted-foreground">
            <th scope="col" className="py-1 pr-3 font-medium">
              Category
            </th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">
              Monthly
            </th>
            <th scope="col" className="py-1 text-right font-medium">
              Share
            </th>
          </tr>
        </thead>
        <tbody>
          {categories.map((c) => (
            <tr key={c.category} className="border-t border-border">
              <th scope="row" className="py-1 pr-3 text-left font-normal">
                {c.category}
              </th>
              <td className="py-1 pr-3 text-right tabular-nums">
                {approx(formatMoney(c.monthlyMinor), approximate)}
              </td>
              <td className="py-1 text-right tabular-nums text-muted-foreground">
                {sharePct(c.monthlyMinor, totalMinor)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Ranked list of the most expensive subscriptions by Home-converted monthly
 * amount (Req 11.4). Already an `<ol>` — navigable by keyboard/AT, so it is its
 * own text alternative (plus the per-row visible label + value).
 */
function MostExpensiveList({
  subs,
  formatMoney,
  approximate,
}: {
  subs: RankedSub[];
  formatMoney: (minor: number) => string;
  approximate: boolean;
}): JSX.Element {
  return (
    <ol className="space-y-2">
      {subs.map(({ sub: s, monthlyMinor }, i) => (
        <li
          key={s.id}
          className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
        >
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
              {i + 1}
            </span>
            <div className="min-w-0">
              <p className="truncate font-medium">{s.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {s.category} · {s.billingCycle}
              </p>
            </div>
          </div>
          <span className="shrink-0 font-medium tabular-nums">
            {approx(formatMoney(monthlyMinor), approximate)}
            <span className="ml-1 text-xs font-normal text-muted-foreground">
              /mo
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Vertical timeline of upcoming renewals grouped by date (Req 11.5). Dates are
 * ascending; each group lists the subscriptions due that day. Already an `<ol>`
 * — navigable by keyboard/AT. Each renewal shows its NATIVE amount/currency (an
 * individual line's charge, not a converted Home total), so no FX conversion is
 * needed here — it is a factual per-sub figure, not a summed total.
 */
function RenewalTimeline({
  timeline,
}: {
  timeline: { date: string; subs: SubscriptionV2[] }[];
}): JSX.Element {
  if (timeline.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No upcoming renewals.</p>
    );
  }

  return (
    <ol className="space-y-4 border-l border-border pl-4">
      {timeline.map((group) => (
        <li key={group.date} className="relative">
          <span
            aria-hidden="true"
            className="absolute -left-[1.4rem] top-1.5 h-2.5 w-2.5 rounded-full"
            style={{ background: "var(--accent)" }}
          />
          <p className="text-sm font-medium">{formatDate(group.date)}</p>
          <ul className="mt-1 space-y-0.5">
            {group.subs.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <span className="truncate text-muted-foreground">{s.name}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {s.currency} {safeToMajor(s.amountMinor, s.currency)}
                </span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}
