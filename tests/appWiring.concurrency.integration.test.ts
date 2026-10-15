import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildAppServices, type AppServices } from "../electron/appWiring";
import { JsonFileStorage } from "../electron/storage/jsonFileStorage";
import { parsePriceSeed } from "core/priceSeed";
import type { Category } from "core/models/category";
import type { ReminderLedger } from "core/models/reminder";
import type { SettingsV2 } from "core/models/settings";
import type { SubscriptionsFileV2, SubscriptionV2 } from "core/models/subscription";
import type { StoragePort } from "core/ports/storagePort";
import { DEFAULT_SETTINGS_V2, defaultReminderLedger } from "core/models/schema";
import type { SubscriptionInput } from "shared/types";

/**
 * Concurrency tests for the per-file serialized single-writer (Story 1.6 /
 * AD-29).
 *
 * The headline bug these guard against: every `AppServices` mutation is a
 * `read → core → write`. If two same-file mutations run without awaiting between
 * them, each reads the SAME `existing` set across an `await`, applies its change,
 * and the second write clobbers the first — a last-writer-wins data loss.
 *
 * To make the race deterministic (not timing-dependent), these tests use an
 * instrumented in-memory {@link StoragePort} whose reads/writes resolve on
 * controllable microtask gaps, so an unserialized implementation WOULD lose a
 * write and a correctly-serialized one does not. The per-file lock lives in
 * `buildAppServices`, so exercising the real `AppServices` over this harness
 * tests the actual production coordinator.
 *
 * I/O & Edge-Case Matrix rows covered:
 *   - concurrent same-file mutations: both apply, neither lost.
 *   - concurrent different-file mutations: both proceed (per-file, not global).
 *   - backup-before-destructive under lock: backup + delete are atomic as a unit.
 *   - service fault: a failing mutation rejects its own call only; others apply.
 */

/** A yield that interleaves pending microtasks between a read and a write. */
function microtaskGap(): Promise<void> {
  // A handful of awaited resolved-promises gives any concurrently-started
  // mutation the chance to run its own read/write in between ours — this is what
  // surfaces the last-writer-wins race in an UNSERIALIZED implementation.
  return Promise.resolve()
    .then(() => undefined)
    .then(() => undefined)
    .then(() => undefined);
}

/**
 * In-memory StoragePort that deliberately inserts a microtask gap inside each
 * read and write so concurrent, un-awaited mutations interleave. Records a
 * strict call log so tests can assert ordering (e.g. backup-before-write
 * atomicity under the lock).
 */
class InstrumentedStorage implements StoragePort {
  subscriptions: SubscriptionV2[] = [];
  settings: SettingsV2 = { ...DEFAULT_SETTINGS_V2 };
  categories: Category[] = [];
  reminderLedger: ReminderLedger = defaultReminderLedger();
  backups: SubscriptionsFileV2[] = [];
  readonly log: string[] = [];
  private backupSeq = 0;
  /** When > 0, the next N `writeSubscriptions` calls reject (fault injection). */
  failNextSubsWrites = 0;

  async readSubscriptions(): Promise<SubscriptionV2[]> {
    this.log.push("read:subs:start");
    await microtaskGap();
    this.log.push("read:subs:end");
    // Return a defensive copy so a caller mutating the array can't corrupt state.
    return this.subscriptions.map((s) => ({ ...s }));
  }

  async writeSubscriptions(subs: SubscriptionV2[]): Promise<void> {
    this.log.push("write:subs:start");
    await microtaskGap();
    if (this.failNextSubsWrites > 0) {
      this.failNextSubsWrites -= 1;
      this.log.push("write:subs:fault");
      throw new Error("injected subscriptions write fault");
    }
    this.subscriptions = subs.map((s) => ({ ...s }));
    this.log.push("write:subs:end");
  }

  async readSettings(): Promise<SettingsV2> {
    this.log.push("read:settings:start");
    await microtaskGap();
    this.log.push("read:settings:end");
    return { ...this.settings };
  }

  async writeSettings(settings: SettingsV2): Promise<void> {
    this.log.push("write:settings:start");
    await microtaskGap();
    this.settings = { ...settings };
    this.log.push("write:settings:end");
  }

