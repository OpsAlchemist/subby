/**
 * `prefers-reduced-motion` hook (Story 6.1).
 *
 * Returns `true` when the user has asked the OS to reduce motion, so animated
 * surfaces (the Dashboard's `CountUp`) can SNAP to their final value instead of
 * animating. Subscribes to the `(prefers-reduced-motion: reduce)` media query
 * and re-renders when the preference changes at runtime.
 *
 * SSR/test-safe DEFAULT: when `window.matchMedia` is absent (jsdom test env or a
 * non-DOM context) the hook returns `true` — reduced motion ON. This is a
 * deliberate, two-fold safe default: no animation ever runs without an explicit
 * "motion allowed" signal, and tests become deterministic (figures render their
 * FINAL value synchronously, with no rAF timer to leak or flush).
 */

import { useSyncExternalStore } from "react";

/** The media query that signals the user prefers reduced motion. */
const QUERY = "(prefers-reduced-motion: reduce)";

/** Read the current preference. Reduced-ON when matchMedia is unavailable. */
function getSnapshot(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    // No matchMedia (jsdom/SSR): default to reduced so animation never runs
    // without an explicit signal and tests snap to the final value.
    return true;
  }
  return window.matchMedia(QUERY).matches;
}

/** Subscribe to preference changes; no-op (never emits) when matchMedia is absent. */
function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const mql = window.matchMedia(QUERY);
  // `addEventListener` is the modern API; `addListener` is the legacy fallback
  // some environments still expose. Prefer the modern one when present.
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }
  mql.addListener(onChange);
  return () => mql.removeListener(onChange);
}

/**
 * `true` when the user prefers reduced motion (or `matchMedia` is unavailable —
 * the safe, test-deterministic default). Re-renders on preference change.
 */
export function useReducedMotion(): boolean {
  // The server snapshot matches the client snapshot's safe default (reduced).
  return useSyncExternalStore(subscribe, getSnapshot, () => true);
}
