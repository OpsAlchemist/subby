/**
 * Theme_Manager (task 25.1, Req 14).
 *
 * Applies the dark / light / system appearance and the configured accent color
 * to the renderer by toggling a `data-theme` attribute on `<html>` and writing
 * the `--accent` CSS custom property. Tailwind + the tokens in
 * `src/styles/globals.css` read from these, so flipping the attribute reskins
 * the whole UI.
 *
 * Design notes:
 *   - `system` resolves the OS appearance via
 *     `window.matchMedia('(prefers-color-scheme: dark)')` (Req 14.2) and follows
 *     subsequent OS changes while `theme === "system"` (see {@link initTheme}).
 *   - Dark is the first-run default (Req 14.4). `index.html` ships
 *     `data-theme="dark"` so the very first paint (before settings load) is dark
 *     without any JS; once settings load, {@link applySettingsTheme} reconciles.
 *   - Everything is DOM-guarded (`typeof document !== "undefined"`) and the
 *     `matchMedia` lookup is optional, so the module imports and runs in a
 *     non-browser/test environment (task 25.2). A `MediaQueryProvider` can be
 *     injected to exercise system-theme behavior deterministically.
 */

import type { Settings } from "core/models/settings";

/** The two concrete appearances the UI can render. */
export type ResolvedTheme = "dark" | "light";

/** The user-selectable theme preference. */
export type ThemePreference = Settings["theme"];

/** The media query used to detect the OS dark-mode preference (Req 14.2). */
const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

/**
 * Minimal subset of {@link MediaQueryList} this module relies on. Declaring our
 * own shape keeps the code testable: a fake implementing just these members can
 * stand in for the browser object.
 */
export interface MediaQuery {
  matches: boolean;
  addEventListener?(
    type: "change",
    listener: (e: { matches: boolean }) => void,
  ): void;
  removeEventListener?(
    type: "change",
    listener: (e: { matches: boolean }) => void,
  ): void;
  /** Legacy fallbacks for older engines. */
  addListener?(listener: (e: { matches: boolean }) => void): void;
  removeListener?(listener: (e: { matches: boolean }) => void): void;
}

/** A factory that produces a {@link MediaQuery} for a given query string. */
export type MediaQueryProvider = (query: string) => MediaQuery | undefined;

/**
 * Default media-query provider: `window.matchMedia` when available, otherwise
 * `undefined` (non-browser/test contexts). Guarded so importing this module
 * never throws outside a browser.
 */
export function defaultMediaQueryProvider(query: string): MediaQuery | undefined {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return undefined;
  }
  return window.matchMedia(query);
}

/**
 * Resolve a {@link ThemePreference} to a concrete {@link ResolvedTheme}.
 *
 * `dark`/`light` map to themselves; `system` consults the
 * `prefers-color-scheme` media query (Req 14.2). When the media query is
 * unavailable (no browser, or `matchMedia` missing) it falls back to `dark`,
 * matching the first-run default (Req 14.4).
 */
export function resolveTheme(
  theme: ThemePreference,
  mediaQueryProvider: MediaQueryProvider = defaultMediaQueryProvider,
): ResolvedTheme {
  if (theme === "dark" || theme === "light") return theme;
  // theme === "system"
  const mq = mediaQueryProvider(DARK_MEDIA_QUERY);
  if (!mq) return "dark"; // dark default when no preference is resolvable (Req 14.4)
  return mq.matches ? "dark" : "light";
}

/**
 * Apply a theme preference by setting `document.documentElement.dataset.theme`
 * to the resolved `"dark"` or `"light"` (Req 14.1). For `"system"` the OS
 * appearance is resolved first (Req 14.2). No-ops outside a DOM environment.
 *
 * @returns the {@link ResolvedTheme} that was applied (useful for callers/tests).
 */
export function applyTheme(
  theme: ThemePreference,
  mediaQueryProvider: MediaQueryProvider = defaultMediaQueryProvider,
): ResolvedTheme {
  const resolved = resolveTheme(theme, mediaQueryProvider);
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = resolved;
  }
  return resolved;
}

/**
 * Apply the accent color by writing the `--accent` CSS custom property on the
 * document root (Req 14.3). No-ops outside a DOM environment. Empty/blank
 * values are ignored so a missing setting can't blank out the accent.
 */
export function applyAccent(accentColor: string): void {
  if (typeof document === "undefined") return;
  if (typeof accentColor !== "string" || accentColor.trim() === "") return;
  document.documentElement.style.setProperty("--accent", accentColor);
}

/**
 * Apply both theme and accent from a {@link Settings} object (Req 14.1–14.4).
 * Convenience used by the renderer whenever settings load or change.
 *
 * @returns the {@link ResolvedTheme} that was applied.
 */
export function applySettingsTheme(
  settings: Pick<Settings, "theme" | "accentColor">,
  mediaQueryProvider: MediaQueryProvider = defaultMediaQueryProvider,
): ResolvedTheme {
  const resolved = applyTheme(settings.theme, mediaQueryProvider);
  applyAccent(settings.accentColor);
  return resolved;
}

/**
 * Subscribe to OS appearance changes and re-apply the theme while the user's
 * preference is `"system"` (Req 14.2). When the preference is `"dark"` or
 * `"light"` there is nothing to listen for, so this is a no-op that returns a
 * no-op cleanup.
 *
 * @param theme the current preference (only `"system"` subscribes).
 * @param onResolved optional callback invoked with the new {@link ResolvedTheme}
 *   each time the OS appearance changes (lets the UI update an indicator).
 * @param mediaQueryProvider injectable for tests.
 * @returns a cleanup function that detaches the listener.
 */
export function subscribeSystemTheme(
  theme: ThemePreference,
  onResolved?: (resolved: ResolvedTheme) => void,
  mediaQueryProvider: MediaQueryProvider = defaultMediaQueryProvider,
): () => void {
  if (theme !== "system") return () => {};

  const mq = mediaQueryProvider(DARK_MEDIA_QUERY);
  if (!mq) return () => {};

  const handler = (e: { matches: boolean }): void => {
    const resolved: ResolvedTheme = e.matches ? "dark" : "light";
    if (typeof document !== "undefined") {
      document.documentElement.dataset.theme = resolved;
    }
    onResolved?.(resolved);
  };

  // Prefer the modern API; fall back to the deprecated one for older engines.
  if (typeof mq.addEventListener === "function") {
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener?.("change", handler);
  }
  if (typeof mq.addListener === "function") {
    mq.addListener(handler);
    return () => mq.removeListener?.(handler);
  }
  return () => {};
}

/**
 * One-shot initializer: apply the given settings now and start following OS
 * appearance changes when the preference is `"system"`.
 *
 * Typical renderer usage is to call {@link applySettingsTheme} on every settings
 * change and {@link subscribeSystemTheme} for the live listener (see `App.tsx`);
 * `initTheme` bundles both for callers that just want a fire-and-forget setup
 * from a settings snapshot.
 *
 * @returns a cleanup function detaching the system-theme listener.
 */
export function initTheme(
  settings: Pick<Settings, "theme" | "accentColor">,
  onResolved?: (resolved: ResolvedTheme) => void,
  mediaQueryProvider: MediaQueryProvider = defaultMediaQueryProvider,
): () => void {
  applySettingsTheme(settings, mediaQueryProvider);
  return subscribeSystemTheme(settings.theme, onResolved, mediaQueryProvider);
}
