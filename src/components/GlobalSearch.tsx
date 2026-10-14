/**
 * Global Search command palette (task 22, Req 12.1, 12.2, 12.3, 22.2).
 *
 * A keyboard-first, command-palette-style overlay (opened with Cmd/Ctrl-K by
 * the app shell) for finding a subscription quickly:
 *
 *   - Reads the current subscriptions from {@link subscriptionsStore} and runs
 *     {@link fuzzySearch} over them. An empty/whitespace query lists ALL
 *     subscriptions (Req 12.3); a non-empty query returns subsequence matches on
 *     name or provider, best-ranked first (Req 12.1, 12.2 — handled by core).
 *   - Keyboard-first (Req 22.2): the input is auto-focused on open; ArrowUp /
 *     ArrowDown move the highlighted result (with wrap-around); Enter selects
 *     the highlighted result (calls `onSelect` then `onClose`); Escape closes.
 *   - Accessible combobox/listbox: the input has `role="combobox"` wired to the
 *     results `role="listbox"` via `aria-controls` + `aria-activedescendant`,
 *     and each result is a `role="option"` with `aria-selected`. The overlay is
 *     a labelled `role="dialog"` with `aria-modal`; clicking the backdrop
 *     closes it; controls carry visible focus rings and tokenized styling.
 *
 * The component owns no data access beyond the store; selecting a result is
 * delegated to the optional `onSelect` callback supplied by the shell.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";

import type { SubscriptionV2 } from "core/models/subscription";
import { fuzzySearch } from "core/search";
import { toMajor } from "core/money";
import { cn } from "@/lib/utils";
import { subscriptionsStore } from "@/stores";
import { useStoreData } from "@/stores/hooks";

export interface GlobalSearchProps {
  /** Whether the palette is rendered/open. */
  open: boolean;
  /** Close handler — invoked on Escape, backdrop click, or after a selection. */
  onClose: () => void;
  /** Optional: invoked with the chosen subscription before the palette closes. */
  onSelect?: (sub: SubscriptionV2) => void;
}

/** Stable DOM id for a result option, used for `aria-activedescendant`. */
function optionId(listId: string, index: number): string {
  return `${listId}-option-${index}`;
}

