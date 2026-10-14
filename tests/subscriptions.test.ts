import { describe, expect, it } from "vitest";

import { distinctTags } from "core/subscriptions";

/**
 * Unit tests for the pure `distinctTags` helper (Story 3.5, FR-4) backing the
 * List's Tag filter options. The contract: first-seen order, exact-case dedup,
 * blank/whitespace-only tags dropped, input never mutated.
 */

/** Minimal structural fixture matching the helper's `{ tags: string[] }` shape. */
function sub(tags: string[]): { tags: string[] } {
  return { tags };
}

describe("distinctTags (Story 3.5, FR-4)", () => {
  it("returns an empty array for no subscriptions", () => {
    expect(distinctTags([])).toEqual([]);
  });

  it("returns an empty array when every sub is tagless", () => {
    expect(distinctTags([sub([]), sub([])])).toEqual([]);
  });

  it("collects distinct tags in first-seen order across subs (within a sub, left-to-right)", () => {
    const result = distinctTags([
      sub(["Work", "Home"]),
      sub(["Home", "Travel"]),
      sub(["Work"]),
    ]);
    expect(result).toEqual(["Work", "Home", "Travel"]);
  });

  it("dedups exact-case: 'Work' and 'work' are DISTINCT options", () => {
    const result = distinctTags([sub(["Work"]), sub(["work"]), sub(["Work"])]);
    expect(result).toEqual(["Work", "work"]);
  });

  it("matches the spec's option-order example", () => {
    // subs with tags ["Work","Home"], ["work"], []  →  "Work","Home","work"
    const result = distinctTags([
      sub(["Work", "Home"]),
      sub(["work"]),
      sub([]),
    ]);
    expect(result).toEqual(["Work", "Home", "work"]);
  });

  it("drops blank and whitespace-only tags", () => {
    const result = distinctTags([sub(["", "   ", "Work", "\t"])]);
    expect(result).toEqual(["Work"]);
  });

  it("does not mutate the input subscriptions or their tag arrays", () => {
    const input = [sub(["Work", "Home"]), sub(["Work"])];
    const snapshot = input.map((s) => [...s.tags]);
    distinctTags(input);
    expect(input.map((s) => s.tags)).toEqual(snapshot);
  });
});
