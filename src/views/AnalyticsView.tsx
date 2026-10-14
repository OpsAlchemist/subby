/**
 * Analytics view (lazy-loaded) — task 24.
 *
 * Presents lightweight spending analytics built entirely from the
 * platform-independent `core/analytics` aggregations (no recomputation here):
 *
 *   - Monthly spend            (Req 11.1) — `totalMonthly(active)`
 *   - Category distribution    (Req 11.2) — `categoryDistribution(active)`
 *   - Yearly projection        (Req 11.3) — `totalYearly(active)`
 *   - Most expensive           (Req 11.4) — `topByMonthly(active, n)`
 *   - Renewal timeline         (Req 11.5) — `renewalTimeline(subs, today)`
 *
 * Charts are hand-rolled inline <svg> elements (no heavy chart library) to keep
 * the bundle small and idle memory low (Req 21.2). Every chart is decorative
 * (`aria-hidden`) and paired with visible text labels + values so it always has
 * a text alternative for assistive technology (Req 22.3).
 *
 * The view re-renders whenever the subscriptions store changes (Req 8.6) via the
 * `useStoreData` hook. This file MUST keep a default export for `React.lazy`.
 */

import { useMemo } from "react";
import {
  categoryDistribution,
  renewalTimeline,
  topByMonthly,
  totalMonthly,
  totalYearly,
} from "core/analytics";
import { activeSpendSubscriptionsV2 } from "core/subscriptionsV2";
import { monthlyAmount } from "core/billing";
import { toMajor } from "core/money";
import type { SubscriptionV2 } from "core/models/subscription";
import { subscriptionsStore } from "@/stores";
import { useStoreData } from "@/stores/hooks";

/** Number of "most expensive" subscriptions to surface (Req 11.4). */
const TOP_N = 5;

/** Single-currency (INR) money formatter — totals are summed directly (Req 6). */
const money = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

/**
 * Scale a summed **minor-unit** figure to INR major units for display. Story 3.3
 * totals are a direct same-currency minor-unit sum (no FX); INR is 2-decimal, so
 * dividing by 100 renders the major amount this view formats. The convert-before-
 * sum Home total is Epic 6.
 */
function toMajorNumber(minor: number): number {
  return minor / 100;
}

/** Friendly date formatter for the renewal timeline. */
const dateFmt = new Intl.DateTimeFormat("en-IN", {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** Format an ISO `YYYY-MM-DD` date for display (parsed in UTC to avoid drift). */
function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map((p) => Number.parseInt(p, 10));
  return dateFmt.format(new Date(Date.UTC(y, m - 1, d)));
}

export default function AnalyticsView(): JSX.Element {
  const subscriptions = useStoreData(subscriptionsStore);

  // `today` is read once per render; core functions stay pure (date injected).
  const today = new Date().toISOString().slice(0, 10);

  const analytics = useMemo(() => {
    const active = activeSpendSubscriptionsV2(subscriptions);
    return {
      active,
      monthly: totalMonthly(active),
      yearly: totalYearly(active),
      categories: categoryDistribution(active),
      mostExpensive: topByMonthly(active, TOP_N),
      timeline: renewalTimeline(subscriptions, today),
    };
  }, [subscriptions, today]);

  const { active, monthly, yearly, categories, mostExpensive, timeline } =
    analytics;

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
      ) : (
        <>
          {/* Headline figures: monthly spend (Req 11.1) + yearly projection (Req 11.3) */}
          <div className="grid gap-4 sm:grid-cols-2">
            <StatCard
              label="Monthly spend"
              value={money.format(Math.round(toMajorNumber(monthly)))}
              hint="Sum of normalized monthly amounts"
            />
            <StatCard
              label="Yearly projection"
              value={money.format(Math.round(toMajorNumber(yearly)))}
              hint="Projected from current active subscriptions"
            />
          </div>

          {/* Monthly spend composition by category (Req 11.1) */}
          <Card>
            <CardHeader
              title="Monthly spend by category"
              subtitle="Share of your normalized monthly spend"
            />
            <StackedBar segments={categories} total={monthly} />
          </Card>

          {/* Category distribution (Req 11.2) */}
          <Card>
            <CardHeader
              title="Category distribution"
              subtitle="Normalized monthly spend per category"
            />
            <CategoryBars categories={categories} total={monthly} />
          </Card>

          {/* Most expensive subscriptions (Req 11.4) */}
          <Card>
            <CardHeader
              title="Most expensive"
              subtitle={`Top ${Math.min(TOP_N, mostExpensive.length)} by monthly amount`}
            />
            <MostExpensiveList subs={mostExpensive} />
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
}: {
  label: string;
  value: string;
  hint: string;
}): JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card p-5 text-card-foreground">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-3xl font-semibold tracking-tight">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

