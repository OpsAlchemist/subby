// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import StaleRateNote from "@/components/StaleRateNote";

/**
 * StaleRateNote unit tests (Story 6.3; shared Story 2.4 / AD-12 affordance).
 *
 * The note is the ONE honest stale-rate treatment used by both the Dashboard
 * and Analytics: a focusable, text-labelled, NON-interactive `role="note"`
 * (there is no FX-refresh action until Epic 8 — so NOT a button that does
 * nothing), conveying the snapshot age in TEXT (not color alone). It also
 * clamps a floored `monthsStale` of 0 up to 1 so it never reads "0 months old".
 */

afterEach(cleanup);

describe("StaleRateNote contract (Story 2.4 / AD-12)", () => {
  it("is a focusable role=note, NOT a button", () => {
    render(<StaleRateNote months={3} asOf="Jan 1, 2026" />);
    const note = screen.getByRole("note");
    expect(note.tagName).not.toBe("BUTTON");
    expect(note).toHaveAttribute("tabindex", "0");
    note.focus();
    expect(note).toHaveFocus();
  });

  it("carries the 'as of' date in text", () => {
    render(<StaleRateNote months={2} asOf="Mar 4, 2026" />);
    expect(screen.getByRole("note")).toHaveTextContent(/as of Mar 4, 2026/);
  });
});

describe("StaleRateNote age copy", () => {
  it("clamps a 0-month floor up to 'about 1 month old' (never 0)", () => {
    render(<StaleRateNote months={0} asOf="x" />);
    expect(screen.getByRole("note")).toHaveTextContent(/about 1 month old/);
    expect(screen.getByRole("note")).not.toHaveTextContent(/0 month/);
  });

  it("reads singular 'about 1 month old' for exactly one month", () => {
    render(<StaleRateNote months={1} asOf="x" />);
    expect(screen.getByRole("note")).toHaveTextContent(/about 1 month old/);
    expect(screen.getByRole("note")).not.toHaveTextContent(/1 months/);
  });

  it("reads plural 'about N months old' for N > 1", () => {
    render(<StaleRateNote months={7} asOf="x" />);
    expect(screen.getByRole("note")).toHaveTextContent(/about 7 months old/);
  });
});