export default function GlobalSearch({
  open,
  onClose,
  onSelect,
}: GlobalSearchProps): JSX.Element | null {
  const subscriptions = useStoreData(subscriptionsStore);

  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // The element focused before the palette opened — focus returns here on close
  // (Escape, backdrop, or selection), mirroring ConfirmDialog/SubscriptionModal.
  const previouslyFocused = useRef<HTMLElement | null>(null);

  const titleId = useId();
  const listId = useId();

  // Results from core fuzzy search; empty/whitespace query lists all (Req 12.3).
  const results = useMemo(
    () => fuzzySearch(subscriptions, query),
    [subscriptions, query],
  );

  // Reset the query and selection each time the palette opens, and focus the
  // input after paint so it is immediately keyboard-driven (Req 22.2). Capture
  // the previously-focused element on open and restore it on close so focus
  // returns to the top-bar trigger that opened the palette (DESIGN focus-return;
  // mirrors ConfirmDialog/SubscriptionModal).
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    previouslyFocused.current =
      (document.activeElement as HTMLElement | null) ?? null;
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(id);
      // Only restore focus if the trigger is still in the document — a detached
      // or absent node would silently drop focus to document.body.
      if (previouslyFocused.current?.isConnected) {
        previouslyFocused.current.focus();
      }
    };
  }, [open]);

  // Keep the highlighted index within bounds as the result set changes.
  useEffect(() => {
    setActiveIndex((prev) => {
      if (results.length === 0) return 0;
      return Math.min(prev, results.length - 1);
    });
  }, [results.length]);

  // Keep the highlighted option scrolled into view as it moves.
  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.querySelector<HTMLElement>(
      `#${CSS.escape(optionId(listId, activeIndex))}`,
    );
    node?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open, listId]);

  if (!open) return null;

  /** Select the subscription at `index`: notify, then close (Req 22.2). */
  function select(index: number): void {
    const sub = results[index];
    if (!sub) return;
    onSelect?.(sub);
    onClose();
  }

  /** Keyboard-first navigation: arrows move, Enter selects, Escape closes; Tab trapped. */
  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    // Focus trap: keep Tab/Shift-Tab within the dialog (mirrors ConfirmDialog).
    // The results are driven by `aria-activedescendant` (not real focus), so the
    // input is the only natural tab stop — cycle focusables and keep focus from
    // escaping to the page behind the overlay.
    if (event.key === "Tab") {
      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      // With a single focusable (the input, today), Tab must be a no-op that
      // keeps focus on it rather than escaping — preventDefault unconditionally
      // whenever focus is within the dialog. This stays correct if a second
      // control is ever added (the first/last wrap below then takes over).
      if (focusables.length <= 1) {
        if (dialogRef.current?.contains(active)) event.preventDefault();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }

    switch (event.key) {
      case "Escape":
        event.preventDefault();
        onClose();
        break;
      case "ArrowDown":
        event.preventDefault();
        if (results.length > 0) {
          setActiveIndex((prev) => (prev + 1) % results.length);
        }
        break;
      case "ArrowUp":
        event.preventDefault();
        if (results.length > 0) {
          setActiveIndex((prev) => (prev - 1 + results.length) % results.length);
        }
        break;
      case "Enter":
        event.preventDefault();
        select(activeIndex);
        break;
      default:
        break;
    }
  }

  const hasResults = results.length > 0;
  const activeDescendant = hasResults
    ? optionId(listId, activeIndex)
    : undefined;

  return (
    <div
      // Backdrop: clicking it closes the palette.
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[12vh]"
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
        className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-xl"
      >
        <h2 id={titleId} className="sr-only">
          Search subscriptions
        </h2>

        {/* Search input row (combobox). */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Search
            className="h-4 w-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={activeDescendant}
            aria-autocomplete="list"
            aria-label="Search subscriptions"
            placeholder="Search subscriptions..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            className={cn(
              "min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground",
              "outline-none",
            )}
          />
        </div>

        {/* Results listbox. */}
        {hasResults ? (
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label="Search results"
            className="min-h-0 flex-1 overflow-auto p-2"
          >
            {results.map((sub, index) => {
              const selected = index === activeIndex;
              return (
                <li
                  key={sub.id}
                  id={optionId(listId, index)}
                  role="option"
                  aria-selected={selected}
                  // Pointer support complements keyboard-first navigation.
                  onMouseMove={() => setActiveIndex(index)}
                  onMouseDown={(e) => {
                    // Prevent the input from losing focus before selection.
                    e.preventDefault();
                    select(index);
                  }}
                  className={cn(
                    "flex cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 text-sm",
                    // The keyboard-active row uses the ACCENT as its selected
                    // background (focus/selected = accent discipline), matching
                    // active-nav and the primary button (DESIGN "Global search").
                    // Accent-fill rule: the focus ring renders in the element
                    // FOREGROUND (never accent-on-accent), offset against the
                    // card surface — mirroring App.tsx `focusRingOnAccent`. The
                    // row is not natively focusable, so the ring is for
                    // parity/hover-focus; `aria-selected` is the SR signal.
                    selected
                      ? "bg-accent text-accent-foreground " +
                        "outline-none focus-visible:ring-2 focus-visible:ring-accent-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                      : "text-foreground hover:bg-secondary/60",
                  )}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{sub.name}</span>
                    {sub.provider.trim() !== "" && (
                      <span className="truncate text-xs text-muted-foreground">
                        {sub.provider}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {sub.currency} {toMajor(sub.amountMinor, sub.currency)} ·{" "}
                    {sub.billingCycle}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <div
            role="status"
            className="flex-1 px-4 py-8 text-center text-sm text-muted-foreground"
          >
            No subscriptions match “{query.trim()}”.
          </div>
        )}
      </div>
    </div>
  );
}