type CategorySlice = { category: string; monthly: number };

/**
 * A single horizontal stacked bar showing each category's share of the monthly
 * total. The SVG is decorative (`aria-hidden`); the legend below provides the
 * accessible text alternative (label + value + percentage).
 */
function StackedBar({
  segments,
  total,
}: {
  segments: CategorySlice[];
  total: number;
}): JSX.Element {
  const safeTotal = total > 0 ? total : 1;
  let offset = 0;
  const width = 100; // percentage-based viewBox for fluid layout

  // Concise text alternative for the decorative SVG (Req 22.3): names each
  // segment with its share of the monthly total.
  const summary =
    segments.length === 0
      ? "No spend to display."
      : `Monthly spend by category, total ${money.format(Math.round(toMajorNumber(total)))}: ` +
        segments
          .map(
            (seg) =>
              `${seg.category} ${Math.round((seg.monthly / safeTotal) * 100)}%`,
          )
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
          const w = (seg.monthly / safeTotal) * width;
          const x = offset;
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
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {segments.map((seg, i) => (
          <li key={seg.category} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ background: "var(--accent)", opacity: 1 - (i % 4) * 0.18 }}
            />
            <span>{seg.category}</span>
            <span className="text-muted-foreground">
              {Math.round((seg.monthly / safeTotal) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Horizontal bar chart of monthly spend per category (Req 11.2). Each row pairs
 * a decorative inline-SVG bar with a visible label and value, so the chart
 * always carries a text alternative (Req 22.3).
 */
function CategoryBars({
  categories,
  total,
}: {
  categories: CategorySlice[];
  total: number;
}): JSX.Element {
  const max = categories.reduce((m, c) => Math.max(m, c.monthly), 0) || 1;
  const safeTotal = total > 0 ? total : 1;

  // Text alternative for the per-category bars (Req 22.3): each decorative bar
  // is mirrored here as label, amount, and percentage of the monthly total.
  const summary =
    categories.length === 0
      ? "No category spend to display."
      : "Normalized monthly spend per category: " +
        categories
          .map(
            (c) =>
              `${c.category} ${money.format(Math.round(toMajorNumber(c.monthly)))}, ${Math.round(
                (c.monthly / safeTotal) * 100,
              )}%`,
          )
          .join("; ") +
        ".";

  return (
    <ul className="space-y-3">
      <li className="sr-only">{summary}</li>
      {categories.map((c) => {
        const pct = Math.round((c.monthly / safeTotal) * 100);
        const barPct = (c.monthly / max) * 100;
        return (
          <li key={c.category} className="space-y-1">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="font-medium">{c.category}</span>
              <span className="text-muted-foreground">
                {money.format(Math.round(toMajorNumber(c.monthly)))}
                <span className="ml-2 tabular-nums">{pct}%</span>
              </span>
            </div>
            <svg
              aria-hidden="true"
              viewBox="0 0 100 6"
              preserveAspectRatio="none"
              className="h-2.5 w-full overflow-hidden rounded-full bg-muted"
              role="presentation"
            >
              <rect
                x={0}
                y={0}
                width={barPct}
                height={6}
                rx={0}
                fill="var(--accent)"
              />
            </svg>
          </li>
        );
      })}
    </ul>
  );
}

/** Ranked list of the most expensive subscriptions by monthly amount (Req 11.4). */
function MostExpensiveList({ subs }: { subs: SubscriptionV2[] }): JSX.Element {
  return (
    <ol className="space-y-2">
      {subs.map((s, i) => (
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
            {money.format(Math.round(toMajorNumber(monthlyAmount(s))))}
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
 * ascending; each group lists the subscriptions due that day.
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
                  {s.currency} {toMajor(s.amountMinor, s.currency)}
                </span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

// --- Local helpers -----------------------------------------------------------

/* Monthly normalization is delegated to `core/billing.monthlyAmount` so this
 * view never recomputes aggregation logic; all figures derive from `core`. */

