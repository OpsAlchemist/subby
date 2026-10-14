import { lazy, Suspense, useEffect, useState } from "react";
import {
  Info,
  LayoutDashboard,
  List,
  Monitor,
  Moon,
  Plus,
  Search,
  Settings as SettingsIcon,
  Sun,
  BarChart3,
  Calendar,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { settingsApi } from "@/api/subby";
import { settingsStore } from "@/stores";
import { useStoreData } from "@/stores/hooks";
import {
  applySettingsTheme,
  subscribeSystemTheme,
} from "@/theme/themeManager";

// Eagerly-loaded lightweight views.
import Dashboard from "@/views/Dashboard";
import SubscriptionList from "@/views/SubscriptionList";
import Settings from "@/views/Settings";
import About from "@/views/About";
import SubscriptionModal from "@/components/SubscriptionModal";
import GlobalSearch from "@/components/GlobalSearch";

/**
 * Heavy views are code-split with React.lazy so they do not weigh on cold-start
 * (Req 21.1). The placeholders default-export simple components today; tasks 23
 * (Calendar) and 24 (Analytics) replace their contents without changing this
 * import boundary.
 */
const CalendarView = lazy(() => import("@/views/CalendarView"));
const AnalyticsView = lazy(() => import("@/views/AnalyticsView"));

/** The set of routable views. The shell uses simple in-memory routing (see below). */
type ViewKey =
  | "dashboard"
  | "list"
  | "calendar"
  | "analytics"
  | "settings"
  | "about";

interface NavItem {
  key: ViewKey;
  label: string;
  icon: LucideIcon;
}

/**
 * Navigation rail items, in tab order (Req 22.1). Each renders an icon + text
 * label so the rail is usable by sighted and screen-reader users alike
 * (Req 22.3).
 */
const NAV_ITEMS: readonly NavItem[] = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "list", label: "List", icon: List },
  { key: "calendar", label: "Calendar", icon: Calendar },
  { key: "analytics", label: "Analytics", icon: BarChart3 },
  { key: "settings", label: "Settings", icon: SettingsIcon },
  { key: "about", label: "About", icon: Info },
] as const;

/**
 * Shared focus-ring utilities (DESIGN §Focus ring; Req 22.1, 22.3). Every
 * interactive control gets a visible 2px ring with a 2px offset; the ring color
 * and offset surface change with the control so it never becomes an invisible
 * accent-on-accent ring. There are exactly four variants, one per control class:
 *
 *   - {@link focusRing} — DEFAULT: the accent `--ring` offset against the main
 *     `background`. Used by every main-surface control: the skip-link, the
 *     top-bar Global Search trigger, and the top-bar theme toggle.
 *   - {@link focusRingOnSidebar} — RESTING espresso nav items: amber `#f59e0b`
 *     ring (ochre reads only ~3:1 on espresso) offset against the sidebar
 *     surface `#1f1a14`, in BOTH themes (the ring tracks the surface, not the
 *     global theme).
 *   - {@link focusRingOnSidebarAccent} — the ACTIVE (accent-filled) nav item:
 *     renders the ring in the element FOREGROUND (`--sidebar-accent-foreground`)
 *     offset against the sidebar surface, so it reads against both the accent
 *     fill and the espresso around it. The active nav item uses THIS, not
 *     {@link focusRingOnAccent}.
 *   - {@link focusRingOnAccent} — the top-bar primary "Add subscription" button
 *     (accent-filled on the main surface): element-foreground ring
 *     (`accent-foreground`) offset against `background`.
 */
const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/** Resting espresso nav item: amber ring, offset against the sidebar surface. */
const focusRingOnSidebar =
  "outline-none focus-visible:ring-2 focus-visible:ring-[#f59e0b] focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--sidebar))]";

/** Active (accent-filled) nav item: element-foreground ring, offset against the sidebar. */
const focusRingOnSidebarAccent =
  "outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--sidebar-accent-foreground))] focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--sidebar))]";

/** Top-bar primary Add button (accent-filled): element-foreground ring, offset against background. */
const focusRingOnAccent =
  "outline-none focus-visible:ring-2 focus-visible:ring-accent-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/**
 * Render the active view. Calendar/Analytics are lazy and wrapped in Suspense
 * by the caller. The other views are eager and cheap.
 */
function ActiveView({
  view,
  highlightId,
  onHighlightConsumed,
}: {
  view: ViewKey;
  highlightId: string | null;
  onHighlightConsumed: () => void;
}): JSX.Element {
  switch (view) {
    case "dashboard":
      return <Dashboard />;
    case "list":
      return (
        <SubscriptionList
          highlightId={highlightId}
          onHighlightConsumed={onHighlightConsumed}
        />
      );
    case "calendar":
      return <CalendarView />;
    case "analytics":
      return <AnalyticsView />;
    case "settings":
      return <Settings />;
    case "about":
      return <About />;
  }
}

