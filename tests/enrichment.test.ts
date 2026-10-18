import { afterEach, describe, expect, it, vi } from "vitest";

import { EnrichmentService } from "../electron/services/enrichment";
import type {
  EnrichmentServices,
  FxProvider,
  LogoProvider,
} from "../electron/services/enrichment";
import { NetworkGateError } from "../electron/net/gateway";
import type { BundledFxSnapshot, FxOverride } from "core/fxSnapshot";
import type { OnlineSettingsV2, SettingsV2 } from "core/models/settings";

/**
 * EnrichmentService — the serial logo-enrichment pipeline (Story 8.4; AD-8/9/28).
 *
 * The real Electron window + gateway socket cannot run headlessly; these tests
 * exercise the SERVICE behavior through its injectable seams:
 *   - `services.getSettings` — a stub returning controllable online toggles.
 *   - `provider`             — a fake logo provider (fixed bytes, a throw, or a
 *     NetworkGateError) so no real socket opens.
 *   - `blobCache`            — an in-memory fake tracking has/write (never-refetch
 *     + the broadcast trigger).
 *   - `getWindow`            — a fake window whose `webContents.send` is a spy,
 *     so coalesced-broadcast counts are assertable.
 *
 * Covers the I/O matrix: enqueue-returns-now, gate-closed-silent, successful
 * fetch → cache write → ONE coalesced broadcast, failed-fetch-silent,
 * already-cached-no-refetch, serial FIFO ordering, and the drain-only-after-start
 * (AD-28) ordering.
 */

// --- Fakes -------------------------------------------------------------------

function makeSettings(online: OnlineSettingsV2): SettingsV2 {
  return {
    homeCurrency: "INR",
    notification: { enabled: false, leadTimes: [] },
    backupFrequency: "off",
    theme: "dark",
    accentColor: "#92400e",
    trayMode: false,
    dataFolder: null,
    online,
    lastBackupAt: null,
  };
}

/** A stub `EnrichmentServices` whose online toggles can be mutated between jobs. */
function makeServices(online: OnlineSettingsV2) {
  const state = { online };
  const getSettings = vi.fn(async () => makeSettings(state.online));
  const services: EnrichmentServices = { getSettings };
  return { services, state, getSettings };
}

/** An in-memory blob cache fake: tracks `has` membership + records writes. */
function makeBlobCache(initial: string[] = []) {
  const present = new Set(initial.map((d) => d.toLowerCase()));
  const writes: Array<{ domain: string; contentType: string; bytes: Uint8Array }> =
    [];
  const has = vi.fn(async (domain: string) => present.has(domain.toLowerCase()));
  const write = vi.fn(
    async (domain: string, bytes: Uint8Array, contentType: string) => {
      writes.push({ domain: domain.toLowerCase(), bytes, contentType });
      present.add(domain.toLowerCase());
      return true;
    },
  );
  // Only `has`/`write` are used by the service; cast to the class type.
  const blobCache = { has, write } as unknown as import(
    "../electron/services/logoBlobCache"
  ).LogoBlobCache;
  return { blobCache, present, writes, has, write };
}

/** A fake window with a `webContents.send` spy; `destroyed` is toggleable. */
function makeWindow() {
  const send = vi.fn();
  const win = {
    isDestroyed: () => false,
    webContents: { send },
  };
  const getWindow = () => win as never;
  return { getWindow, send };
}

/** A provider that returns fixed bytes for every domain (a successful fetch). */
function okProvider(contentType = "image/png"): LogoProvider {
  return vi.fn(async (domain: string) => ({
    bytes: new Uint8Array([domain.length, 1, 2]),
    contentType,
  }));
}

const ALL_OFF: OnlineSettingsV2 = { liveLogoFetch: false, fxRefresh: false };
const LOGO_ON: OnlineSettingsV2 = { liveLogoFetch: true, fxRefresh: false };
const FX_ON: OnlineSettingsV2 = { liveLogoFetch: false, fxRefresh: true };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// --- enqueue returns immediately (AD-9) --------------------------------------

