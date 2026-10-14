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

import { useEffect, useId, useMemo, useRef, useState } from "react";
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
import { distinctTags } from "core/subscriptions";
import { subscriptionsApi, isSubbyError } from "@/api/subby";
import { subscriptionsStore } from "@/stores/subscriptionsStore";
import { categoriesStore } from "@/stores/categoriesStore";
import { useStoreData } from "@/stores/hooks";
import { cn } from "@/lib/utils";
import CategoryColorDot from "@/components/CategoryColorDot";
import ConfirmDialog from "@/components/ConfirmDialog";

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
  /**
   * An inline validation message shown (via `role="alert"`) when an invalid
   * commit kept the editor open. Absent while the current value is unvalidated
   * or valid (Req 9.7 / Story 3.5 — invalid input is never silently discarded).
   */
  error?: string;
}

/** Inline-validation copy for a rejected quick-edit commit (Story 3.5). */
const QUICK_EDIT_ERRORS = {
  amount: "Enter a valid amount (e.g. 12.50).",
  nextRenewal: "Enter a valid date (YYYY-MM-DD).",
} as const;

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
 * Props for the Subscription List view. Both are optional so the view renders
 * standalone (e.g. via the nav rail) and only receives a highlight when reached
 * through the Global Search palette (Story 3.6, FR-5).
 */
export interface SubscriptionListProps {
  /**
   * A subscription id to transiently highlight once (set by App when a palette
   * result is chosen). The view scrolls that row into view and paints a
   * decorative accent-TINT highlight, then calls {@link onHighlightConsumed}.
   * It is NEVER merged into `selectedIds` and NEVER persisted.
   */
  highlightId?: string | null;
  /** Called after the highlight has been applied so App can clear `highlightId`. */
  onHighlightConsumed?: () => void;
}

/**
 * How long the transient palette-arrival highlight stays painted before it is
 * cleared (Story 3.6). Short enough to read as a flash, long enough to notice.
 */
const HIGHLIGHT_DURATION_MS = 2000;

/**
 * The Subscription List view. See the module docstring for the derivation
 * pipeline and accessibility/responsiveness notes.
 */
