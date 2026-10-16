// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import CountUp from "@/components/CountUp";
import Skeleton from "@/components/Skeleton";
import { useReducedMotion } from "@/hooks/useReducedMotion";

/**
 * A controllable `matchMedia` stub: tracks `change` listeners and lets a test
 * flip `matches` and dispatch a change event. Returns a restore function.
 */
function stubMatchMedia(initialMatches: boolean): {
  setMatches: (next: boolean) => void;
  restore: () => void;
} {
  const original = window.matchMedia;
  let matches = initialMatches;
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  window.matchMedia = ((query: string) => ({
    get matches() {
      return matches;
    },
    media: query,
    onchange: null,
    addEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) =>
      listeners.add(cb),
    removeEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) =>
      listeners.delete(cb),
    addListener: (cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
    removeListener: (cb: (e: MediaQueryListEvent) => void) => listeners.delete(cb),
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return {
    setMatches(next: boolean) {
      matches = next;
      for (const cb of listeners) cb({ matches } as MediaQueryListEvent);
    },
    restore() {
      window.matchMedia = original;
    },
  };
}

/**
 * Unit tests for the Story 6.1 animation/placeholder primitives.
 *
 * The through-line is test honesty: jsdom has no `matchMedia`, so
 * `useReducedMotion` returns `true` and `CountUp` renders the FINAL value
 * SYNCHRONOUSLY — a real figure to assert, with no rAF timer to leak. `Skeleton`
 * is decorative (`aria-hidden`) and its pulse is suppressed under reduced motion.
 */

afterEach(cleanup);

// --- useReducedMotion ---------------------------------------------------------

describe("useReducedMotion", () => {
  function Probe(): JSX.Element {
    const reduced = useReducedMotion();
    return <span data-testid="reduced">{String(reduced)}</span>;
  }

  it("defaults to reduced=true when matchMedia is absent (jsdom/test env)", () => {
    // jsdom does not implement matchMedia; the hook's safe default is reduced.
    expect(typeof window.matchMedia).not.toBe("function");
    render(<Probe />);
    expect(screen.getByTestId("reduced")).toHaveTextContent("true");
  });

  it("reflects the media query match when matchMedia IS available", () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: false, // motion ALLOWED
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;

    render(<Probe />);
    expect(screen.getByTestId("reduced")).toHaveTextContent("false");

    window.matchMedia = original;
  });

  it("updates when the media query fires a 'change' event", () => {
    const mm = stubMatchMedia(false); // start: motion allowed
    try {
      render(<Probe />);
      expect(screen.getByTestId("reduced")).toHaveTextContent("false");

      // User flips the OS "reduce motion" preference → the hook re-renders.
      act(() => mm.setMatches(true));
      expect(screen.getByTestId("reduced")).toHaveTextContent("true");

      // …and back off again.
      act(() => mm.setMatches(false));
      expect(screen.getByTestId("reduced")).toHaveTextContent("false");
    } finally {
      mm.restore();
    }
  });
});

// --- CountUp ------------------------------------------------------------------

describe("CountUp", () => {
  it("renders the FINAL value synchronously under reduced motion (no animation)", () => {
    render(<CountUp value={1234.5} format={(n) => `$${n.toFixed(2)}`} />);
    // Not a transient 0 or interpolated frame — the exact final figure.
    expect(screen.getByText("$1234.50")).toBeInTheDocument();
  });

  it("renders with tabular-nums for non-reflowing digits", () => {
    const { container } = render(
      <CountUp value={42} format={(n) => String(Math.round(n))} />,
    );
    const span = container.querySelector("span");
    expect(span).not.toBeNull();
    expect(span!.className).toContain("tabular-nums");
    expect(span).toHaveTextContent("42");
  });

  it("merges a provided className after tabular-nums", () => {
    const { container } = render(
      <CountUp value={1} format={() => "x"} className="text-xl" />,
    );
    const span = container.querySelector("span")!;
    expect(span.className).toContain("tabular-nums");
    expect(span.className).toContain("text-xl");
  });

  it("animates (interpolates) and lands exactly on the target when motion is ALLOWED", () => {
    const mm = stubMatchMedia(false); // motion allowed → rAF path, not snap
    // A controllable rAF: capture the single pending callback; a test "frame"
    // invokes it with an explicit timestamp. cancel clears the pending handle.
    let pending: FrameRequestCallback | null = null;
    let nextHandle = 1;
    let cancelCalls = 0;
    const rafSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb: FrameRequestCallback) => {
        pending = cb;
        return nextHandle++;
      });
    const cancelSpy = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => {
        cancelCalls += 1;
        pending = null;
      });
    const frame = (ts: number): void => {
      const cb = pending;
      pending = null;
      if (cb) act(() => cb(ts));
    };

    try {
      // Duration 400ms: identity formatter so we can read the numeric value.
      const { container, unmount } = render(
        <CountUp value={100} format={(n) => n.toFixed(2)} durationMs={400} />,
      );
      const read = (): number =>
        Number(container.querySelector("span")!.textContent);

      // The effect scheduled the first frame.
      expect(rafSpy).toHaveBeenCalled();

      // Frame 1 establishes start=0. Value stays at the start (0).
      frame(0);
      expect(read()).toBeCloseTo(0, 5);

      // Half the duration → eased interpolation puts us strictly between 0 and
      // 100 (ease-out, so already past the midpoint but not yet landed).
      frame(200);
      const mid = read();
      expect(mid).toBeGreaterThan(0);
      expect(mid).toBeLessThan(100);

      // At/after full duration → lands EXACTLY on the target (no float drift).
      frame(400);
      expect(read()).toBe(100);

      // Once landed, no further frame is scheduled (animation complete).
      expect(pending).toBeNull();

      // Unmount while idle still runs cancelAnimationFrame (effect cleanup).
      unmount();
      expect(cancelSpy).toHaveBeenCalled();
      expect(cancelCalls).toBeGreaterThan(0);
    } finally {
      rafSpy.mockRestore();
      cancelSpy.mockRestore();
      mm.restore();
    }
  });
});

// --- Skeleton -----------------------------------------------------------------

describe("Skeleton", () => {
  it("is aria-hidden (decorative) and tokenized", () => {
    const { container } = render(<Skeleton className="h-8 w-32" />);
    const block = container.firstElementChild as HTMLElement;
    expect(block).toHaveAttribute("aria-hidden", "true");
    expect(block.className).toContain("bg-muted");
    expect(block.className).toContain("h-8");
    expect(block.className).toContain("w-32");
  });

  it("suppresses its pulse under reduced motion (motion-reduce:animate-none)", () => {
    const { container } = render(<Skeleton />);
    const block = container.firstElementChild as HTMLElement;
    expect(block.className).toContain("animate-pulse");
    expect(block.className).toContain("motion-reduce:animate-none");
  });
});
