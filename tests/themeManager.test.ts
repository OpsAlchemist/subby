// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyAccent,
  applySettingsTheme,
  applyTheme,
  resolveTheme,
  subscribeSystemTheme,
  DEFAULT_ACCENT,
} from "@/theme/themeManager";
import type { MediaQuery, MediaQueryProvider } from "@/theme/themeManager";

import { DEFAULT_SETTINGS } from "core/models/schema";

/**
 * Unit tests for the Theme_Manager (Task 25.2, Req 14.1–14.4).
 *
 * These run under jsdom (see the pragma at the very top) so that
 * `document.documentElement` exists and the DOM-guarded code paths in
 * `themeManager.ts` actually execute. System-theme behavior is exercised
 * deterministically by injecting a fake {@link MediaQueryProvider} rather than
 * relying on the real `window.matchMedia`.
 *
 * Covered:
 *   - 14.1 : explicit dark/light selection sets `data-theme` accordingly.
 *   - 14.2 : `system` follows the OS appearance via the injected media query,
 *            and live OS changes re-apply through `subscribeSystemTheme`.
 *   - 14.3 : accent color writes the `--accent` CSS variable; blanks ignored.
 *   - 14.4 : dark is the default when no preference is resolvable, and the
 *            DEFAULT_SETTINGS theme ("dark") yields dark.
 */

// --- Fake MediaQuery / provider ----------------------------------------------

/**
 * A controllable {@link MediaQuery} that records listeners so a "change" can be
 * fired in-test, and tracks whether a listener is currently attached so we can
 * assert that cleanup detaches it.
 */
interface FakeMediaQuery extends MediaQuery {
  matches: boolean;
  listeners: Array<(e: { matches: boolean }) => void>;
  /** Simulate the OS appearance changing to `matches`, firing "change". */
  fireChange(matches: boolean): void;
  /** Number of currently-attached "change" listeners. */
  listenerCount(): number;
}

function createFakeMediaQuery(initialMatches: boolean): FakeMediaQuery {
  const mq: FakeMediaQuery = {
    matches: initialMatches,
    listeners: [],
    addEventListener(type, listener) {
      if (type === "change") mq.listeners.push(listener);
    },
    removeEventListener(type, listener) {
      if (type === "change") {
        mq.listeners = mq.listeners.filter((l) => l !== listener);
      }
    },
    fireChange(matches: boolean) {
      mq.matches = matches;
      for (const l of [...mq.listeners]) l({ matches });
    },
    listenerCount() {
      return mq.listeners.length;
    },
  };
  return mq;
}

/** Build a provider that always returns `mq` for the dark-mode query. */
function providerOf(mq: MediaQuery | undefined): MediaQueryProvider {
  return () => mq;
}

// --- Fixture ------------------------------------------------------------------

beforeEach(() => {
  delete document.documentElement.dataset.theme;
  document.documentElement.style.removeProperty("--accent");
});

afterEach(() => {
  delete document.documentElement.dataset.theme;
  document.documentElement.style.removeProperty("--accent");
});

// --- Explicit theme application (Req 14.1) ------------------------------------