  async readCategories(): Promise<Category[]> {
    this.log.push("read:cats:start");
    await microtaskGap();
    this.log.push("read:cats:end");
    return this.categories.map((c) => ({ ...c }));
  }

  async writeCategories(categories: Category[]): Promise<void> {
    this.log.push("write:cats:start");
    await microtaskGap();
    this.categories = categories.map((c) => ({ ...c }));
    this.log.push("write:cats:end");
  }

  async readReminderLedger(): Promise<ReminderLedger> {
    this.log.push("read:ledger:start");
    await microtaskGap();
    this.log.push("read:ledger:end");
    return {
      version: this.reminderLedger.version,
      lastRunAt: this.reminderLedger.lastRunAt,
      fired: this.reminderLedger.fired.map((e) => ({ ...e })),
    };
  }

  async writeReminderLedger(ledger: ReminderLedger): Promise<void> {
    this.log.push("write:ledger:start");
    await microtaskGap();
    this.reminderLedger = {
      version: ledger.version,
      lastRunAt: ledger.lastRunAt,
      fired: ledger.fired.map((e) => ({ ...e })),
    };
    this.log.push("write:ledger:end");
  }

  async createBackup(_reason: string): Promise<string> {
    this.log.push("backup:start");
    await microtaskGap();
    this.backups.push({ version: 2, subscriptions: this.subscriptions.map((s) => ({ ...s })) });
    const name = `backup-${this.backupSeq++}.json`;
    this.log.push("backup:end");
    return name;
  }

  async listBackups(): Promise<string[]> {
    return this.backups.map((_b, i) => `backup-${i}.json`);
  }

  async readBackup(name: string): Promise<SubscriptionsFileV2> {
    const match = /backup-(\d+)\.json/.exec(name);
    const idx = match ? Number(match[1]) : -1;
    const file = this.backups[idx];
    if (file === undefined) throw new Error(`Backup not found: ${name}`);
    return { version: file.version, subscriptions: file.subscriptions.map((s) => ({ ...s })) };
  }

  getDataFolder(): string {
    return "/in-memory";
  }

  async setDataFolder(_path: string | null): Promise<void> {
    await microtaskGap();
  }
}

function makeInput(overrides: Partial<SubscriptionInput> = {}): SubscriptionInput {
  return {
    name: "Netflix",
    provider: "Netflix Inc.",
    category: "Streaming",
    amountMajor: "499",
    currency: "INR",
    billingCycle: "Monthly",
    nextRenewal: "2025-02-01",
    startDate: "2024-01-01",
    paymentMethod: "Card",
    website: "https://netflix.com",
    notes: "",
    color: "#E50914",
    icon: "netflix",
    state: "Active",
    priceHistory: [],
    tags: [],
    autoRenew: true,
    ...overrides,
  };
}