export default function SubscriptionList({
  highlightId = null,
  onHighlightConsumed,
}: SubscriptionListProps = {}): JSX.Element {
  const subscriptions = useStoreData(subscriptionsStore);
  const categories = useStoreData(categoriesStore);

  const [query, setQuery] = useState("");
  const [sortColumn, setSortColumn] = useState<SortColumn | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [filterCategory, setFilterCategory] = useState<string>("all");
  const [filterTag, setFilterTag] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<StatusFilter>("all");
  const [filterCycle, setFilterCycle] = useState<BillingCycle | "all">("all");
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<EditState | null>(null);
  // The id of the row currently painted with the transient palette-arrival
  // highlight (Story 3.6). This is DECORATIVE accent-tint styling only — kept
  // entirely separate from `selectedIds` so it never entangles with bulk state.
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  // The pending bulk-delete request, if any — mounts the branded ConfirmDialog
  // naming the exact impact (count) instead of the native `window.confirm`.
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null);

  // Ref to the header "select all" checkbox so we can drive its indeterminate
  // visual state (partial selection) — not expressible declaratively in React.
  const selectAllRef = useRef<HTMLInputElement>(null);
  // The element that opened the current quick-edit (a QuickEditButton), so Esc
  // can return focus to the originating cell trigger (Req 9.7 / Story 3.5).
  const editTriggerRef = useRef<HTMLElement | null>(null);
  // Map of subscription id → its rendered row element for the palette-arrival
  // scroll target (Story 3.6). Both layouts (the wide `<tr>` and the narrow
  // card) can be in the DOM at once (jsdom, or during a CSS breakpoint change),
  // so the table row is PREFERRED when both are present; either is a correct
  // scroll target for the same subscription.
  const rowRefs = useRef<Map<string, HTMLElement>>(new Map());

  /**
   * Register a row element for `id`, preferring the table `<tr>` over the card.
   * Called from inline ref callbacks on both layouts; a `null` element (unmount)
   * only clears the map entry when it is the element being removed.
   */
  function registerRow(
    id: string,
    el: HTMLElement | null,
    isTableRow: boolean,
  ): void {
    if (el) {
      const existing = rowRefs.current.get(id);
      // The table row wins; a card never overwrites an already-registered row.
      if (isTableRow || !existing) rowRefs.current.set(id, el);
    } else {
      // Unmount: drop the entry only if it still points at THIS element's kind
      // (avoids a card unmount wiping a live table-row registration).
      const existing = rowRefs.current.get(id);
      if (existing && (existing.tagName === "TR") === isTableRow) {
        rowRefs.current.delete(id);
      }
    }
  }

  // --- Derivation pipeline: search → filter → sort → group -------------------

  const searched = useMemo(
    () => fuzzySearch(subscriptions, query), // Req 9.2
    [subscriptions, query],
  );

  const filtered = useMemo(() => {
    // Compose the active filters inline over the v2 shape (Req 9.4): Category by
    // name, Tag by membership, State by the three-way enum, Billing Cycle by
    // value. Filters intersect — a sub shows only if it matches every active
    // axis; an "all" selection on any axis is a no-op.
    return searched.filter((s) => {
      if (filterCategory !== "all" && s.category !== filterCategory) return false;
      if (filterTag !== "all" && !s.tags.includes(filterTag)) return false;
      if (filterStatus !== "all" && s.state !== filterStatus) return false;
      if (filterCycle !== "all" && s.billingCycle !== filterCycle) return false;
      return true;
    });
  }, [searched, filterCategory, filterTag, filterStatus, filterCycle]);

  // Distinct tag options for the Tag filter — the exact-case, first-seen set
  // across ALL subscriptions (not just the filtered view), via the pure core
  // helper. Keeps the option list stable as other filters narrow the rows.
  const tagOptions = useMemo(() => distinctTags(subscriptions), [subscriptions]);

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

  // --- Palette-arrival highlight (Story 3.6, FR-5) ---------------------------
  //
  // When App threads in a non-null `highlightId` (a subscription chosen in the
  // Cmd-K palette), scroll that row into view and paint a transient accent-TINT
  // highlight on it, then clear it after a short, reduced-motion-respecting
  // interval and tell App to drop the id. This never touches `selectedIds` or
  // the filter/sort/group pipeline. If the target is currently filtered OUT of
  // the view, the local search/filter state is reset FIRST so the row is always
  // reachable — a highlighted row the user cannot see would be useless.
  useEffect(() => {
    if (!highlightId) return;
    // The target must exist in the store to be highlightable at all.
    if (!subscriptions.some((s) => s.id === highlightId)) {
      onHighlightConsumed?.();
      return;
    }

    // If the row is hidden by the current local search/filters, clear them so
    // it becomes visible, then wait for the re-render (this effect re-runs when
    // `visibleIds` updates) before scrolling/painting.
    if (!visibleIds.includes(highlightId)) {
      setQuery("");
      setFilterCategory("all");
      setFilterTag("all");
      setFilterStatus("all");
      setFilterCycle("all");
      return;
    }

    // The row is now in the DOM: scroll it into view and paint the highlight.
    const node = rowRefs.current.get(highlightId);
    const reduceMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    node?.scrollIntoView({
      block: "nearest",
      behavior: reduceMotion ? "auto" : "smooth",
    });
    setHighlightedId(highlightId);
    // Clear App's id now that the highlight is applied (ephemeral — never
    // persisted). The painted tint lingers locally for the interval below.
    onHighlightConsumed?.();
    // `visibleIds` is a dep so the effect re-runs after filters are cleared.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightId, visibleIds]);

  // Clear the transient tint after its interval. Keyed on the LOCAL
  // `highlightedId`, NOT `highlightId` — App nulls `highlightId` synchronously
  // via `onHighlightConsumed`, which would otherwise re-run the effect above and
  // cancel this timer the instant the id is consumed, leaving the tint painted
  // forever. A separate effect keyed on the local state owns the lifecycle.
  useEffect(() => {
    if (!highlightedId) return;
    const timer = window.setTimeout(
      () => setHighlightedId(null),
      HIGHLIGHT_DURATION_MS,
    );
    return () => window.clearTimeout(timer);
  }, [highlightedId]);

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

  /**
   * Begin a bulk delete (Req 9.6). Instead of the native `window.confirm`, open
   * the branded in-app {@link ConfirmDialog} naming the exact count impact; the
   * actual removal happens in {@link confirmDelete} on confirm.
   */
  function bulkDelete(): void {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setPendingDelete(ids);
  }

  /**
   * Resolve the pending bulk delete: remove each id through the api (exactly as
   * before), clear the selection, and dismiss the dialog. A per-id failure is
   * logged and the loop continues (Req 9.6, 19.4).
   */
  async function confirmDelete(): Promise<void> {
    const ids = pendingDelete ?? [];
    setPendingDelete(null);
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
    // Capture the triggering control so Esc can return focus to it (Req 9.7).
    editTriggerRef.current =
      (document.activeElement as HTMLElement | null) ?? null;
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

  /**
   * Parse the current edit value into a persistable patch through the SAME
   * seams the field already uses — `core/money.minorUnits` for amount (its throw
   * is the invalid signal) and the ISO-date regex for next renewal. Returns
   * `null` when the value is invalid; never a second parser.
   */
  function parseEdit(
    current: EditState,
  ): { amountMinor: number } | { nextRenewal: string } | null {
    if (current.field === "amount") {
      const sub = subscriptions.find((s) => s.id === current.id);
      if (!sub) return null;
      try {
        return { amountMinor: minorUnits(current.value, sub.currency) };
      } catch {
        return null;
      }
    }
    return /^\d{4}-\d{2}-\d{2}$/.test(current.value)
      ? { nextRenewal: current.value }
      : null;
  }

  /** Persist a valid patch via the api (sets `updatedAt`) (Req 9.7). */
  async function persistEdit(
    id: string,
    patch: { amountMinor: number } | { nextRenewal: string },
  ): Promise<void> {
    try {
      await subscriptionsApi.update(id, patch); // Req 9.7
    } catch (err) {
      if (isSubbyError(err)) console.error(err.appError);
      else console.error(err);
    }
  }

  /**
   * Commit the current quick-edit on Enter (Req 9.7 / Story 3.5). A VALID value
   * persists and closes the editor; an INVALID value keeps the editor open,
   * sets an inline `role="alert"` error naming the problem, and leaves focus in
   * the input (nothing is persisted — invalid input is never silently
   * discarded).
   */
  async function commitEdit(): Promise<void> {
    if (!edit) return;
    const current = edit;
    const patch = parseEdit(current);
    if (!patch) {
      // Invalid: hold the editor open with an announced inline error.
      setEdit({ ...current, error: QUICK_EDIT_ERRORS[current.field] });
      return;
    }
    setEdit(null);
    await persistEdit(current.id, patch);
  }

  /**
   * Blur policy (Story 3.5 Design Notes): a VALID value still commits (preserves
   * the existing behavior tests rely on); an INVALID value reverts — cancel
   * without persisting and leave no dangling alert, so bad data is never
   * silently written and focus is never trapped in the cell being left.
   */
  async function blurEdit(): Promise<void> {
    if (!edit) return;
    const current = edit;
    const patch = parseEdit(current);
    setEdit(null);
    if (patch) await persistEdit(current.id, patch);
  }

  /** Cancel the current edit and return focus to the originating cell trigger. */
  function cancelEdit(): void {
    setEdit(null);
    editTriggerRef.current?.focus?.();
  }

  function onEditKeyDown(e: React.KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      void commitEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
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
          <label htmlFor="filter-tag" className="text-xs text-muted-foreground">
            Tag
          </label>
          <select
            id="filter-tag"
            value={filterTag}
            onChange={(e) => setFilterTag(e.target.value)}
            className={controlClass}
          >
            <option value="all">All tags</option>
            {tagOptions.map((tag) => (
              <option key={tag} value={tag}>
                {tag}
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

      {/*
        Persistent polite live region announcing the selection count (Req 9.6).
        Mounted UNCONDITIONALLY (not with the bulk bar) so a screen reader
        observes the text CHANGE — a region that appears at the same moment as
        its content is not reliably announced.
      */}
      <div role="status" aria-live="polite" className="sr-only">
        {selectedIds.size > 0 ? `${selectedIds.size} selected` : ""}
      </div>

      {/* Bulk actions bar (Req 9.6). */}
      {selectedIds.size > 0 && (
        <div
          role="region"
          aria-label="Bulk actions"
          className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2"
        >
          {/*
            Visible count is aria-hidden so only the persistent polite live
            region (above) speaks it — otherwise a screen reader would announce
            the same "N selected" twice.
          */}
          <span aria-hidden="true" className="text-sm font-medium">
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
              onClick={bulkDelete}
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
                    ref={(el) => registerRow(sub.id, el, true)}
                    className={cn(
                      "border-b border-border last:border-0 transition-colors",
                      selectedIds.has(sub.id) && "bg-secondary/30",
                      // Transient palette-arrival highlight: a DECORATIVE accent
                      // tint (not the solid accent fill — a row is content, not
                      // an action), separate from selection (Story 3.6, FR-5).
                      highlightedId === sub.id && "bg-accent/15",
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
                      <span className="inline-flex items-center">
                        <CategoryColorDot categoryName={sub.category} />
                        {sub.category}
                      </span>
                      <TagChips tags={sub.tags} />
                    </td>
                    <td className="px-3 py-2">
                      {edit && edit.id === sub.id && edit.field === "amount" ? (
                        <QuickEditField
                          type="number"
                          value={edit.value}
                          error={edit.error}
                          label={`Edit amount for ${sub.name}`}
                          inputClassName={cn(controlClass, "h-8 w-28")}
                          onChange={(value) => setEdit({ ...edit, value })}
                          onBlur={() => void blurEdit()}
                          onKeyDown={onEditKeyDown}
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
                        <QuickEditField
                          type="date"
                          value={edit.value}
                          error={edit.error}
                          label={`Edit next renewal for ${sub.name}`}
                          inputClassName={cn(controlClass, "h-8")}
                          onChange={(value) => setEdit({ ...edit, value })}
                          onBlur={() => void blurEdit()}
                          onKeyDown={onEditKeyDown}
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
                  ref={(el) => registerRow(sub.id, el, false)}
                  className={cn(
                    "rounded-md border border-border bg-card p-3 transition-colors",
                    selectedIds.has(sub.id) && "ring-1 ring-ring",
                    // Same transient accent-tint highlight as the table row.
                    highlightedId === sub.id && "bg-accent/15",
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
                          <dd>
                            <span className="inline-flex items-center">
                              <CategoryColorDot categoryName={sub.category} />
                              {sub.category}
                            </span>
                            <TagChips tags={sub.tags} />
                          </dd>
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
                              <QuickEditField
                                type="number"
                                value={edit.value}
                                error={edit.error}
                                label={`Edit amount for ${sub.name}`}
                                inputClassName={cn(controlClass, "h-8 w-full")}
                                onChange={(value) => setEdit({ ...edit, value })}
                                onBlur={() => void blurEdit()}
                                onKeyDown={onEditKeyDown}
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
                              <QuickEditField
                                type="date"
                                value={edit.value}
                                error={edit.error}
                                label={`Edit next renewal for ${sub.name}`}
                                inputClassName={cn(controlClass, "h-8 w-full")}
                                onChange={(value) => setEdit({ ...edit, value })}
                                onBlur={() => void blurEdit()}
                                onKeyDown={onEditKeyDown}
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

      {/*
        Branded bulk-delete confirmation (Req 9.6, DESIGN "Branded confirmation")
        — reuses the Story 3.4 ConfirmDialog instead of the native
        `window.confirm`. It names the exact count impact, lands focus on the
        safe/cancel button (the destructive action is non-default), and Esc /
        backdrop cancel. Kept mounted so `open` can toggle.
      */}
      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete subscriptions?"
        message={
          pendingDelete
            ? `Delete ${pendingDelete.length} subscription${
                pendingDelete.length === 1 ? "" : "s"
              }? This cannot be undone.`
            : ""
        }
        confirmLabel="Delete"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
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
 * The active quick-edit input plus its inline validation alert (Req 9.7 / Story
 * 3.5). An invalid commit holds the editor open and renders a `role="alert"`
 * message adjacent to the input, `aria-describedby`-linked and announced; the
 * input is marked `aria-invalid`. Enter commits/holds, Esc cancels, and blur
 * reverts-on-invalid / commits-on-valid — the parent owns those handlers.
 */
function QuickEditField({
  type,
  value,
  error,
  label,
  inputClassName,
  onChange,
  onBlur,
  onKeyDown,
}: {
  type: "number" | "date";
  value: string;
  error: string | undefined;
  label: string;
  inputClassName: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}): JSX.Element {
  const errorId = useId();
  return (
    <span className="inline-flex flex-col gap-1">
      <input
        autoFocus
        type={type}
        {...(type === "number" ? { min: 0, step: "0.01" } : {})}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={inputClassName}
      />
      {error && (
        <span id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}

/**
 * Read-only tag chips for a List row (Story 3.4 parity). Tags are edited in the
 * Add/Edit modal; here they are just surfaced beside the category. Renders
 * nothing when a subscription has no tags.
 */
function TagChips({ tags }: { tags: string[] }): JSX.Element | null {
  if (tags.length === 0) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
        >
          {tag}
        </span>
      ))}
    </span>
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