describe("enqueue returns immediately; the worker runs later (AD-9)", () => {
  it("enqueue is synchronous and does not await the provider", () => {
    const { services } = makeServices(LOGO_ON);
    const { blobCache } = makeBlobCache();
    const provider = okProvider();
    const { getWindow } = makeWindow();
    const svc = new EnrichmentService({ services, blobCache, getWindow, provider });
    svc.start();

    // Returns void synchronously; the provider has not been called yet (the
    // drain is a microtask kicked after enqueue returns).
    const r = svc.enqueue("netflix.com");
    expect(r).toBeUndefined();
    expect(provider).not.toHaveBeenCalled();
  });

  it("drops a non-domain-shaped key (path traversal / dotless) — never queued (SECURITY)", async () => {
    const { services } = makeServices(LOGO_ON);
    const { blobCache, has, write } = makeBlobCache();
    const { getWindow } = makeWindow();
    const provider = okProvider();
    const svc = new EnrichmentService({ services, blobCache, getWindow, provider });
    svc.start();

    for (const bad of ["../../evil", "a/b.com", "acme", "", "   "]) {
      svc.enqueue(bad);
    }
    await svc.drain();

    // Nothing shaped like a domain was queued → the cache was never even probed.
    expect(has).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});

// --- gate closed: silent miss, no cache write, no broadcast ------------------

describe("gate closed (liveLogoFetch off): silent miss, no write, no broadcast", () => {
  it("a NetworkGateError from the provider ends the job silently", async () => {
    const { services } = makeServices(ALL_OFF);
    const { blobCache, write } = makeBlobCache();
    const { getWindow, send } = makeWindow();
    const provider: LogoProvider = vi.fn(async () => {
      throw new NetworkGateError("blocked: t2.gstatic.com");
    });
    const svc = new EnrichmentService({ services, blobCache, getWindow, provider });
    svc.start();

    svc.enqueue("netflix.com");
    await svc.drain();

    expect(provider).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled(); // nothing changed → no broadcast
  });
});

// --- successful fetch → cache write → ONE coalesced broadcast ----------------

describe("successful fetch (fake provider): writes the blob + one coalesced broadcast", () => {
  it("writes the fetched bytes keyed by domain and broadcasts evt:dataChanged once", async () => {
    const { services } = makeServices(LOGO_ON);
    const { blobCache, writes, write } = makeBlobCache();
    const { getWindow, send } = makeWindow();
    const provider = okProvider("image/png");
    const svc = new EnrichmentService({ services, blobCache, getWindow, provider });
    svc.start();

    svc.enqueue("netflix.com");
    await svc.drain();

    expect(write).toHaveBeenCalledTimes(1);
    expect(writes[0].domain).toBe("netflix.com");
    expect(writes[0].contentType).toBe("image/png");
    // The final flush on queue-empty emits exactly one broadcast.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe("evt:dataChanged");
  });

  it("a burst of N completions yields far fewer than N broadcasts (coalesced, AD-8)", async () => {
    const { services } = makeServices(LOGO_ON);
    const { blobCache, write } = makeBlobCache();
    const { getWindow, send } = makeWindow();
    const provider = okProvider();
    const svc = new EnrichmentService({
      services,
      blobCache,
      getWindow,
      provider,
      coalesceMs: 10_000, // a long window: the only broadcast is the final flush
    });
    svc.start();

    for (let i = 0; i < 40; i++) svc.enqueue(`brand${i}.com`);
    await svc.drain();

    expect(write).toHaveBeenCalledTimes(40); // all 40 persisted
    // One broadcast for the whole batch (the drain's final flush), not 40.
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("write() returning false (uncacheable) owes NO broadcast", async () => {
    // A fetch succeeds but the blob cache refuses to persist it (e.g. an
    // uncacheable content-type) → write is called but returns false, so nothing
    // changed and no broadcast is owed.
    const { services } = makeServices(LOGO_ON);
    const { getWindow, send } = makeWindow();
    const provider = okProvider("application/json"); // provider still returns bytes
    const write = vi.fn(async () => false); // cache declines to persist
    const has = vi.fn(async () => false);
    const blobCache = { has, write } as unknown as import(
      "../electron/services/logoBlobCache"
    ).LogoBlobCache;
    const svc = new EnrichmentService({ services, blobCache, getWindow, provider });
    svc.start();

    svc.enqueue("netflix.com");
    await svc.drain();

    expect(write).toHaveBeenCalledTimes(1); // write attempted
    expect(send).not.toHaveBeenCalled(); // but nothing persisted → no broadcast
  });
});

// --- failed fetch: silent, no write, worker moves on -------------------------

describe("failed fetch: no cache write, no toast, worker continues", () => {
  it("a provider throw is caught; the next job still runs", async () => {
    const { services } = makeServices(LOGO_ON);
    const { blobCache, writes, write } = makeBlobCache();
    const { getWindow, send } = makeWindow();
    // First domain throws (transport error); second succeeds.
    const provider: LogoProvider = vi.fn(async (domain: string) => {
      if (domain === "bad.com") throw new Error("network down");
      return { bytes: new Uint8Array([1]), contentType: "image/png" };
    });
    const svc = new EnrichmentService({ services, blobCache, getWindow, provider });
    svc.start();

    svc.enqueue("bad.com");
    svc.enqueue("good.com");
    await svc.drain();

    expect(provider).toHaveBeenCalledTimes(2); // the failure did not halt the loop
    expect(write).toHaveBeenCalledTimes(1); // only the good one wrote
    expect(writes[0].domain).toBe("good.com");
    expect(send).toHaveBeenCalledTimes(1); // one broadcast for the one success
  });
});

// --- already cached: never-refetch -------------------------------------------

describe("already cached: no fetch, no duplicate write (never-refetch)", () => {
  it("skips a domain already present in the blob cache", async () => {
    const { services } = makeServices(LOGO_ON);
    const { blobCache, write, has } = makeBlobCache(["netflix.com"]);
    const { getWindow, send } = makeWindow();
    const provider = okProvider();
    const svc = new EnrichmentService({ services, blobCache, getWindow, provider });
    svc.start();

    svc.enqueue("netflix.com");
    await svc.drain();

    expect(has).toHaveBeenCalledWith("netflix.com");
    expect(provider).not.toHaveBeenCalled(); // never-refetch: no fetch
    expect(write).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled(); // nothing changed → no broadcast
  });
});

// --- serial FIFO ordering, one drain ----------------------------------------

describe("serial ordering: FIFO, one drain not N overlapping (re-entrancy guard)", () => {
  it("processes 3 fast-enqueued jobs one at a time in FIFO order", async () => {
    const { services } = makeServices(LOGO_ON);
    const { blobCache } = makeBlobCache();
    const { getWindow } = makeWindow();

    // Record the order jobs are processed, and assert no two overlap.
    const order: string[] = [];
    let inFlight = 0;
    let maxConcurrent = 0;
    const provider: LogoProvider = vi.fn(async (domain: string) => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      // Yield to the event loop so an overlapping drain would be observable.
      await Promise.resolve();
      order.push(domain);
      inFlight -= 1;
      return { bytes: new Uint8Array([1]), contentType: "image/png" };
    });
    const svc = new EnrichmentService({ services, blobCache, getWindow, provider });
    svc.start();

    svc.enqueue("a.com");
    svc.enqueue("b.com");
    svc.enqueue("c.com");
    await svc.drain();

    expect(order).toEqual(["a.com", "b.com", "c.com"]); // FIFO
    expect(maxConcurrent).toBe(1); // never two jobs at once (serial)
  });

  it("a second drain() while one is in flight is a no-op (single worker)", async () => {
    const { services } = makeServices(LOGO_ON);
    const { blobCache, write } = makeBlobCache();
    const { getWindow } = makeWindow();
    const provider = okProvider();
    const svc = new EnrichmentService({ services, blobCache, getWindow, provider });
    svc.start();

    svc.enqueue("a.com");
    svc.enqueue("b.com");
    // Kick two drains concurrently; the guard means only one loop runs.
    await Promise.all([svc.drain(), svc.drain()]);

    expect(write).toHaveBeenCalledTimes(2); // each domain written exactly once
  });
});

// --- drain only after start (AD-28) ------------------------------------------

describe("drain only after start() (AD-28 launch ordering)", () => {
  it("enqueue before start() does not fetch; start() then drains the backlog", async () => {
    const { services } = makeServices(LOGO_ON);
    const { blobCache, write } = makeBlobCache();
    const { getWindow } = makeWindow();
    const provider = okProvider();
    const svc = new EnrichmentService({ services, blobCache, getWindow, provider });

    // NOT started yet: enqueue must not kick a drain.
    svc.enqueue("netflix.com");
    await Promise.resolve();
    expect(provider).not.toHaveBeenCalled();

    // start() permits draining and processes the backlog.
    svc.start();
    await svc.drain();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("stop() clears the queue and prevents further draining", async () => {
    const { services } = makeServices(LOGO_ON);
    const { blobCache, write } = makeBlobCache();
    const { getWindow, send } = makeWindow();
    const provider = okProvider();
    const svc = new EnrichmentService({ services, blobCache, getWindow, provider });
    svc.start();

    svc.enqueue("netflix.com");
    svc.stop();
    await svc.drain();

    expect(provider).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

// --- FX refresh job (Story 8.6; AD-8/9/23) -----------------------------------

/** A mapped BundledFxSnapshot-shaped value the FX provider returns on success. */
function makeFxSnapshot(asOf = "2026-10-15"): BundledFxSnapshot {
  return {
    schemaVersion: 1,
    asOf,
    base: "EUR",
    attribution: "ECB via Frankfurter.",
    rates: { EUR: "1", USD: "1.1", INR: "92.0" },
  };
}

/**
 * An FX-capable services stub: mutable online toggles + an in-memory FX override
 * read/write that records writes. `readFxOverride` returns the stored override
 * (or a seeded one) so the ≤24h self-gate can be exercised.
 */
function makeFxServices(online: OnlineSettingsV2, seedOverride: FxOverride | null = null) {
  const state = { online, override: seedOverride };
  const getSettings = vi.fn(async () => makeSettings(state.online));
  const readFxOverride = vi.fn(async () => state.override);
  const writeFxOverride = vi.fn(async (o: FxOverride) => {
    state.override = o;
  });
  const services: EnrichmentServices = {
    getSettings,
    readFxOverride,
    writeFxOverride,
  };
  return { services, state, getSettings, readFxOverride, writeFxOverride };
}

/** A fixed wall clock the ≤24h cadence math reads. */
function fixedNow(iso: string): () => Date {
  return () => new Date(iso);
}

describe("FX refresh job (Story 8.6): gate, ≤24h cap, write + one broadcast, degrade", () => {
  const okFxProvider = (asOf = "2026-10-15"): FxProvider =>
    vi.fn(async () => makeFxSnapshot(asOf));

  it("gate OFF (fxRefresh false): no fetch, no override write, no broadcast", async () => {
    const { services, writeFxOverride } = makeFxServices(ALL_OFF);
    const { blobCache } = makeBlobCache();
    const { getWindow, send } = makeWindow();
    const fxProvider = okFxProvider();
    const svc = new EnrichmentService({ services, blobCache, getWindow, fxProvider });
    svc.start();

    await svc.refreshFxNow();

    expect(fxProvider).not.toHaveBeenCalled();
    expect(writeFxOverride).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("success: fetches the whole table, writes the override with fetchedAt, ONE broadcast", async () => {
    const { services, writeFxOverride, state } = makeFxServices(FX_ON);
    const { blobCache } = makeBlobCache();
    const { getWindow, send } = makeWindow();
    const fxProvider = okFxProvider("2026-10-15");
    const svc = new EnrichmentService({
      services,
      blobCache,
      getWindow,
      fxProvider,
      now: fixedNow("2026-10-15T08:00:00.000Z"),
    });
    svc.start();

    await svc.refreshFxNow();

    expect(fxProvider).toHaveBeenCalledTimes(1);
    // The provider was passed the live online toggles (the gate keys off them).
    expect(vi.mocked(fxProvider).mock.calls[0]![0]).toEqual(FX_ON);
    expect(writeFxOverride).toHaveBeenCalledTimes(1);
    expect(state.override).not.toBeNull();
    expect(state.override!.asOf).toBe("2026-10-15");
    expect(state.override!.fetchedAt).toBe("2026-10-15T08:00:00.000Z");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe("evt:dataChanged");
  });

  it("≤24h cap: an override fetched < 24h ago makes the job a NO-OP (no fetch)", async () => {
    const seeded: FxOverride = {
      ...makeFxSnapshot("2026-10-14"),
      fetchedAt: "2026-10-15T06:00:00.000Z", // 2h before `now`
    };
    const { services, writeFxOverride } = makeFxServices(FX_ON, seeded);
    const { blobCache } = makeBlobCache();
    const { getWindow, send } = makeWindow();
    const fxProvider = okFxProvider();
    const svc = new EnrichmentService({
      services,
      blobCache,
      getWindow,
      fxProvider,
      now: fixedNow("2026-10-15T08:00:00.000Z"),
    });
    svc.start();

    await svc.refreshFxNow();

    expect(fxProvider).not.toHaveBeenCalled(); // within 24h → no network
    expect(writeFxOverride).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("after 24h: an override fetched > 24h ago is refreshed (fetch + rewrite)", async () => {
    const seeded: FxOverride = {
      ...makeFxSnapshot("2026-10-10"),
      fetchedAt: "2026-10-13T08:00:00.000Z", // > 24h before `now`
    };
    const { services, writeFxOverride, state } = makeFxServices(FX_ON, seeded);
    const { blobCache } = makeBlobCache();
    const { getWindow, send } = makeWindow();
    const fxProvider = okFxProvider("2026-10-15");
    const svc = new EnrichmentService({
      services,
      blobCache,
      getWindow,
      fxProvider,
      now: fixedNow("2026-10-15T08:00:00.000Z"),
    });
    svc.start();

    await svc.refreshFxNow();

    expect(fxProvider).toHaveBeenCalledTimes(1);
    expect(writeFxOverride).toHaveBeenCalledTimes(1);
    expect(state.override!.asOf).toBe("2026-10-15"); // rewritten with the new table
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a FUTURE fetchedAt (clock skew / edited file) falls through to a refresh (not suppressed)", async () => {
    const seeded: FxOverride = {
      ...makeFxSnapshot("2026-10-14"),
      fetchedAt: "2026-10-20T08:00:00.000Z", // 5 days in the FUTURE vs `now`
    };
    const { services, writeFxOverride } = makeFxServices(FX_ON, seeded);
    const { blobCache } = makeBlobCache();
    const { getWindow } = makeWindow();
    const fxProvider = okFxProvider("2026-10-15");
    const svc = new EnrichmentService({
      services,
      blobCache,
      getWindow,
      fxProvider,
      now: fixedNow("2026-10-15T08:00:00.000Z"),
    });
    svc.start();

    await svc.refreshFxNow();

    // A negative delta is NOT "< 24h in the past" — the lower-bound guard lets the
    // job fall through to a fetch (the safe freshness direction), so an edited/
    // skewed future stamp cannot suppress refresh indefinitely.
    expect(fxProvider).toHaveBeenCalledTimes(1);
    expect(writeFxOverride).toHaveBeenCalledTimes(1);
  });

  it("failed fetch (gate error): keeps the prior override, no write, silent", async () => {
    const seeded: FxOverride = {
      ...makeFxSnapshot("2026-10-10"),
      fetchedAt: "2026-10-13T08:00:00.000Z", // > 24h → the cap does not short-circuit
    };
    const { services, writeFxOverride, state } = makeFxServices(FX_ON, seeded);
    const { blobCache } = makeBlobCache();
    const { getWindow, send } = makeWindow();
    const fxProvider: FxProvider = vi.fn(async () => {
      throw new NetworkGateError("blocked: api.frankfurter.dev");
    });
    const svc = new EnrichmentService({
      services,
      blobCache,
      getWindow,
      fxProvider,
      now: fixedNow("2026-10-15T08:00:00.000Z"),
    });
    svc.start();

    await svc.refreshFxNow();

    expect(fxProvider).toHaveBeenCalledTimes(1);
    expect(writeFxOverride).not.toHaveBeenCalled(); // no override written on failure
    expect(state.override).toBe(seeded); // the last good snapshot stays effective
    expect(send).not.toHaveBeenCalled(); // silent — no toast, no reload
  });

  it("failed fetch (transport error): also keeps the prior override, silent", async () => {
    const { services, writeFxOverride } = makeFxServices(FX_ON);
    const { blobCache } = makeBlobCache();
    const { getWindow, send } = makeWindow();
    const fxProvider: FxProvider = vi.fn(async () => {
      throw new Error("FX refresh failed: HTTP 503");
    });
    const svc = new EnrichmentService({ services, blobCache, getWindow, fxProvider });
    svc.start();

    await svc.refreshFxNow();

    expect(writeFxOverride).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("enqueueFxRefresh before start() is deferred and runs once start() permits it (AD-28)", async () => {
    // A write-signal so the fire-and-forget deferred job can be awaited.
    let resolveWrite!: () => void;
    const written = new Promise<void>((r) => {
      resolveWrite = r;
    });
    const state = { online: FX_ON, override: null as FxOverride | null };
    const getSettings = vi.fn(async () => makeSettings(state.online));
    const readFxOverride = vi.fn(async () => state.override);
    const writeFxOverride = vi.fn(async (o: FxOverride) => {
      state.override = o;
      resolveWrite();
    });
    const services: EnrichmentServices = { getSettings, readFxOverride, writeFxOverride };
    const { blobCache } = makeBlobCache();
    const { getWindow } = makeWindow();
    const fxProvider = okFxProvider();
    const svc = new EnrichmentService({ services, blobCache, getWindow, fxProvider });

    // NOT started: the request must not fetch yet.
    svc.enqueueFxRefresh();
    await Promise.resolve();
    expect(fxProvider).not.toHaveBeenCalled();

    // start() runs the deferred refresh (fire-and-forget); await its write signal.
    svc.start();
    await written;
    expect(fxProvider).toHaveBeenCalledTimes(1);
    expect(writeFxOverride).toHaveBeenCalledTimes(1);
  });

  it("opt-out DURING the override read: no fetch, no write (TOCTOU re-read)", async () => {
    // Regression (PR #2, qodo): the gate was checked BEFORE the awaited
    // readFxOverride(); if the user turned fxRefresh OFF during that await, the
    // stale "on" settings still reached the provider and a request could open after
    // the setting was saved off. The job must RE-READ the toggles immediately before
    // the fetch and skip when now off.
    const state = { online: FX_ON, override: null as FxOverride | null };
    const getSettings = vi.fn(async () => makeSettings(state.online));
    // readFxOverride resolves null (no cadence suppression) AND flips the toggle OFF
    // while its promise is pending — exactly the TOCTOU window.
    const readFxOverride = vi.fn(async () => {
      state.online = ALL_OFF;
      return null;
    });
    const writeFxOverride = vi.fn(async (o: FxOverride) => {
      state.override = o;
    });
    const services: EnrichmentServices = { getSettings, readFxOverride, writeFxOverride };
    const { blobCache } = makeBlobCache();
    const { getWindow, send } = makeWindow();
    const fxProvider = okFxProvider();
    const svc = new EnrichmentService({ services, blobCache, getWindow, fxProvider });
    svc.start();

    await svc.refreshFxNow();

    // The fresh re-read saw fxRefresh=off → the provider is never called, nothing
    // is written, no broadcast — no request opens after the save.
    expect(fxProvider).not.toHaveBeenCalled();
    expect(writeFxOverride).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