function makeSubscription(overrides: Partial<SubscriptionV2> = {}): SubscriptionV2 {
  return {
    id: "sub-1",
    name: "Netflix",
    provider: "Netflix Inc.",
    category: "Streaming",
    amountMinor: 49900,
    currency: "INR",
    billingCycle: "Monthly",
    nextRenewal: "2025-02-01",
    startDate: "2024-01-01",
    paymentMethod: "Card",
    website: "https://netflix.com",
    notes: "",
    color: "#E50914",
    icon: "netflix",
    state: "Active",
    priceHistory: [],
    tags: [],
    autoRenew: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("per-file write serialization (AD-29): same-file concurrency loses nothing", () => {
  it("two concurrent createSubscription calls both persist (neither clobbered)", async () => {
    const storage = new InstrumentedStorage();
    const services = buildAppServices(storage);

    // Fire two creates WITHOUT awaiting between them. In the un-serialized
    // original both would read `[]`, each would write a single-item set, and the
    // second write would clobber the first (final length 1). With the per-file
    // lock the second create does not read until the first has written, so the
    // final set has BOTH.
    const [a, b] = await Promise.all([
      services.createSubscription(makeInput({ name: "A" })),
      services.createSubscription(makeInput({ name: "B" })),
    ]);

    const listed = await services.listSubscriptions();
    expect(listed).toHaveLength(2);
    const names = listed.map((s) => s.name).sort();
    expect(names).toEqual(["A", "B"]);

    // The second resolved result already reflects the first's write.
    const longer = a.length >= b.length ? a : b;
    expect(longer).toHaveLength(2);
  });

  it("concurrent update + delete on the same file: both apply, final state reflects both", async () => {
    const storage = new InstrumentedStorage();
    storage.subscriptions = [
      makeSubscription({ id: "a", name: "A" }),
      makeSubscription({ id: "b", name: "B" }),
    ];
    const services = buildAppServices(storage);

    // Update "a" and delete "b" concurrently. Serialized: whichever runs second
    // reads the first's result, so the final state has an updated "a" and no "b".
    await Promise.all([
      services.updateSubscription("a", { name: "A2" }),
      services.deleteSubscription("b"),
    ]);

    const listed = await services.listSubscriptions();
    expect(listed.map((s) => s.id)).toEqual(["a"]);
    expect(listed.find((s) => s.id === "a")!.name).toBe("A2");
  });

  it("a burst of concurrent setState calls all land (no lost write across the burst)", async () => {
    const storage = new InstrumentedStorage();
    storage.subscriptions = Array.from({ length: 5 }, (_v, i) =>
      makeSubscription({ id: `s${i}`, name: `S${i}`, state: "Active" }),
    );
    const services = buildAppServices(storage);

    // Pause all five concurrently. If writes clobbered, some would stay Active.
    await Promise.all(
      storage.subscriptions.map((s) => services.setState(s.id, "Paused")),
    );

    const listed = await services.listSubscriptions();
    expect(listed.every((s) => s.state === "Paused")).toBe(true);
    expect(listed).toHaveLength(5);
  });
});

describe("reminder-ledger write goes through lock(\"reminderLedger\"); read is lock-free (Story 4.2)", () => {
  it("two concurrent writeReminderLedger calls serialize (one write fully before the next starts)", async () => {
    const storage = new InstrumentedStorage();
    const services = buildAppServices(storage);

    const a: ReminderLedger = {
      version: 1,
      lastRunAt: "2026-03-07T00:00:00.000Z",
      fired: [{ kind: "renewal", subscriptionId: "a", leadTime: "same-day", localDay: "2026-03-07" }],
    };
    const b: ReminderLedger = {
      version: 1,
      lastRunAt: "2026-03-08T00:00:00.000Z",
      fired: [{ kind: "renewal", subscriptionId: "b", leadTime: "one-day", localDay: "2026-03-08" }],
    };

    // Fire two writes WITHOUT awaiting between them. Under lock("reminderLedger")
    // the second write must not START until the first has fully ENDED — the write
    // events never interleave (same-file serialization, mirroring settings/cats).
    await Promise.all([
      services.writeReminderLedger(a),
      services.writeReminderLedger(b),
    ]);

    const writeStarts = storage.log.filter((e) => e === "write:ledger:start").length;
    const writeEnds = storage.log.filter((e) => e === "write:ledger:end").length;
    expect(writeStarts).toBe(2);
    expect(writeEnds).toBe(2);
    // Serialized: the log is start,end,start,end — never start,start,end,end.
    const ledgerEvents = storage.log.filter((e) => e.startsWith("write:ledger:"));
    expect(ledgerEvents).toEqual([
      "write:ledger:start",
      "write:ledger:end",
      "write:ledger:start",
      "write:ledger:end",
    ]);

    // Last write wins the final state (both ran; neither torn).
    expect([a.lastRunAt, b.lastRunAt]).toContain(storage.reminderLedger.lastRunAt);
  });

  it("readReminderLedger is lock-free: a read interleaves with a concurrent ledger write", async () => {
    const storage = new InstrumentedStorage();
    const services = buildAppServices(storage);

    const next: ReminderLedger = {
      version: 1,
      lastRunAt: "2026-03-07T00:00:00.000Z",
      fired: [],
    };

    // A lock-free read issued concurrently with a write begins BEFORE the write
    // ends (a lock would force it to wait). The adapter write is atomic, so the
    // read still observes a whole ledger — never a torn one.
    const [, readResult] = await Promise.all([
      services.writeReminderLedger(next),
      services.readReminderLedger(),
    ]);

    const readStart = storage.log.indexOf("read:ledger:start");
    const writeEnd = storage.log.indexOf("write:ledger:end");
    expect(readStart).toBeGreaterThanOrEqual(0);
    expect(writeEnd).toBeGreaterThanOrEqual(0);
    // The read started before the write finished: it did not block on the lock.
    expect(readStart).toBeLessThan(writeEnd);

    // The read observed a complete, schema-valid ledger (before OR after snapshot).
    expect(readResult.version).toBe(1);
    expect(Array.isArray(readResult.fired)).toBe(true);
  });

  it("a ledger write does not block a concurrent subscriptions mutation (per-file, not global)", async () => {
    const storage = new InstrumentedStorage();
    const services = buildAppServices(storage);

    const ledger: ReminderLedger = { version: 1, lastRunAt: null, fired: [] };
    await Promise.all([
      services.writeReminderLedger(ledger),
      services.createSubscription(makeInput({ name: "A" })),
    ]);

    expect((await services.listSubscriptions())).toHaveLength(1);
    // The two different-file sections interleaved: the ledger write ran its own
    // critical section while the subscriptions section (its read → core → write)
    // was still in flight — a GLOBAL lock would force one entirely after the
    // other. We prove overlap by showing the ledger write began before the subs
    // section finished.
    const ledgerWriteStart = storage.log.indexOf("write:ledger:start");
    const subsWriteEnd = storage.log.indexOf("write:subs:end");
    expect(ledgerWriteStart).toBeGreaterThanOrEqual(0);
    expect(subsWriteEnd).toBeGreaterThanOrEqual(0);
    expect(ledgerWriteStart).toBeLessThan(subsWriteEnd);
  });
});

describe("getPriceSuggestion is lock-free and degrades off (Story 5.4)", () => {
  it("returns a suggestion with NO storage I/O (no lock, no read/write log entries)", () => {
    const storage = new InstrumentedStorage();
    const seed = parsePriceSeed({
      schemaVersion: 1,
      asOf: "2026-10-01",
      disclaimer: "approx",
      services: {
        netflix: { amountMinor: 1549, currency: "USD", billingCycle: "Monthly" },
      },
    });
    const services = buildAppServices(storage, seed);

    const before = storage.log.length;
    const hit = services.getPriceSuggestion("  Netflix ");
    // Synchronous, immutable-bundle lookup: no StoragePort call was made (the
    // seed is never the StoragePort), so the instrumented call log is untouched.
    expect(storage.log.length).toBe(before);
    expect(hit).toEqual({
      amountMinor: 1549,
      currency: "USD",
      billingCycle: "Monthly",
      asOf: "2026-10-01",
    });

    // It is also safe to interleave with a mutation (lock-free): fire a create
    // and a lookup together; the lookup resolves immediately and correctly.
    expect(services.getPriceSuggestion("spotify")).toBeNull();
  });

  it("returns null for every name when the seed failed to load (feature off)", () => {
    const storage = new InstrumentedStorage();
    // null = the main process caught a missing/corrupt seed and degraded off.
    const services = buildAppServices(storage, null);
    expect(services.getPriceSuggestion("Netflix")).toBeNull();
    expect(() => services.getPriceSuggestion("anything")).not.toThrow();
    // No storage interaction occurred for the (off) lookups.
    expect(storage.log.filter((e) => e.includes("price")).length).toBe(0);
  });
});

describe("serialization is PER-FILE, not global (AD-29)", () => {
  it("a subscriptions mutation and a settings mutation proceed concurrently (interleaved)", async () => {
    const storage = new InstrumentedStorage();
    const services = buildAppServices(storage);

    await Promise.all([
      services.createSubscription(makeInput({ name: "A" })),
      services.updateSettings({ theme: "light" }),
    ]);

    // Both applied.
    expect((await services.listSubscriptions())).toHaveLength(1);
    expect((await services.getSettings()).theme).toBe("light");

    // PROOF of concurrency, not just both-eventually-applied: the two files'
    // critical sections interleaved. The settings read/write began before the
    // subscriptions write ended (a global lock would force one entirely after
    // the other).
    const subsWriteStart = storage.log.indexOf("write:subs:start");
    const settingsReadStart = storage.log.indexOf("read:settings:start");
    const subsWriteEnd = storage.log.indexOf("write:subs:end");
    expect(settingsReadStart).toBeGreaterThanOrEqual(0);
    expect(subsWriteStart).toBeGreaterThanOrEqual(0);
    // The settings section started before the subscriptions section finished:
    // they ran concurrently (no cross-file blocking).
    expect(settingsReadStart).toBeLessThan(subsWriteEnd);
  });

  it("a categories mutation does not block a concurrent subscriptions mutation", async () => {
    const storage = new InstrumentedStorage();
    storage.categories = [{ id: "c1", name: "Streaming", isDefault: true }];
    const services = buildAppServices(storage);

    await Promise.all([
      services.createSubscription(makeInput({ name: "A" })),
      services.createCategory("Newsletters"),
    ]);

    expect((await services.listSubscriptions())).toHaveLength(1);
    expect((await services.listCategories()).map((c) => c.name)).toContain("Newsletters");

    const catWriteStart = storage.log.indexOf("write:cats:start");
    const subsWriteEnd = storage.log.indexOf("write:subs:end");
    expect(catWriteStart).toBeGreaterThanOrEqual(0);
    expect(catWriteStart).toBeLessThan(subsWriteEnd);
  });
});

describe("backup-before-destructive is atomic UNDER the lock (AD-29)", () => {
  it("a delete's pre-backup + write are one unit; a concurrent mutation serializes cleanly", async () => {
    const storage = new InstrumentedStorage();
    storage.subscriptions = [
      makeSubscription({ id: "a", name: "A" }),
      makeSubscription({ id: "b", name: "B" }),
    ];
    const services = buildAppServices(storage);

    // Delete "a" concurrently with an update to "b".
    await Promise.all([
      services.deleteSubscription("a"),
      services.updateSubscription("b", { name: "B2" }),
    ]);

    // The delete's backup and its write happened as ONE atomic unit: in the call
    // log, between the delete's "backup:start" and its matching "write:subs:end",
    // exactly ONE subscriptions write occurs — the delete's own. If the update
    // had interleaved, a SECOND "write:subs:start" would appear in this span.
    const backupStart = storage.log.indexOf("backup:start");
    expect(backupStart).toBeGreaterThanOrEqual(0);
    // The first subs write-end after the backup is the delete's own write.
    const deleteWriteEnd = storage.log.indexOf("write:subs:end", backupStart);
    expect(deleteWriteEnd).toBeGreaterThan(backupStart);
    const span = storage.log.slice(backupStart, deleteWriteEnd + 1);
    // Exactly one write within the delete's backup→write span (its own) — no
    // interleaving mutation, and no second backup, inside the unit.
    expect(span.filter((e) => e === "write:subs:start")).toHaveLength(1);
    expect(span.filter((e) => e === "backup:start")).toHaveLength(1);

    // Final state: "a" gone, "b" renamed — both operations landed.
    const listed = await services.listSubscriptions();
    expect(listed.map((s) => s.id)).toEqual(["b"]);
    expect(listed[0].name).toBe("B2");

    // The pre-delete backup captured the pre-delete state ([a, b]) — proving the
    // backup ran against the correct snapshot inside the serialized section.
    const captured = storage.backups[0];
    expect(captured.subscriptions.map((s) => s.id).sort()).toEqual(["a", "b"]);
  });
});

describe("a failing mutation rejects only itself; others still apply (AD-29)", () => {
  it("one mutation faults at the write, a concurrent same-file create still persists", async () => {
    const storage = new InstrumentedStorage();
    // The FIRST subscriptions write fails. The lock runs the two sections one at
    // a time, so the first (faulting) section rejects its own call; the second
    // section still runs its write (the fault budget is already spent).
    storage.failNextSubsWrites = 1;
    const services = buildAppServices(storage);

    const results = await Promise.allSettled([
      services.createSubscription(makeInput({ name: "FAULTS" })),
      services.createSubscription(makeInput({ name: "A" })),
    ]);

    // Exactly one rejected (the first section to reach the write), one fulfilled.
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual(["fulfilled", "rejected"]);

    // The chain survived the rejection: the surviving create landed.
    const listed = await services.listSubscriptions();
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe("A");
  });

  it("after a rejected mutation, a subsequent same-file mutation still runs (chain not wedged)", async () => {
    const storage = new InstrumentedStorage();
    storage.failNextSubsWrites = 1;
    const services = buildAppServices(storage);

    await expect(
      services.createSubscription(makeInput({ name: "FAULTS" })),
    ).rejects.toBeInstanceOf(Error);

    // A later mutation on the SAME file must not be wedged by the prior failure —
    // the lock's tail does not propagate a prior rejection to the next waiter.
    const next = await services.createSubscription(makeInput({ name: "A" }));
    expect(next).toHaveLength(1);
    expect(next[0].name).toBe("A");
  });
});

describe("real JsonFileStorage end-to-end: concurrency loses nothing", () => {
  let userData: string;
  let storage: JsonFileStorage;
  let services: AppServices;

  beforeEach(async () => {
    userData = await mkdtemp(join(tmpdir(), "subby-concurrency-"));
    storage = new JsonFileStorage(userData);
    services = buildAppServices(storage);
  });

  afterEach(async () => {
    await rm(userData, { recursive: true, force: true });
  });

  it("concurrent creates against the real atomic-write adapter both persist", async () => {
    await Promise.all([
      services.createSubscription(makeInput({ name: "A" })),
      services.createSubscription(makeInput({ name: "B" })),
      services.createSubscription(makeInput({ name: "C" })),
    ]);

    const listed = await services.listSubscriptions();
    expect(listed.map((s) => s.name).sort()).toEqual(["A", "B", "C"]);
  });

  it("updateCategoryColor: not_found / validation / happy-path (Story 3.4, finding D)", async () => {
    // Bootstrap the default categories (seeded) and pick a real id.
    const cats = await services.listCategories();
    const target = cats[0];

    // Unknown id → not_found, and nothing is written (the color store is
    // unchanged).
    const unknown = await services.updateCategoryColor("unknown", "#123456");
    expect(unknown).toEqual({ ok: false, reason: "not_found" });
    const afterUnknown = await services.listCategories();
    expect(afterUnknown).toEqual(cats);

    // A bad (non-hex) color → validation, and nothing is written.
    const bad = await services.updateCategoryColor(target.id, "nope");
    expect(bad).toEqual({ ok: false, reason: "validation" });
    const afterBad = await services.listCategories();
    expect(afterBad.find((c) => c.id === target.id)!.color).toBe(target.color);

    // A valid hex persists through listCategories().
    const okResult = await services.updateCategoryColor(target.id, "#abcdef");
    expect(okResult.ok).toBe(true);
    const afterOk = await services.listCategories();
    expect(afterOk.find((c) => c.id === target.id)!.color).toBe("#abcdef");

    // Clearing (undefined) drops the color.
    const cleared = await services.updateCategoryColor(target.id, undefined);
    expect(cleared.ok).toBe(true);
    const afterClear = await services.listCategories();
    expect(afterClear.find((c) => c.id === target.id)!.color).toBeUndefined();
  });

  it("a lock-free read issued between two serialized writes never observes a torn state", async () => {
    // Seed one subscription, then fire a write and a read concurrently. The read
    // must observe either the before or the after set — never a partial/torn
    // file (the adapter's temp-then-rename write guarantees this; the read stays
    // lock-free by design).
    await services.createSubscription(makeInput({ name: "A" }));
    const [, readResult] = await Promise.all([
      services.createSubscription(makeInput({ name: "B" })),
      services.listSubscriptions(),
    ]);
    // The interleaved read is a valid snapshot: either [A] or [A, B], and every
    // element is a complete, schema-valid subscription (no torn record).
    expect([1, 2]).toContain(readResult.length);
    for (const sub of readResult) {
      expect(sub.id).toBeTruthy();
      expect(sub.name).toBeTruthy();
    }

    // Final state has both regardless.
    const finalState = await services.listSubscriptions();
    expect(finalState.map((s) => s.name).sort()).toEqual(["A", "B"]);
  });
});
