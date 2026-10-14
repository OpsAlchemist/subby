/**
 * Dashboard view (task 20.1, Req 8.1–8.6).
 *
 * An at-a-glance overview of subscription spending. It reads the live
 * subscription list and settings from the client stores via
 * `useStoreData`/`useStore` (`useSyncExternalStore` adapters), so it
 * re-renders whenever subscription data changes after any mutation (Req 8.6) —
 * the stores are reloaded on the `onDataChanged` broadcast by `initStores`.
 *
 * All derived figures come from the platform-independent `core/analytics`
 * module (recomputed via `useMemo` keyed on the current data):
 *   - Total monthly spend of active subscriptions (Req 8.1)
 *   - Total yearly spend of active subscriptions (Req 8.2)
 *   - Count of active subscriptions (Req 8.3)
 *   - Subscriptions renewing within the next seven days (Req 8.4)
 *   - The most recently changed subscriptions, `updatedAt` descending (Req 8.5)
 *
 * For this build all amounts are a single currency (INR); totals are summed
 * directly with no conversion and formatted with `Intl.NumberFormat` using the
 * configured default currency.
 */

import { useMemo } from "react";
import {
  CalendarClock,
  History,
  IndianRupee,
  CalendarRange,
  ListChecks,
  type LucideIcon,
} from "lucide-react";
import type { SubscriptionV2 } from "core/models/subscription";
import { activeSpendSubscriptionsV2 } from "core/subscriptionsV2";
import {
  activeCount,
  recentlyChanged,
  renewingWithin,
  totalMonthly,
  totalYearly,
} from "core/analytics";
import { exponentOf } from "core/money";
import { subscriptionsStore, settingsStore } from "@/stores";
import { useStoreData } from "@/stores/hooks";

/** Number of upcoming days considered "renewing soon" on the dashboard (Req 8.4). */
const RENEWAL_WINDOW_DAYS = 7;

/** How many "recently changed" subscriptions to surface (Req 8.5). */
const RECENT_CHANGED_COUNT = 5;

/** Today as an ISO date (`YYYY-MM-DD`); passed to the pure analytics helpers. */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Convert a summed **minor-unit** total into a major-unit number for the
 * currency formatter. Story 3.3 keeps totals a direct same-currency minor-unit
 * sum (no FX; the convert-before-sum Home total is Epic 6), so a scale by the
 * Home Currency's exponent is the honest display of that sum. An unknown
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

/** Build a currency formatter for the configured default currency (INR here). */
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

/** A single metric card: a label, a prominent value, and an icon. */
function MetricCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: LucideIcon;
}): JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-muted-foreground">
          {label}
        </span>
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-tight">{value}</p>
    </div>
  );
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
              <span className="min-w-0 truncate font-medium">{s.name}</span>
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

/**
 * Dashboard overview (Req 8). Default export so the application shell can
 * eager-import it (`@/views/Dashboard`).
 */
export default function Dashboard(): JSX.Element {
  const subs = useStoreData(subscriptionsStore);
  const settings = useStoreData(settingsStore);

  const today = todayISO();

  // Recompute derived metrics only when the inputs change (Req 8.6). The month/
  // year totals sum the plain-Active subset only (Trials excluded, Paused
  // excluded — AD-17); the "Active count" is Active + Trial via `activeCount`.
  const active = useMemo(() => activeSpendSubscriptionsV2(subs), [subs]);
  const monthlyMinor = useMemo(() => totalMonthly(active), [active]);
  const yearlyMinor = useMemo(() => totalYearly(active), [active]);
  const count = useMemo(() => activeCount(subs), [subs]);
  const renewingSoon = useMemo(
    () => renewingWithin(subs, RENEWAL_WINDOW_DAYS, today),
    [subs, today],
  );
  const recent = useMemo(
    () => recentlyChanged(subs, RECENT_CHANGED_COUNT),
    [subs],
  );

  const currency = useMemo(
    () => makeCurrencyFormatter(settings.homeCurrency),
    [settings.homeCurrency],
  );
  // Totals are minor-unit sums (Story 3.3, no FX); render in Home-Currency major.
  const monthly = minorToMajorNumber(monthlyMinor, settings.homeCurrency);
  const yearly = minorToMajorNumber(yearlyMinor, settings.homeCurrency);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight">Dashboard</h2>
        <p className="text-muted-foreground">
          Overview of your subscription spending.
        </p>
      </header>

      {/* Metric cards (Req 8.1, 8.2, 8.3). */}
      <section aria-label="Spending summary">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <MetricCard
            label="Total Monthly Spend"
            value={currency.format(monthly)}
            icon={IndianRupee}
          />
          <MetricCard
            label="Total Yearly Spend"
            value={currency.format(yearly)}
            icon={CalendarRange}
          />
          <MetricCard
            label="Active Subscriptions"
            value={String(count)}
            icon={ListChecks}
          />
        </div>
      </section>

      {/* Renewing soon + recently changed (Req 8.4, 8.5). */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
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
      </div>
    </div>
  );
}
