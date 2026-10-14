import { describe, it, expect } from "vitest";

import {
  createCategory,
  deleteCategory,
  categoryAssignmentCount,
  isCategoryInUse,
  mergeSettings,
  assignDefaultColors,
  setCategoryColor,
  addTag,
  removeTag,
} from "core/categories";
import type { Category } from "core/models/category";
import type { Subscription } from "core/models/subscription";
import { DEFAULT_SETTINGS, DEFAULT_CATEGORY_COLORS } from "core/models/schema";

/**
 * Unit tests for category management and settings-merge helpers
 * (Req 7.2, 7.3, 7.4, 15.2). These are example/edge-case tests; the
 * universal properties are covered by the property tests in task 6.4.
 */

// --- Fixtures ----------------------------------------------------------------

function category(name: string, isDefault = false): Category {
  return { id: `id-${name}`, name, isDefault };
}

function subscription(category: string): Subscription {
  return {
    id: `sub-${category}-${Math.random()}`,
    name: "Some service",
    provider: "Provider",
    category,
    amount: 100,
    currency: "INR",
    billingCycle: "Monthly",
    nextRenewal: "2025-01-01",
    startDate: "2024-01-01",
    paymentMethod: "card",
    website: "",
    notes: "",
    color: "#000000",
    icon: "box",
    isActive: true,
    autoRenew: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

// --- createCategory (Req 7.2, 7.3) -------------------------------------------

describe("createCategory", () => {
  it("appends a new custom category with a unique id and isDefault false (Req 7.2)", () => {
    const existing = [category("Entertainment", true)];
    const result = createCategory(existing, "Side Projects");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.categories).toHaveLength(2);
      expect(result.created.name).toBe("Side Projects");
      expect(result.created.isDefault).toBe(false);
      expect(result.created.id).toBeTruthy();
      // input is not mutated (purity)
      expect(existing).toHaveLength(1);
    }
  });

  it("trims surrounding whitespace from the stored name", () => {
    const result = createCategory([], "  Music  ");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.created.name).toBe("Music");
    }
  });

  it("rejects an exact duplicate name and echoes the existing name (Req 7.3)", () => {
    const result = createCategory([category("Streaming")], "Streaming");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("duplicate");
      expect(result.name).toBe("Streaming");
    }
  });

  it("rejects a case-insensitive / whitespace duplicate (Req 7.3)", () => {
    const result = createCategory([category("Streaming")], "  streaming ");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.name).toBe("Streaming");
    }
  });
});

// --- delete-detection + delete (Req 7.4) -------------------------------------

describe("categoryAssignmentCount / isCategoryInUse", () => {
  it("counts subscriptions assigned to the category name (Req 7.4)", () => {
    const subs = [subscription("AI"), subscription("AI"), subscription("Music")];
    expect(categoryAssignmentCount(subs, "AI")).toBe(2);
    expect(categoryAssignmentCount(subs, "Music")).toBe(1);
    expect(categoryAssignmentCount(subs, "Gaming")).toBe(0);
  });

  it("reports in-use status used to decide whether to prompt (Req 7.4)", () => {
    const subs = [subscription("AI")];
    expect(isCategoryInUse(subs, "AI")).toBe(true);
    expect(isCategoryInUse(subs, "Gaming")).toBe(false);
    expect(isCategoryInUse([], "AI")).toBe(false);
  });
});

describe("deleteCategory", () => {
  it("removes exactly the category with the matching id and preserves order", () => {
    const existing = [category("A"), category("B"), category("C")];
    const next = deleteCategory(existing, "id-B");
    expect(next.map((c) => c.name)).toEqual(["A", "C"]);
    // input is not mutated (purity)
    expect(existing).toHaveLength(3);
  });

  it("returns an equivalent list when no id matches", () => {
    const existing = [category("A")];
    expect(deleteCategory(existing, "missing")).toEqual(existing);
  });
});

// --- assignDefaultColors (Story 3.4 one-time seed) ---------------------------

describe("assignDefaultColors", () => {
  it("fills a missing color on a default-named category from the seed palette", () => {
    const existing = [category("Streaming", true)];
    const next = assignDefaultColors(existing);
    expect(next[0].color).toBe(DEFAULT_CATEGORY_COLORS["Streaming"]);
    // Purity: input not mutated.
    expect(existing[0].color).toBeUndefined();
  });

  it("NEVER overwrites a user-set color on a default-named category", () => {
    const existing = [{ ...category("Streaming", true), color: "#abcdef" }];
    const next = assignDefaultColors(existing);
    expect(next[0].color).toBe("#abcdef");
  });

  it("NEVER touches a custom (non-default-named) category", () => {
    const existing = [category("Side Projects", false)];
    const next = assignDefaultColors(existing);
    expect(next[0].color).toBeUndefined();
  });

  it("seeds every default name and leaves custom + already-colored intact", () => {
    const existing: Category[] = [
      category("AI", true), // → gets seeded
      { ...category("Music", true), color: "#111111" }, // kept
      category("My Stuff", false), // custom → untouched
    ];
    const next = assignDefaultColors(existing);
    expect(next[0].color).toBe(DEFAULT_CATEGORY_COLORS["AI"]);
    expect(next[1].color).toBe("#111111");
    expect(next[2].color).toBeUndefined();
    // Order preserved.
    expect(next.map((c) => c.name)).toEqual(["AI", "Music", "My Stuff"]);
  });
});

