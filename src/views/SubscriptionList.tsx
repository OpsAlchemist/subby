/**
 * Subscription List view (task 21.1, Req 9.1–9.7).
 *
 * A searchable, sortable, filterable, groupable list of subscriptions with
 * multi-select bulk actions and inline quick-edit. It reads live data from the
 * client stores (re-rendering on `onDataChanged` via `useSyncExternalStore`)
 * and performs every derivation with the platform-independent `core/` helpers
 * rather than re-implementing them:
 *
 *   - search   → `core/search.fuzzySearch`            (Req 9.2)
 *   - filter   → `core/subscriptions` predicates      (Req 9.4)
 *   - amount   → `core/billing.monthlyAmount` (sort)  (Req 9.3)
 *
 * Sorting (Req 9.3) and grouping (Req 9.5) have no generic `core` equivalent,
 * so they are small local, pure helpers below. Mutations go through the typed
 * `subscriptionsApi` wrapper; the main process persists, advances `updatedAt`,
 * and broadcasts `onDataChanged`, which reloads the store (Req 9.6, 9.7). API
 * failures throw `SubbyError`; they are caught and logged here while the global
 * error surface (Req 19.4) reports them to the user.
 *
 * Layout is responsive (Req 22): a semantic `<table>` on wide viewports and a
 * card list on narrow ones. Controls are labelled, keyboard-operable, and show
 * visible focus rings.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Pause,
  Pencil,
  Power,
  Search,
  Trash2,
} from "lucide-react";
import type {
  BillingCycle,
  SubscriptionState,
  SubscriptionV2,
} from "core/models/subscription";
import { fuzzySearch } from "core/search";
import { minorUnits, toMajor } from "core/money";
import { monthlyAmount } from "core/billing";
import { subscriptionsApi, isSubbyError } from "@/api/subby";
import { subscriptionsStore } from "@/stores/subscriptionsStore";
import { categoriesStore } from "@/stores/categoriesStore";
import { useStoreData } from "@/stores/hooks";
import { cn } from "@/lib/utils";

// --- Local types -------------------------------------------------------------

/** Columns the user can sort by (Req 9.3). */
type SortColumn = "name" | "amount" | "nextRenewal" | "status";
/** Sort direction toggled by clicking a sortable header. */
type SortDir = "asc" | "desc";
/** The attribute the list is grouped by (Req 9.5). */
type GroupBy = "none" | "category" | "status";
/** State filter selection (Req 9.4) — the three-way v2 State plus "all". */
type StatusFilter = "all" | SubscriptionState;
/** The currently quick-edited cell (Req 9.7). */
interface EditState {
  id: string;
  field: "amount" | "nextRenewal";
  value: string;
}

/** All billing cycles, for the cycle filter control. */
const BILLING_CYCLES: readonly BillingCycle[] = [
  "Weekly",
  "Monthly",
  "Quarterly",
  "Half-Yearly",
  "Yearly",
  "Custom",
];

/**
 * Shared focus-ring utility matching the app shell so every interactive control
 * has a visible, consistent keyboard focus indicator (Req 22.1, 22.3).
 */
const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

const controlClass = cn(
  "h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground",
  focusRing,
);

// --- Pure display + ordering helpers -----------------------------------------

/**
 * Format a subscription's native amount (integer minor units) in its own
 * currency, falling back gracefully. The minor units are rendered to a major
 * display string via the money seam, then formatted.
 */
function formatCurrency(amountMinor: number, currency: string): string {
  const major = toMajor(amountMinor, currency);
  const amount = Number(major);
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(amount);
  } catch {
    return `${currency} ${major}`;
  }
}

/** Numeric order of the three states for a stable Status sort (Active→Trial→Paused). */
const STATE_ORDER: Record<SubscriptionState, number> = {
  Active: 0,
  Trial: 1,
  Paused: 2,
};