describe("applyTheme explicit dark/light (Req 14.1)", () => {
  it('applyTheme("dark") sets data-theme to "dark"', () => {
    const resolved = applyTheme("dark");
    expect(resolved).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it('applyTheme("light") sets data-theme to "light"', () => {
    const resolved = applyTheme("light");
    expect(resolved).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});

// --- System theme resolution (Req 14.2) ---------------------------------------

describe("applyTheme system via injected provider (Req 14.2)", () => {
  it('resolves to "dark" when the OS media query matches dark', () => {
    const mq = createFakeMediaQuery(true);
    const resolved = applyTheme("system", providerOf(mq));
    expect(resolved).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it('resolves to "light" when the OS media query does not match dark', () => {
    const mq = createFakeMediaQuery(false);
    const resolved = applyTheme("system", providerOf(mq));
    expect(resolved).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});

// --- Dark default when no preference resolvable (Req 14.4) ---------------------

describe("dark default (Req 14.4)", () => {
  it('resolveTheme("system") returns "dark" when no media query is available', () => {
    expect(resolveTheme("system", providerOf(undefined))).toBe("dark");
  });

  it('applyTheme("system") with no media query applies dark', () => {
    const resolved = applyTheme("system", providerOf(undefined));
    expect(resolved).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it('the DEFAULT_SETTINGS theme is "dark" and applyTheme yields dark', () => {
    expect(DEFAULT_SETTINGS.theme).toBe("dark");
    const resolved = applyTheme(DEFAULT_SETTINGS.theme);
    expect(resolved).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});

// --- Accent color application (Req 14.3) --------------------------------------
//
// In 1.0 the accent is a Warm Graphite theme token (ochre light / amber dark)
// resolved in CSS. `applyAccent` only writes an inline override for a *genuine
// custom* value; a blank/default value clears any prior override so the
// per-theme token wins (theme-aware accent).

describe("applyAccent sentinel/theme-aware behavior (Req 14.3)", () => {
  it("writes an inline --accent override for a genuine custom value", () => {
    applyAccent("#123456");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#123456");
  });

  it("writes a padded custom value trimmed (no surrounding whitespace)", () => {
    applyAccent("  #123456  ");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#123456");
  });

  it("does NOT write an inline override for the default sentinel (token wins)", () => {
    applyAccent(DEFAULT_ACCENT);
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("");
  });

  it("clears a prior custom override on an empty value (token wins)", () => {
    applyAccent("#123456");
    applyAccent("");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("");
  });

  it("clears a prior custom override on a blank/whitespace value (token wins)", () => {
    applyAccent("#abcdef");
    applyAccent("   ");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("");
  });

  it("clears the stale override on a custom→default transition (token wins)", () => {
    // User picks a custom accent, then reverts to the default: the inline
    // override must be removed so the per-theme token (amber in dark) returns.
    applyAccent("#123456");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#123456");
    applyAccent(DEFAULT_ACCENT);
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("");
  });

  it("uses the DEFAULT_SETTINGS accent as the default sentinel", () => {
    // Guards against a purple regression: this only holds while the schema
    // default equals DEFAULT_ACCENT (#92400e, purple retired).
    expect(DEFAULT_SETTINGS.accentColor).toBe(DEFAULT_ACCENT);
    applyAccent(DEFAULT_SETTINGS.accentColor);
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("");
  });
});

// --- Combined settings application --------------------------------------------

describe("applySettingsTheme applies both theme and accent (Req 14.1, 14.3)", () => {
  it("sets data-theme and writes a custom --accent from a settings object", () => {
    const resolved = applySettingsTheme({ theme: "light", accentColor: "#abcdef" });
    expect(resolved).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#abcdef");
  });

  it("leaves no inline --accent for the default accent (per-theme token wins)", () => {
    const resolved = applySettingsTheme(
      { theme: "light", accentColor: DEFAULT_ACCENT },
    );
    expect(resolved).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("");
  });

  it("resolves system theme via the injected provider (default accent → token)", () => {
    const mq = createFakeMediaQuery(true);
    const resolved = applySettingsTheme(
      { theme: "system", accentColor: DEFAULT_ACCENT },
      providerOf(mq),
    );
    expect(resolved).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    // No inline override, so the dark per-theme token (amber) applies.
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("");
  });
});

// --- Live OS change subscription (Req 14.2) -----------------------------------

describe("subscribeSystemTheme (Req 14.2)", () => {
  it("re-applies and calls onResolved when the OS appearance changes", () => {
    const mq = createFakeMediaQuery(false);
    const resolvedSeen: string[] = [];
    const cleanup = subscribeSystemTheme(
      "system",
      (r) => resolvedSeen.push(r),
      providerOf(mq),
    );

    expect(mq.listenerCount()).toBe(1);

    // OS switches to dark.
    mq.fireChange(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(resolvedSeen).toEqual(["dark"]);

    // OS switches back to light.
    mq.fireChange(false);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(resolvedSeen).toEqual(["dark", "light"]);

    cleanup();
  });

  it("returned cleanup detaches the change listener", () => {
    const mq = createFakeMediaQuery(false);
    const resolvedSeen: string[] = [];
    const cleanup = subscribeSystemTheme(
      "system",
      (r) => resolvedSeen.push(r),
      providerOf(mq),
    );

    expect(mq.listenerCount()).toBe(1);
    cleanup();
    expect(mq.listenerCount()).toBe(0);

    // After cleanup, further OS changes must not re-apply or notify.
    mq.fireChange(true);
    expect(resolvedSeen).toEqual([]);
  });

  it('is a no-op returning a no-op cleanup for "dark"', () => {
    const mq = createFakeMediaQuery(true);
    const cleanup = subscribeSystemTheme("dark", undefined, providerOf(mq));
    // No listener attached for a non-system preference.
    expect(mq.listenerCount()).toBe(0);
    // Cleanup is safe to call.
    expect(() => cleanup()).not.toThrow();
  });

  it('is a no-op returning a no-op cleanup for "light"', () => {
    const mq = createFakeMediaQuery(false);
    const cleanup = subscribeSystemTheme("light", undefined, providerOf(mq));
    expect(mq.listenerCount()).toBe(0);
    expect(() => cleanup()).not.toThrow();
  });

  it("is a no-op when system is selected but no media query is available", () => {
    const cleanup = subscribeSystemTheme("system", undefined, providerOf(undefined));
    expect(() => cleanup()).not.toThrow();
  });
});