// --- setCategoryColor (Story 3.4) --------------------------------------------

describe("setCategoryColor", () => {
  it("sets the color on exactly the matching id, returning a new array", () => {
    const existing = [category("A"), category("B")];
    const next = setCategoryColor(existing, "id-A", "#123456");
    expect(next.find((c) => c.name === "A")!.color).toBe("#123456");
    expect(next.find((c) => c.name === "B")!.color).toBeUndefined();
    // Purity.
    expect(existing[0].color).toBeUndefined();
    expect(next).not.toBe(existing);
  });

  it("clears the color by DROPPING the key when passed undefined", () => {
    const existing = [{ ...category("A"), color: "#123456" }];
    const next = setCategoryColor(existing, "id-A", undefined);
    expect(next[0].color).toBeUndefined();
    // The key is actually absent (not an empty string).
    expect("color" in next[0]).toBe(false);
  });

  it("is a no-op (new array, identical contents) for an unknown id", () => {
    const existing = [category("A")];
    const next = setCategoryColor(existing, "missing", "#000000");
    expect(next).toEqual(existing);
  });
});

// --- addTag / removeTag (Story 3.4) ------------------------------------------

describe("addTag", () => {
  it("appends a trimmed tag, order-preserving", () => {
    expect(addTag(["Work"], "  Personal  ")).toEqual(["Work", "Personal"]);
  });

  it("ignores a blank / whitespace-only tag", () => {
    expect(addTag(["Work"], "   ")).toEqual(["Work"]);
    expect(addTag(["Work"], "")).toEqual(["Work"]);
  });

  it("de-duplicates case-insensitively, keeping the first-seen casing", () => {
    expect(addTag(["Work"], "work")).toEqual(["Work"]);
    expect(addTag(["Work"], " WORK ")).toEqual(["Work"]);
  });

  it("never mutates the input array", () => {
    const tags = ["Work"];
    const next = addTag(tags, "Play");
    expect(tags).toEqual(["Work"]);
    expect(next).not.toBe(tags);
  });
});

describe("removeTag", () => {
  it("removes a tag matched trimmed + case-insensitively", () => {
    expect(removeTag(["Work", "Play"], " work ")).toEqual(["Play"]);
    expect(removeTag(["Work", "Play"], "PLAY")).toEqual(["Work"]);
  });

  it("preserves order and leaves non-matches intact; never mutates input", () => {
    const tags = ["A", "B", "C"];
    const next = removeTag(tags, "B");
    expect(next).toEqual(["A", "C"]);
    expect(tags).toEqual(["A", "B", "C"]);
  });
});

// --- mergeSettings (Req 15.2) ------------------------------------------------

describe("mergeSettings", () => {
  it("applies a top-level patch and returns a new object (Req 15.2)", () => {
    const next = mergeSettings(DEFAULT_SETTINGS, { theme: "light", accentColor: "#FF0000" });
    expect(next.theme).toBe("light");
    expect(next.accentColor).toBe("#FF0000");
    // unspecified fields preserved
    expect(next.defaultCurrency).toBe(DEFAULT_SETTINGS.defaultCurrency);
    // input not mutated
    expect(DEFAULT_SETTINGS.theme).toBe("dark");
    expect(next).not.toBe(DEFAULT_SETTINGS);
  });

  it("deep-merges the nested notification object, preserving unspecified fields", () => {
    const next = mergeSettings(DEFAULT_SETTINGS, { notification: { enabled: false } as never });
    expect(next.notification.enabled).toBe(false);
    // leadTimes preserved from current
    expect(next.notification.leadTimes).toEqual(DEFAULT_SETTINGS.notification.leadTimes);
  });

  it("replaces leadTimes when provided and does not share the array reference", () => {
    const newLeadTimes = ["same-day" as const];
    const next = mergeSettings(DEFAULT_SETTINGS, {
      notification: { enabled: true, leadTimes: newLeadTimes },
    });
    expect(next.notification.leadTimes).toEqual(["same-day"]);
    expect(next.notification.leadTimes).not.toBe(newLeadTimes);
  });

  it("returns a fresh notification object even when notification is not patched", () => {
    const next = mergeSettings(DEFAULT_SETTINGS, { theme: "system" });
    expect(next.notification).not.toBe(DEFAULT_SETTINGS.notification);
    expect(next.notification).toEqual(DEFAULT_SETTINGS.notification);
  });
});
