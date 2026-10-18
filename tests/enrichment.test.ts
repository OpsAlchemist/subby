import { afterEach, describe, expect, it, vi } from "vitest";

import { EnrichmentService } from "../electron/services/enrichment";
import type {
  EnrichmentServices,
  LogoProvider,
} from "../electron/services/enrichment";
import { NetworkGateError } from "../electron/net/gateway";
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