/** Format an ISO `YYYY-MM-DD` date into a short, human-readable form. */
function formatDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Comparator for a given sort column (ascending order). */
function compareBy(a: SubscriptionV2, b: SubscriptionV2, column: SortColumn): number {
  switch (column) {
    case "name":
      return a.name.localeCompare(b.name);
    case "amount":
      return monthlyAmount(a) - monthlyAmount(b);
    case "nextRenewal":
      return a.nextRenewal < b.nextRenewal
        ? -1
        : a.nextRenewal > b.nextRenewal
          ? 1
          : 0;
    case "status":
      // Active → Trial → Paused in ascending order.
      return STATE_ORDER[a.state] - STATE_ORDER[b.state];
  }
}

/**
 * Return a sorted copy of `subs` by `column`/`dir` (Req 9.3). When no column is
 * selected the input order is preserved (e.g. fuzzy-search relevance order).
 * The input array is never mutated.
 */
function sortSubscriptions(
  subs: SubscriptionV2[],
  column: SortColumn | null,
  dir: SortDir,
): SubscriptionV2[] {
  if (!column) return subs;
  const sorted = [...subs].sort((a, b) => compareBy(a, b, column));
  return dir === "desc" ? sorted.reverse() : sorted;
}

/** A displayed group of rows (Req 9.5). `label` is empty for the ungrouped case. */
interface RowGroup {
  key: string;
  label: string;
  items: SubscriptionV2[];
}

/**
 * Partition `subs` into ordered groups by the selected attribute (Req 9.5),
 * preserving the incoming row order within each group. With `groupBy === "none"`
 * a single unlabeled group containing every row is returned.
 */
function groupSubscriptions(subs: SubscriptionV2[], groupBy: GroupBy): RowGroup[] {
  if (groupBy === "none") return [{ key: "all", label: "", items: subs }];

  const order: string[] = [];
  const map = new Map<string, SubscriptionV2[]>();
  for (const s of subs) {
    const key =
      groupBy === "category"
        ? s.category || "Uncategorized"
        : s.state; // group by the three-way State (Active / Paused / Trial)
    const bucket = map.get(key);
    if (bucket) {
      bucket.push(s);
    } else {
      order.push(key);
      map.set(key, [s]);
    }
  }
  return order.map((key) => ({ key, label: key, items: map.get(key)! }));
}

// --- Component ---------------------------------------------------------------

/**
 * The Subscription List view. See the module docstring for the derivation
 * pipeline and accessibility/responsiveness notes.
 */