/**
 * Application shell (design: Application Shell). Provides:
 *   - a labelled left navigation rail landmark (`<nav aria-label="Primary">`),
 *   - a top bar (`<header>`) with the "Add subscription" primary action and a
 *     Global Search trigger (Cmd/Ctrl-K affordance) plus a theme indicator,
 *   - a `<main>` content region with a skip-nav target.
 *
 * Routing is in-memory `useState` keyed to the nav (no router dependency): the
 * renderer loads a single HTML file under Electron, so state-based view
 * switching is the lightest correct approach. The "Add subscription" and
 * search controls are wired to local state today; tasks 19 (modal) and 22
 * (Global Search overlay) replace the handlers.
 *
 * _Requirements: 21.1 (lazy heavy views), 22.1 (tab-order keyboard nav),
 * 22.3 (screen-reader labels on landmarks + icon-only controls)._
 */
export default function App(): JSX.Element {
  const [view, setView] = useState<ViewKey>("dashboard");

  // Add subscription modal open state (task 19). Opening with no target puts
  // the modal in CREATE mode; the list view can later pass a subscription for
  // EDIT mode through its own wiring.
  const [addOpen, setAddOpen] = useState(false);

  // Global Search command palette open state (task 22). Opened by the top-bar
  // search trigger or the Cmd/Ctrl-K shortcut (Req 22.2).
  const [searchOpen, setSearchOpen] = useState(false);

  // The subscription id to transiently highlight in the List after a palette
  // selection (Story 3.6, FR-5). Threaded into SubscriptionList; the List clears
  // it via `onHighlightConsumed` once the highlight has been shown, so it is
  // ephemeral (never persisted, never part of `selectedIds`). The app has no
  // router/URL params/UI store — this prop thread matches the in-memory routing.
  const [highlightId, setHighlightId] = useState<string | null>(null);

  // Theme wiring (task 25, Req 14): subscribe to the settings store and apply
  // the theme + accent whenever they change, and follow OS appearance while the
  // preference is "system". Pre-load, the store seeds DEFAULT_SETTINGS (dark),
  // and index.html ships data-theme="dark", so the first paint stays dark.
  const settings = useStoreData(settingsStore);
  const theme = settings.theme;
  const accentColor = settings.accentColor;

  useEffect(() => {
    applySettingsTheme({ theme, accentColor });
    // Re-apply on OS appearance changes while following the system theme.
    return subscribeSystemTheme(theme);
  }, [theme, accentColor]);

  // Global keyboard shortcuts for primary actions (Req 22.2):
  //   - Cmd/Ctrl-K → open the Global Search palette (works anywhere),
  //   - N         → open the Add subscription modal,
  //   - 1–6       → switch to the matching nav view (Dashboard..About).
  // Single-key shortcuts are suppressed while the user is typing in a field or
  // while a modal/search overlay is open (those overlays own their own keys),
  // and they ignore modifier combinations so they never clash with browser or
  // OS shortcuts. Re-registered when overlay state changes; cleaned up on
  // unmount.
  useEffect(() => {
    function isTypingTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target.isContentEditable
      );
    }

    function onKeyDown(e: KeyboardEvent): void {
      // Cmd/Ctrl-K opens search from anywhere, even while typing.
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }

      // All remaining shortcuts are single-key and must not fire with
      // modifiers, while typing, or while an overlay is capturing input.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (addOpen || searchOpen || isTypingTarget(e.target)) return;

      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        setAddOpen(true);
        return;
      }

      // Digits 1–6 map to the nav rail items in order.
      if (e.key >= "1" && e.key <= "6") {
        const item = NAV_ITEMS[Number(e.key) - 1];
        if (item) {
          e.preventDefault();
          setView(item.key);
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [addOpen, searchOpen]);

  /** Cycle the theme preference dark → light → system → dark and persist it. */
  function cycleTheme(): void {
    const next: typeof theme =
      theme === "dark" ? "light" : theme === "light" ? "system" : "dark";
    void settingsApi.update({ theme: next });
  }

  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;

  // Cmd/Ctrl-K affordance label varies by platform; detect Apple platforms for
  // the displayed shortcut hint only (no behavior depends on it yet).
  const isMac =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const searchShortcut = isMac ? "\u2318K" : "Ctrl+K";

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      {/* Skip-navigation link: first tab stop, jumps past the rail (Req 22.1). */}
      <a
        href="#main-content"
        className={cn(
          "sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50",
          "rounded-md bg-secondary px-3 py-2 text-sm text-secondary-foreground",
          focusRing,
        )}
      >
        Skip to main content
      </a>

      {/* Visually-hidden keyboard-shortcuts reference for screen-reader users
          (Req 22.2/22.3). Sighted users see the same hints via control titles
          and the search trigger's kbd badge. */}
      <p className="sr-only">
        Keyboard shortcuts: press N to add a subscription, {searchShortcut} to
        open search, and the number keys 1 through 6 to switch between
        Dashboard, List, Calendar, Analytics, Settings, and About.
      </p>

      {/* Left navigation rail — the espresso sidebar surface (DESIGN: Sidebar),
          a labelled landmark (Req 22.3). Espresso in BOTH themes: a 185deg
          gradient over the solid fallback, a right border, and an inset amber
          keyline (DESIGN labels this the "inset ochre keyline"; the rgba is
          amber by design). */}
      <nav
        aria-label="Primary"
        style={{
          backgroundImage:
            "linear-gradient(185deg, #241f17, #1d1813)",
          boxShadow: "inset -1px 0 0 rgba(245, 158, 11, 0.08)",
        }}
        className="flex w-56 shrink-0 flex-col gap-1 border-r border-sidebar-border bg-sidebar p-3"
      >
        {/* Brandmark: an accent-filled tile + the wordmark on espresso. */}
        <div className="mb-4 flex items-center gap-2 px-2 py-1">
          <span
            aria-hidden="true"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent text-sm font-semibold text-accent-foreground"
          >
            S
          </span>
          <span className="text-lg font-semibold tracking-tight text-sidebar-foreground">
            Subby
          </span>
        </div>

        {/* Section label (DESIGN label-caps on espresso). */}
        <p className="px-3 pb-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-sidebar-section">
          Navigate
        </p>

        <ul className="flex flex-col gap-1">
          {NAV_ITEMS.map(({ key, label, icon: Icon }, index) => {
            const active = key === view;
            return (
              <li key={key}>
                <button
                  type="button"
                  aria-current={active ? "page" : undefined}
                  title={`${label} (${index + 1})`}
                  onClick={() => setView(key)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    active
                      ? // Active item: solid accent fill + element-foreground ring.
                        "bg-sidebar-accent text-sidebar-accent-foreground " +
                        focusRingOnSidebarAccent
                      : // Resting item: muted espresso label + amber ring.
                        "text-sidebar-foreground hover:bg-white/5 hover:text-sidebar-foreground " +
                        focusRingOnSidebar,
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Right column: top bar + content. */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar landmark — a resting card surface (DESIGN: elevation.card). */}
        <header className="flex items-center justify-between gap-3 border-b border-border bg-card px-6 py-3 shadow-card">
          {/* Global Search trigger with Cmd/Ctrl-K affordance (task 22 wires it). */}
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm text-muted-foreground",
              "max-w-md hover:text-foreground",
              focusRing,
            )}
          >
            <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="truncate">Search subscriptions...</span>
            <kbd className="ml-auto rounded border border-border px-1.5 py-0.5 text-xs">
              {searchShortcut}
            </kbd>
          </button>

          <div className="flex items-center gap-2">
            {/* Theme indicator (task 25): shows the active theme preference and
                cycles dark → light → system on click, persisting via settings. */}
            <button
              type="button"
              aria-label={`Theme: ${theme}. Click to change.`}
              title={`Theme: ${theme}`}
              onClick={cycleTheme}
              className={cn(
                "inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                focusRing,
              )}
            >
              <ThemeIcon className="h-4 w-4" aria-hidden="true" />
            </button>

            {/* Primary action: Add subscription (task 19 opens the modal).
                Accent-filled → raised elevation + element-foreground focus ring. */}
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              title="Add subscription (N)"
              className={cn(
                "inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-foreground shadow-raised hover:opacity-90",
                focusRingOnAccent,
              )}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              <span>Add subscription</span>
            </button>
          </div>
        </header>

        {/* Main content region with a skip-nav target and accessible label. */}
        <main
          id="main-content"
          aria-label={NAV_ITEMS.find((i) => i.key === view)?.label}
          className="flex-1 overflow-auto p-6"
        >
          <Suspense
            fallback={
              <div className="text-sm text-muted-foreground" role="status">
                Loading...
              </div>
            }
          >
            <ActiveView
              view={view}
              highlightId={highlightId}
              onHighlightConsumed={() => setHighlightId(null)}
            />
          </Suspense>
        </main>
      </div>

      {/* Add/Edit subscription modal (task 19). Create mode: no `subscription`. */}
      <SubscriptionModal open={addOpen} onClose={() => setAddOpen(false)} />

      {/* Global Search command palette (task 22). On select, jump to the List
          view and transiently highlight the chosen subscription's row (Story
          3.6, FR-5); the palette returns focus to its trigger on close. The
          List consumes `highlightId` and clears it via onHighlightConsumed. */}
      <GlobalSearch
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSelect={(sub) => {
          setHighlightId(sub.id);
          setView("list");
        }}
      />
    </div>
  );
}
