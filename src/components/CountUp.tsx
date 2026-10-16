/**
 * Count-up numeric animation (Story 6.1).
 *
 * Animates a numeric figure from 0 (or its previous value) up to `value` over a
 * short duration via `requestAnimationFrame`, formatting each frame through the
 * supplied `format`. Renders with `tabular-nums` so the digits do not reflow as
 * they change.
 *
 * Reduced-motion / test honesty (the whole reason this is a component, not a
 * bare `<span>`): when {@link useReducedMotion} is `true` — the user asked for
 * reduced motion, OR `window.matchMedia` is absent (the jsdom test env) — the
 * component renders the FINAL `value` SYNCHRONOUSLY on every render and starts
 * NO rAF loop. So reduced-motion users get no animation, tests can assert the
 * real figure immediately (no timers to flush), and there is never a dangling
 * rAF handle.
 */

import { useEffect, useRef, useState } from "react";

import { useReducedMotion } from "@/hooks/useReducedMotion";

/** Default animation duration (ms). Short — a quick settle, not a long crawl. */
const DEFAULT_DURATION_MS = 450;

export interface CountUpProps {
  /** The target numeric value to display (and animate toward). */
  value: number;
  /** Formats the (interpolated) number into the displayed string. */
  format: (n: number) => string;
  /** Optional class applied to the output `<span>` (merged after `tabular-nums`). */
  className?: string;
  /** Optional override for the animation duration in milliseconds. */
  durationMs?: number;
}

/** Ease-out cubic — a natural fast-then-settle feel. */
function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

/**
 * A figure that counts up to `value`. Snaps to the final value synchronously
 * under reduced motion (or in a `matchMedia`-less env). Renders `tabular-nums`.
 */
export default function CountUp({
  value,
  format,
  className,
  durationMs = DEFAULT_DURATION_MS,
}: CountUpProps): JSX.Element {
  const reduced = useReducedMotion();
  // The displayed number. Under reduced motion this is simply `value` every
  // render (no state churn, no rAF). When motion is allowed it is driven by the
  // rAF loop below, starting from the previous displayed value — and from 0 on
  // the FIRST mount so the figure genuinely counts UP from zero on load
  // (AC: "figures count up on load"), not appearing pre-landed at the target.
  const [display, setDisplay] = useState<number>(reduced ? value : 0);
  const prevValueRef = useRef<number>(reduced ? value : 0);

  useEffect(() => {
    // Reduced motion (or no matchMedia): render the final value synchronously,
    // run NO animation. This is the test/path-honest branch — the figure is
    // assertable immediately and no rAF timer is ever scheduled.
    if (reduced) {
      prevValueRef.current = value;
      setDisplay(value);
      return;
    }

    const from = prevValueRef.current;
    const to = value;
    prevValueRef.current = value;
    if (from === to) {
      setDisplay(to);
      return;
    }

    let raf = 0;
    let start: number | null = null;
    const step = (now: number): void => {
      if (start === null) start = now;
      const elapsed = now - start;
      const t = Math.min(1, elapsed / durationMs);
      const eased = easeOutCubic(t);
      setDisplay(from + (to - from) * eased);
      if (t < 1) {
        raf = requestAnimationFrame(step);
      } else {
        setDisplay(to); // land exactly on the target, free of float drift
      }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, reduced, durationMs]);

  // Under reduced motion, format `value` directly so the first (and only) paint
  // is already the final figure — never a transient `display` from a prior value.
  const shown = reduced ? value : display;
  return (
    <span className={className ? `tabular-nums ${className}` : "tabular-nums"}>
      {format(shown)}
    </span>
  );
}