export default function SubscriptionList(): JSX.Element {
  const subscriptions = useStoreData(subscriptionsStore);
  const categories = useStoreData(categoriesStore);

  const [query, setQuery] = useState("");
  const [sortColumn, setSortColumn] = useState<SortColumn | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [filterCategory, setFilterCategory] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<StatusFilter>("all");
  const [filterCycle, setFilterCycle] = useState<BillingCycle | "all">("all");
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<EditState | null>(null);

  // Ref to the header "select all" checkbox so we can drive its indeterminate
  // visual state (partial selection) — not expressible declaratively in React.
  const selectAllRef = useRef<HTMLInputElement>(null);

  // --- Derivation pipeline: search → filter → sort → group -------------------

  const searched = useMemo(
    () => fuzzySearch(subscriptions, query), // Req 9.2
    [subscriptions, query],
  );

  const filtered = useMemo(() => {
    // Compose the active filters inline over the v2 shape (Req 9.4): Category by
    // name, State by the three-way enum, Billing Cycle by value.
    return searched.filter((s) => {
      if (filterCategory !== "all" && s.category !== filterCategory) return false;
      if (filterStatus !== "all" && s.state !== filterStatus) return false;
      if (filterCycle !== "all" && s.billingCycle !== filterCycle) return false;
      return true;
    });
  }, [searched, filterCategory, filterStatus, filterCycle]);

  const sorted = useMemo(
    () => sortSubscriptions(filtered, sortColumn, sortDir), // Req 9.3
    [filtered, sortColumn, sortDir],
  );

  const groups = useMemo(
    () => groupSubscriptions(sorted, groupBy), // Req 9.5
    [sorted, groupBy],
  );

  // Visible ids drive the "select all" checkbox + bulk action scope.
  const visibleIds = useMemo(() => sorted.map((s) => s.id), [sorted]);

  // Prune selections that are no longer visible (filtered out / deleted).
  useEffect(() => {
    setSelectedIds((prev) => {
      const next = new Set<string>();
      for (const id of prev) if (visibleIds.includes(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
  }, [visibleIds]);

  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const someVisibleSelected = visibleIds.some((id) => selectedIds.has(id));

  // Reflect partial selection as the checkbox's indeterminate state.
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someVisibleSelected && !allVisibleSelected;
    }
  }, [someVisibleSelected, allVisibleSelected]);

  // --- Handlers --------------------------------------------------------------

  /** Toggle a sortable column: same column flips direction, new column resets to asc (Req 9.3). */
  function toggleSort(column: SortColumn): void {
    if (sortColumn === column) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortColumn(column);
      setSortDir("asc");
    }
  }

  function toggleRow(id: string): void {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll(): void {
    setSelectedIds(allVisibleSelected ? new Set() : new Set(visibleIds));
  }

  /** Apply a State change to every selected subscription via setState (Req 9.6, AD-17). */
  async function bulkSetState(state: SubscriptionState): Promise<void> {
    const ids = [...selectedIds];
    setSelectedIds(new Set());
    for (const id of ids) {
      try {
        await subscriptionsApi.setState(id, state);
      } catch (err) {
        // Global error surface (Req 19.4) reports failures; log and continue.
        if (isSubbyError(err)) console.error(err.appError);
        else console.error(err);
      }
    }
  }

  /** Delete every selected subscription after confirmation (Req 9.6). */
  async function bulkDelete(): Promise<void> {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const confirmed =
      typeof window === "undefined" ||
      typeof window.confirm !== "function" ||
      window.confirm(
        `Delete ${ids.length} subscription${ids.length === 1 ? "" : "s"}? This cannot be undone.`,
      );
    if (!confirmed) return;
    setSelectedIds(new Set());
    for (const id of ids) {
      try {
        await subscriptionsApi.remove(id);
      } catch (err) {
        if (isSubbyError(err)) console.error(err.appError);
        else console.error(err);
      }
    }
  }

  function startEdit(sub: SubscriptionV2, field: EditState["field"]): void {
    setEdit({
      id: sub.id,
      field,
      // Amount is edited as a MAJOR-unit string (rendered from the stored minor
      // units); next renewal is the raw ISO date.
      value:
        field === "amount"
          ? toMajor(sub.amountMinor, sub.currency)
          : sub.nextRenewal,
    });
  }

  /** Persist the current quick-edit via the api (sets `updatedAt`) (Req 9.7). */
  async function commitEdit(): Promise<void> {
    if (!edit) return;
    const current = edit;
    const sub = subscriptions.find((s) => s.id === current.id);
    setEdit(null);

    let patch: { amountMinor: number } | { nextRenewal: string } | null = null;
    if (current.field === "amount") {
      // Parse the entered MAJOR amount into integer minor units in the sub's
      // own currency through the money seam. Invalid/over-precise input throws,
      // which we treat as a discarded edit (Story 3.5 adds the inline error).
      if (sub) {
        try {
          patch = { amountMinor: minorUnits(current.value, sub.currency) };
        } catch {
          patch = null;
        }
      }
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(current.value)) {
      patch = { nextRenewal: current.value };
    }
    if (!patch) return; // invalid input: discard the edit silently

    try {
      await subscriptionsApi.update(current.id, patch); // Req 9.7
    } catch (err) {
      if (isSubbyError(err)) console.error(err.appError);
      else console.error(err);
    }
  }

  function onEditKeyDown(e: React.KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      void commitEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setEdit(null);
    }
  }

  // --- Render ----------------------------------------------------------------

  const hasSubscriptions = subscriptions.length > 0;
  const hasResults = sorted.length > 0;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight">Subscriptions</h2>
        <p className="text-sm text-muted-foreground">
          {subscriptions.length} total
          {sorted.length !== subscriptions.length
            ? ` \u00b7 ${sorted.length} shown`
            : ""}
        </p>
      </div>

      {/* Toolbar: search + filters + grouping (Req 9.2, 9.4, 9.5). */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1">
          <label htmlFor="sub-search" className="sr-only">
            Search subscriptions
          </label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              id="sub-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or provider..."
              className={cn(controlClass, "w-full pl-9")}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="filter-category" className="text-xs text-muted-foreground">
            Category
          </label>
          <select
            id="filter-category"
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            className={controlClass}
          >
            <option value="all">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="filter-status" className="text-xs text-muted-foreground">
            State
          </label>
          <select
            id="filter-status"
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value as StatusFilter)}
            className={controlClass}
          >
            <option value="all">All states</option>
            <option value="Active">Active</option>
            <option value="Trial">Trial</option>
            <option value="Paused">Paused</option>
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="filter-cycle" className="text-xs text-muted-foreground">
            Cycle
          </label>
          <select
            id="filter-cycle"
            value={filterCycle}
            onChange={(e) => setFilterCycle(e.target.value as BillingCycle | "all")}
            className={controlClass}
          >
            <option value="all">All cycles</option>
            {BILLING_CYCLES.map((cycle) => (
              <option key={cycle} value={cycle}>
                {cycle}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="group-by" className="text-xs text-muted-foreground">
            Group by
          </label>
          <select
            id="group-by"
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as GroupBy)}
            className={controlClass}
          >
            <option value="none">No grouping</option>
            <option value="category">Category</option>
            <option value="status">Status</option>
          </select>
        </div>
      </div>

      {/* Bulk actions bar (Req 9.6). */}
      {selectedIds.size > 0 && (
        <div
          role="region"
          aria-label="Bulk actions"
          className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2"
        >
          <span className="text-sm font-medium">
            {selectedIds.size} selected
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void bulkSetState("Active")}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border border-input px-2.5 py-1.5 text-sm hover:bg-secondary/60",
                focusRing,
              )}
            >
              <Power className="h-4 w-4" aria-hidden="true" />
              Set Active
            </button>
            <button
              type="button"
              onClick={() => void bulkSetState("Paused")}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border border-input px-2.5 py-1.5 text-sm hover:bg-secondary/60",
                focusRing,
              )}
            >
              <Pause className="h-4 w-4" aria-hidden="true" />
              Set Paused
            </button>
            <button
              type="button"
              onClick={() => void bulkDelete()}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border border-destructive/50 px-2.5 py-1.5 text-sm text-destructive hover:bg-destructive/10",
                focusRing,
              )}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              Delete
            </button>
          </div>
        </div>
      )}

      {/* Empty states. */}
      {!hasResults && (
        <div className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          {hasSubscriptions
            ? "No subscriptions match the current search and filters."
            : "No subscriptions yet. Add one to get started."}
        </div>
      )}

      {/* Wide layout: semantic table (Req 9.1, 22). */}
      {hasResults && (
        <div className="hidden overflow-x-auto rounded-md border border-border md:block">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">Subscriptions</caption>
            <thead>
              <tr className="border-b border-border bg-card text-left">
                <th scope="col" className="w-10 px-3 py-2">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAll}
                    aria-label="Select all subscriptions"
                    className={cn("h-4 w-4 rounded border-input", focusRing)}
                  />
                </th>
                <SortableHeader
                  label="Name"
                  column="name"
                  sortColumn={sortColumn}
                  sortDir={sortDir}
                  onToggle={toggleSort}
                />
                <th scope="col" className="px-3 py-2 font-medium">
                  Category
                </th>
                <SortableHeader
                  label="Amount"
                  column="amount"
                  sortColumn={sortColumn}
                  sortDir={sortDir}
                  onToggle={toggleSort}
                />
                <SortableHeader
                  label="Next renewal"
                  column="nextRenewal"
                  sortColumn={sortColumn}
                  sortDir={sortDir}
                  onToggle={toggleSort}
                />
                <th scope="col" className="px-3 py-2 font-medium">
                  Cycle
                </th>
                <SortableHeader
                  label="Status"
                  column="status"
                  sortColumn={sortColumn}
                  sortDir={sortDir}
                  onToggle={toggleSort}
                />
              </tr>
            </thead>
            {groups.map((group) => (
              <tbody key={group.key}>
                {group.label && (
                  <tr className="border-b border-border bg-secondary/40">
                    <th
                      scope="colgroup"
                      colSpan={7}
                      className="px-3 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                    >
                      {group.label}{" "}
                      <span className="font-normal normal-case">
                        ({group.items.length})
                      </span>
                    </th>
                  </tr>
                )}
                {group.items.map((sub) => (
                  <tr
                    key={sub.id}
                    className={cn(
                      "border-b border-border last:border-0",
                      selectedIds.has(sub.id) && "bg-secondary/30",
                    )}
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(sub.id)}
                        onChange={() => toggleRow(sub.id)}
                        aria-label={`Select ${sub.name}`}
                        className={cn("h-4 w-4 rounded border-input", focusRing)}
                      />
                    </td>
                    <td className="px-3 py-2 font-medium">
                      {sub.name}
                      {sub.provider && (
                        <span className="block text-xs text-muted-foreground">
                          {sub.provider}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {sub.category}
                    </td>
                    <td className="px-3 py-2">
                      {edit && edit.id === sub.id && edit.field === "amount" ? (
                        <input
                          autoFocus
                          type="number"
                          min={0}
                          step="0.01"
                          value={edit.value}
                          onChange={(e) =>
                            setEdit({ ...edit, value: e.target.value })
                          }
                          onBlur={() => void commitEdit()}
                          onKeyDown={onEditKeyDown}
                          aria-label={`Edit amount for ${sub.name}`}
                          className={cn(controlClass, "h-8 w-28")}
                        />
                      ) : (
                        <QuickEditButton
                          label={`Edit amount for ${sub.name}`}
                          onClick={() => startEdit(sub, "amount")}
                        >
                          {formatCurrency(sub.amountMinor, sub.currency)}
                        </QuickEditButton>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {edit &&
                      edit.id === sub.id &&
                      edit.field === "nextRenewal" ? (
                        <input
                          autoFocus
                          type="date"
                          value={edit.value}
                          onChange={(e) =>
                            setEdit({ ...edit, value: e.target.value })
                          }
                          onBlur={() => void commitEdit()}
                          onKeyDown={onEditKeyDown}
                          aria-label={`Edit next renewal for ${sub.name}`}
                          className={cn(controlClass, "h-8")}
                        />
                      ) : (
                        <QuickEditButton
                          label={`Edit next renewal for ${sub.name}`}
                          onClick={() => startEdit(sub, "nextRenewal")}
                        >
                          {formatDate(sub.nextRenewal)}
                        </QuickEditButton>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {sub.billingCycle}
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge state={sub.state} />
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}

      {/* Narrow layout: cards (Req 9.1, 22). */}
      {hasResults && (
        <div className="space-y-4 md:hidden">
          {groups.map((group) => (
            <div key={group.key} className="space-y-2">
              {group.label && (
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.label}{" "}
                  <span className="font-normal normal-case">
                    ({group.items.length})
                  </span>
                </h3>
              )}
              {group.items.map((sub) => (
                <div
                  key={sub.id}
                  className={cn(
                    "rounded-md border border-border bg-card p-3",
                    selectedIds.has(sub.id) && "ring-1 ring-ring",
                  )}
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(sub.id)}
                      onChange={() => toggleRow(sub.id)}
                      aria-label={`Select ${sub.name}`}
                      className={cn("mt-1 h-4 w-4 rounded border-input", focusRing)}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate font-medium">{sub.name}</p>
                          {sub.provider && (
                            <p className="truncate text-xs text-muted-foreground">
                              {sub.provider}
                            </p>
                          )}
                        </div>
                        <StatusBadge state={sub.state} />
                      </div>
                      <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
                        <div>
                          <dt className="text-xs text-muted-foreground">
                            Category
                          </dt>
                          <dd>{sub.category}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-muted-foreground">Cycle</dt>
                          <dd>{sub.billingCycle}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-muted-foreground">Amount</dt>
                          <dd>
                            {edit &&
                            edit.id === sub.id &&
                            edit.field === "amount" ? (
                              <input
                                autoFocus
                                type="number"
                                min={0}
                                step="0.01"
                                value={edit.value}
                                onChange={(e) =>
                                  setEdit({ ...edit, value: e.target.value })
                                }
                                onBlur={() => void commitEdit()}
                                onKeyDown={onEditKeyDown}
                                aria-label={`Edit amount for ${sub.name}`}
                                className={cn(controlClass, "h-8 w-full")}
                              />
                            ) : (
                              <QuickEditButton
                                label={`Edit amount for ${sub.name}`}
                                onClick={() => startEdit(sub, "amount")}
                              >
                                {formatCurrency(sub.amountMinor, sub.currency)}
                              </QuickEditButton>
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs text-muted-foreground">
                            Next renewal
                          </dt>
                          <dd>
                            {edit &&
                            edit.id === sub.id &&
                            edit.field === "nextRenewal" ? (
                              <input
                                autoFocus
                                type="date"
                                value={edit.value}
                                onChange={(e) =>
                                  setEdit({ ...edit, value: e.target.value })
                                }
                                onBlur={() => void commitEdit()}
                                onKeyDown={onEditKeyDown}
                                aria-label={`Edit next renewal for ${sub.name}`}
                                className={cn(controlClass, "h-8 w-full")}
                              />
                            ) : (
                              <QuickEditButton
                                label={`Edit next renewal for ${sub.name}`}
                                onClick={() => startEdit(sub, "nextRenewal")}
                              >
                                {formatDate(sub.nextRenewal)}
                              </QuickEditButton>
                            )}
                          </dd>
                        </div>
                      </dl>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Subcomponents -----------------------------------------------------------

/**
 * A sortable column header rendered as a `<th>` with an embedded toggle button.
 * Exposes `aria-sort` so assistive tech announces the current ordering (Req 9.3,
 * 22.3).
 */
function SortableHeader({
  label,
  column,
  sortColumn,
  sortDir,
  onToggle,
}: {
  label: string;
  column: SortColumn;
  sortColumn: SortColumn | null;
  sortDir: SortDir;
  onToggle: (column: SortColumn) => void;
}): JSX.Element {
  const active = sortColumn === column;
  const ariaSort = active
    ? sortDir === "asc"
      ? "ascending"
      : "descending"
    : "none";
  const Icon = active ? (sortDir === "asc" ? ArrowUp : ArrowDown) : ChevronsUpDown;

  return (
    <th
      scope="col"
      aria-sort={ariaSort}
      className="px-3 py-2 font-medium"
    >
      <button
        type="button"
        onClick={() => onToggle(column)}
        className={cn(
          "inline-flex items-center gap-1 rounded text-left hover:text-foreground",
          active ? "text-foreground" : "text-muted-foreground",
          focusRing,
        )}
      >
        <span>{label}</span>
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </th>
  );
}

/** A clickable cell value that enters quick-edit mode (Req 9.7). */
function QuickEditButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        "group inline-flex items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-secondary/60",
        focusRing,
      )}
    >
      <span>{children}</span>
      <Pencil
        className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-60 group-focus-visible:opacity-60"
        aria-hidden="true"
      />
    </button>
  );
}

/**
 * The three-state State badge (Active / Paused / Trial). State is conveyed by a
 * visible TEXT label (never color alone, per the DESIGN state-badge rule) plus a
 * decorative leading dot that is `aria-hidden`:
 *   - Trial  = accent-tint fill + accent text + accent dot ("live but not yet charged").
 *   - Paused = muted fill + muted text (recedes).
 *   - Active = muted fill + foreground text + a neutral dot.
 */
function StatusBadge({ state }: { state: SubscriptionState }): JSX.Element {
  const styles: Record<SubscriptionState, { badge: string; dot: string }> = {
    Active: {
      badge: "bg-muted text-foreground",
      dot: "bg-foreground/60",
    },
    Trial: {
      badge: "bg-accent/15 text-accent",
      dot: "bg-accent",
    },
    Paused: {
      badge: "bg-muted text-muted-foreground",
      dot: "bg-muted-foreground",
    },
  };
  const { badge, dot } = styles[state];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium",
        badge,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("inline-block h-1.5 w-1.5 rounded-full", dot)}
      />
      {state}
    </span>
  );
}
