/**
 * Enrichment service (Electron MAIN process; Story 8.4 — AD-8, AD-9, AD-28).
 *
 * The one serial, in-process enrichment pipeline. `enrich:enqueue` returns
 * immediately (the UI never awaits a fetch — AD-9); a SINGLE serial FIFO worker
 * processes one domain at a time (the only throttle/ordering point), fetching
 * through the 8.1 gateway, persisting the bytes to the `logos/` blob cache, and
 * broadcasting a COALESCED `evt:dataChanged` so the renderer refreshes through
 * its existing `onDataChanged` path — NO new result-push channel (AD-8).
 *
 * Deliberate shape, mirrored on the Scheduler (`scheduler.ts`):
 *  - Injectable seams (`services`, `provider`, `blobCache`, `getWindow`, `now`,
 *    `coalesceMs`, `fetchImpl`) so tests run with fakes and fake timers.
 *  - A `draining` re-entrancy guard (the Scheduler's `evaluating` flag) so a
 *    burst of `enqueue`s produces ONE drain loop, not N overlapping ones.
 *  - Degrade-on-fault (AD-28): every provider/cache throw inside the loop is
 *    caught and logged as a LOCAL non-telemetry diagnostic; a `NetworkGateError`
 *    (the gate-closed path) is an ORDINARY silent miss, not even logged as a
 *    fault. The worker never throws into the event loop, never retries, never
 *    toasts.
 *  - `start()`/`stop()`: the queue drains only AFTER `start()` is called, which
 *    `main.ts` defers until the migration barrier has passed AND the window is
 *    `ready-to-show` (AD-28). `stop()` clears the pending debounce/timer.
 *
 * Never-refetch (AD-8): a domain already in the blob cache is skipped — no
 * fetch, no duplicate write. The gate-closed path (`liveLogoFetch` off) is fully
 * exercisable this story: enqueue → gateway refuses → silent miss → fallback.
 * The renderer auto-enqueue trigger and the live toggle arrive in Story 8.5.
 */

import type { BundledFxSnapshot, FxOverride } from "core/fxSnapshot";
import { domainFromWebsite } from "core/logo";
import type { OnlineSettingsV2, SettingsV2 } from "core/models/settings";

import { NetworkGateError } from "../net/gateway";
import type { FetchedLogo } from "../net/providers/logoFetcher";
import { fetchLogo } from "../net/providers/logoFetcher";
import { fetchFxRates } from "../net/providers/fxFetcher";
import type { GetWindow } from "../ipc/handlers";
import { CH } from "../ipc/channels";
import type { LogoBlobCache } from "./logoBlobCache";
import { normalizeDomainKey } from "./logoBlobCache";

/**
 * The subset of app services the enrichment worker needs: the live online
 * toggles (read per job so the gate always keys off the current state) and, for
 * the FX refresh job (Story 8.6), the atomic FX-override read/write (through the
 * StoragePort, AD-23 — the EnrichmentService is the SOLE writer). The production
 * context supplies these from the assembled services + storage; tests supply a
 * tiny stub.
 */
export interface EnrichmentServices {
  /** Read the persisted settings (re-read per job so the gate sees current toggles). */
  getSettings(): Promise<SettingsV2>;
  /**
   * Read the current FX override (Story 8.6) — for the ≤24h self-gate on
   * `fetchedAt`. Degrades a missing/corrupt override to `null`. OPTIONAL so a
   * logo-only test stub need not implement it; the FX job no-ops without it.
   */
  readFxOverride?(): Promise<FxOverride | null>;
  /**
   * Write the FX override atomically through the port (Story 8.6, AD-23). The
   * EnrichmentService is the SOLE writer. OPTIONAL (see {@link readFxOverride}).
   */
  writeFxOverride?(override: FxOverride): Promise<void>;
  /**
   * Read all subscriptions as a lock-free snapshot (Story 9.1) — the source for
   * {@link EnrichmentService.backfillAllLogos}, which maps each `website` to a
   * registrable domain and enqueues it. OPTIONAL so a logo-only test stub need
   * not implement it; {@link EnrichmentService.backfillAllLogos} no-ops without it.
   */
  listSubscriptions?(): Promise<{ website: string }[]>;
}

/**
 * The FX provider seam: fetch the WHOLE ECB table through the gateway (gated by
 * `online`), or throw. Matches {@link fetchFxRates}; injectable so a test supplies
 * a fake returning a fixed table or a controlled throw without any real socket.
 */
export type FxProvider = (
  online: OnlineSettingsV2,
  fetchImpl?: typeof fetch,
) => Promise<BundledFxSnapshot>;

/**
 * The FX refresh network CAP (FR-28 "at most daily"): a successful fetch within
 * this window makes the next FX job a no-op (no socket). It is a CAP, not a
 * guarantee — a continuously-open session is NOT forced to refresh (out of scope).
 */
export const FX_REFRESH_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * The logo provider seam: fetch bytes+content-type for a domain through the
 * gateway (gated by `online`), or throw. Matches {@link fetchLogo}; injectable so
 * a test supplies a fake returning fixed bytes or a controlled throw without any
 * real socket.
 */
export type LogoProvider = (
  domain: string,
  online: OnlineSettingsV2,
  fetchImpl?: typeof fetch,
) => Promise<FetchedLogo>;

/** Default coalesce window: a burst of completions emits at most one broadcast per 250ms. */
export const DEFAULT_COALESCE_MS = 250;

/** Construction options for {@link EnrichmentService}. */
export interface EnrichmentOptions {
  /** Reads the live settings (the online toggles) per job. */
  services: EnrichmentServices;
  /** The logo blob cache helper (never-refetch `has`, atomic `write`). */
  blobCache: LogoBlobCache;
  /** Accessor for the renderer window used to broadcast `evt:dataChanged`. */
  getWindow: GetWindow;
  /** The logo provider. Defaults to the real gated {@link fetchLogo}; tests inject a fake. */
  provider?: LogoProvider;
  /** The FX provider (Story 8.6). Defaults to the real gated {@link fetchFxRates}; tests inject a fake. */
  fxProvider?: FxProvider;
  /** Injectable network primitive, threaded through the provider to the gateway (tests). */
  fetchImpl?: typeof fetch;
  /** Coalesce window in ms. Defaults to {@link DEFAULT_COALESCE_MS}. */
  coalesceMs?: number;
  /** Injectable wall clock. Used by the FX refresh ≤24h cadence (Story 8.6); defaults to `() => new Date()`. */
  now?: () => Date;
}

/**
 * The serial logo-enrichment worker. Construct with injected seams, call
 * {@link start} to permit draining (post-barrier + `ready-to-show`), and
 * {@link stop} on quit. {@link enqueue} is the production entry (fire-and-forget);
 * {@link drain} is public so tests can await the worker deterministically.
 */
export class EnrichmentService {
  private readonly services: EnrichmentServices;
  private readonly blobCache: LogoBlobCache;
  private readonly getWindow: GetWindow;
  private readonly provider: LogoProvider;
  private readonly fxProvider: FxProvider;
  private readonly fetchImpl?: typeof fetch;
  private readonly coalesceMs: number;
  private readonly now: () => Date;

  /**
   * Guards against overlapping FX refresh jobs (Story 8.6). A second
   * {@link enqueueFxRefresh} while one is in flight is a no-op — the single serial
   * FX job, mirroring the logo queue's single-worker discipline. The ≤24h cap on
   * `fetchedAt` is the real throttle; this just prevents a launch + toggle-flip
   * double-trigger from racing two fetches at once.
   */
  private fxRefreshInFlight = false;

  /** FIFO queue of registrable domains awaiting a fetch. */
  private readonly queue: string[] = [];

  /**
   * The in-flight drain loop, or null when idle. Doubles as the re-entrancy
   * guard (mirror Scheduler.evaluating) AND lets a concurrent {@link drain} call
   * await the SAME batch rather than returning a prematurely-resolved no-op — so
   * `await drain()` reliably resolves after the batch (and the final broadcast).
   */
  private activeDrain: Promise<void> | null = null;

  /** Set once {@link start} is called; the worker refuses to drain before it (AD-28). */
  private started = false;

  /** Set by {@link stop}; a stopped service never starts a new drain or broadcast. */
  private stopped = false;

  /** Pending coalesced-broadcast timer, or null when none is scheduled. */
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;

  /** True when ≥1 completion occurred since the last broadcast (a broadcast is owed). */
  private broadcastPending = false;

  /**
   * True when an FX refresh was requested before {@link start} permitted draining
   * (AD-28) — e.g. the launch trigger fires before `ready-to-show`. {@link start}
   * consumes it so the refresh runs once the barrier has passed, never earlier.
   */
  private fxRefreshRequested = false;

  /**
   * The `force` intent carried by a deferred FX refresh request (Story 9.2). An
   * explicit Sync Now ({@link enqueueFxRefresh}`({ force: true })`) that lands
   * before {@link start} must still carry its force intent when {@link start}
   * replays it — so Sync Now at launch is not silently demoted to a capped
   * automatic refresh. Latches to `true` if ANY pending request forced; reset by
   * {@link start} and {@link stop}. The cap-bypass itself is Story 9.3 — here the
   * flag is only threaded through.
   */
  private fxRefreshRequestedForce = false;

  constructor(opts: EnrichmentOptions) {
    this.services = opts.services;
    this.blobCache = opts.blobCache;
    this.getWindow = opts.getWindow;
    this.provider = opts.provider ?? fetchLogo;
    this.fxProvider = opts.fxProvider ?? fetchFxRates;
    this.fetchImpl = opts.fetchImpl;
    this.coalesceMs = opts.coalesceMs ?? DEFAULT_COALESCE_MS;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Permit draining and kick the worker if anything is already queued. Called by
   * `main.ts` only AFTER the migration barrier AND window `ready-to-show`
   * (AD-28), so a job can never run against un-migrated state or before paint.
   * Idempotent.
   */
  start(): void {
    if (this.stopped) return;
    this.started = true;
    if (this.queue.length > 0) void this.drain();
    // Run a deferred FX refresh that was requested before the start gate (AD-28,
    // e.g. the launch-with-toggle-on trigger fired before `ready-to-show`).
    // Carry through the `force` intent (Story 9.2) so a Sync Now that fired before
    // `ready-to-show` is not demoted to a capped automatic refresh.
    if (this.fxRefreshRequested) {
      this.fxRefreshRequested = false;
      const force = this.fxRefreshRequestedForce;
      this.fxRefreshRequestedForce = false;
      void this.runFxRefresh(force);
    }
  }

  /**
   * Stop the worker: clear the pending coalesced-broadcast timer and mark the
   * service stopped so no new drain or broadcast is scheduled. Idempotent; called
   * on `app.on("quit")`. An in-flight `drain` iteration sees `stopped` on its next
   * loop check and exits.
   */
  stop(): void {
    this.stopped = true;
    this.started = false;
    if (this.broadcastTimer !== null) {
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    this.broadcastPending = false;
    this.fxRefreshRequested = false;
    this.fxRefreshRequestedForce = false;
    // Drop any queued-but-unprocessed domains so a restart does not replay them.
    this.queue.length = 0;
  }

  /**
   * Enqueue a domain for enrichment and return IMMEDIATELY (AD-9). The caller
   * (the IPC handler) never awaits the fetch. A domain already pending in the
   * queue is not re-queued (cheap de-dup of the obvious burst case; the blob
   * cache's `has` is the authoritative never-refetch gate per job). The drain is
   * kicked only once {@link start} has permitted it.
   *
   * The domain is normalized + shape-validated through the SAME
   * {@link normalizeDomainKey} the blob cache uses (fail-closed SECURITY gate):
   * a renderer-supplied value that is not a plain registrable domain (e.g. a
   * `../`-style path-traversal key) is DROPPED — never queued, never a filename.
   */
  enqueue(domain: string): void {
    if (this.stopped) return;
    const normalized = normalizeDomainKey(domain);
    if (normalized === null) return; // non-domain-shaped → drop (never queue)
    if (this.queue.includes(normalized)) return;
    this.queue.push(normalized);
    if (this.started) void this.drain();
  }

  /**
   * Backfill logos for ALL currently-tracked subscriptions (Story 9.1). Reads the
   * full subscription list, maps each free-text `website` to a registrable domain
   * via {@link domainFromWebsite} (a `null`/unparseable domain is skipped), and
   * feeds each non-null one through the EXISTING {@link enqueue} path — which
   * de-dups, shape-gates via `normalizeDomainKey`, and leaves the worker's
   * never-refetch `has()` + the gateway gate as the authorities (so a bundled or
   * already-cached domain fetches nothing). It adds NO fetch/throttle/queue of its
   * own; it just populates the single serial queue (AD-8).
   *
   * Called fire-and-forget from the `main.ts` `onSettingsMutated` hook when
   * `liveLogoFetch` is on (the caller is the gate; the worker/gateway are the
   * backstop). Safe before OR after {@link start} — {@link enqueue} already defers
   * the drain until started (AD-28). A missing `listSubscriptions` dep (a logo-only
   * test stub) makes this a no-op. Degrade-on-fault (AD-28): a `listSubscriptions`
   * read throw is caught and swallowed — the backfill never crashes the event loop.
   */
  async backfillAllLogos(): Promise<void> {
    if (this.stopped) return;
    const listSubscriptions = this.services.listSubscriptions?.bind(
      this.services,
    );
    if (listSubscriptions === undefined) return; // no subs source → no-op
    try {
      const subs = await listSubscriptions();
      for (const sub of subs) {
        const domain = domainFromWebsite(sub.website);
        if (domain !== null) this.enqueue(domain); // de-dup + has() do the rest
      }
    } catch (err) {
      // DEGRADE, never propagate (AD-28). A failed subs read must not crash the
      // event loop; a local non-telemetry diagnostic is enough.
      console.error(
        `[subby] logo backfill degraded (caught, not thrown): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Request an FX rate refresh and return IMMEDIATELY (AD-9; Story 8.6). The two
   * AUTOMATIC triggers (`main.ts` at launch when `fxRefresh` is on, and the
   * `onSettingsMutated` hook when the toggle flips on) call this un-forced — NO
   * second timer subsystem. The on-demand "Sync Now" control (Story 9.2) calls it
   * with `{ force: true }`. Fire-and-forget: the caller never awaits the fetch.
   *
   *   - A `stop()`ped service is a no-op.
   *   - Before {@link start} has permitted draining (AD-28), the request is
   *     REMEMBERED (carrying its `force` intent) and run by `start()` (so a launch
   *     or Sync-Now trigger that fires before `ready-to-show` still refreshes once,
   *     after the barrier).
   *   - Once started, the FX job runs now (fire-and-forget).
   *
   * The job itself self-gates on the `fxRefresh` toggle AND (when NOT forced) the
   * ≤24h cadence ({@link FX_REFRESH_MIN_INTERVAL_MS}), so an automatic trigger hits
   * the network ≤1×/24h (FR-28 is a CAP for AUTOMATIC refreshes). A forced refresh
   * (Story 9.3) bypasses ONLY that cadence self-gate in {@link runFxRefresh} — the
   * toggle gate and the TOCTOU re-read still apply — so Sync Now defeats the rate
   * cap, never the privacy gate. Returns `void` synchronously — the public
   * {@link refreshFxNow} is the awaitable variant tests use.
   *
   * @param opts.force when `true`, requests a cap-bypass refresh (Sync Now). The
   *                   automatic callers omit it (default `false`), so they stay
   *                   capped. Shape kept coherent with {@link refreshFxNow} /
   *                   {@link runFxRefresh} across Stories 9.2/9.3.
   */
  enqueueFxRefresh(opts: { force?: boolean } = {}): void {
    if (this.stopped) return;
    const force = opts.force ?? false;
    if (!this.started) {
      // Defer until the start gate (AD-28). `start()` consumes the flags. Latch the
      // force intent so a pending Sync Now is not demoted to a capped refresh.
      this.fxRefreshRequested = true;
      if (force) this.fxRefreshRequestedForce = true;
      return;
    }
    void this.runFxRefresh(force);
  }

  /**
   * Run ONE FX refresh and await it (public so tests drive the worker
   * deterministically). Production uses the fire-and-forget {@link enqueueFxRefresh};
   * this is the same job, awaitable. A no-op before {@link start} / after
   * {@link stop}.
   *
   * @param force threaded through to {@link runFxRefresh}; when `true` it bypasses
   *              ONLY the ≤24h cadence self-gate (Story 9.3). Defaults to `false` so
   *              existing callers (and the automatic triggers) stay capped.
   */
  async refreshFxNow(force = false): Promise<void> {
    if (!this.started || this.stopped) return;
    await this.runFxRefresh(force);
  }

  /**
   * The FX refresh job (Story 8.6; AD-8/9/23). Gated and self-throttled; NEVER
   * throws into the event loop (AD-28). Order:
   *   1. in-flight guard — one FX job at a time (a launch + toggle-flip double
   *      trigger does not race two fetches).
   *   2. GATE on `settings.online.fxRefresh` — off → no-op (no fetch, no socket;
   *      the gateway would also refuse, but short-circuiting here avoids the throw).
   *   3. ≤24h SELF-GATE — read the current override's `fetchedAt`; if a successful
   *      fetch happened within {@link FX_REFRESH_MIN_INTERVAL_MS}, no-op (the CAP).
   *   4. FETCH the whole ECB table through the gated provider; a `NetworkGateError`
   *      or any transport/parse error is a SILENT miss (no override written, prior
   *      override/bundle stays effective).
   *   5. WRITE the override atomically (loud rate-validate on write; a bad rate
   *      throws and is caught here as a silent miss — "no override written") with
   *      `fetchedAt = now()`.
   *   6. BROADCAST a single coalesced `evt:dataChanged` so the renderer reloads and
   *      re-queries `getFxSnapshot` (newer `asOf` swaps in) — the SAME path logos use.
   *
   * @param force the on-demand "Sync Now" path (Stories 9.2/9.3). When `true`, the
   *              ≤24h cadence SELF-GATE (step 3) is SKIPPED so an explicit user
   *              action is never silently suppressed within 24h — a fresh table is
   *              re-fetched and a new override written. The bypass is NARROW: it
   *              defeats ONLY the rate cap, never the privacy toggle gate (step 2),
   *              the pre-provider TOCTOU re-read, the in-flight guard, or the
   *              write-time rate validation — those protect the user and survive a
   *              force. The automatic callers pass `false` and stay capped at
   *              ≤1×/24h (FR-28 is a CAP for AUTOMATIC refreshes only).
   */
  private async runFxRefresh(force = false): Promise<void> {
    if (this.fxRefreshInFlight || this.stopped) return;
    // The FX override read/write seams are optional (a logo-only stub omits them);
    // without them the FX job cannot run.
    const readOverride = this.services.readFxOverride?.bind(this.services);
    const writeOverride = this.services.writeFxOverride?.bind(this.services);
    if (readOverride === undefined || writeOverride === undefined) return;

    this.fxRefreshInFlight = true;
    try {
      // (2) Gate: the toggle must be ON. Read fresh per job so a flip is honored.
      const settings = await this.services.getSettings();
      if (!settings.online.fxRefresh) return;

      // (3) ≤24h self-gate on the LAST successful fetch instant (`fetchedAt`).
      // Story 9.3: a FORCED refresh (Sync Now) bypasses ONLY this cadence self-gate
      // so an explicit user action is never silently suppressed within 24h. The
      // bypass is deliberately narrow — the toggle gate (step 2), the pre-provider
      // TOCTOU re-read, the in-flight guard, and the write-time rate validation all
      // still apply under force. Automatic callers pass `force=false` and stay
      // capped at ≤1×/24h (FR-28, AD-23).
      const existing = await readOverride();
      if (!force && existing !== null) {
        const lastFetchedMs = Date.parse(existing.fetchedAt);
        const delta = this.now().getTime() - lastFetchedMs;
        // The no-op applies ONLY to a stamp in the PAST within the window
        // (`0 <= delta < 24h`). A FUTURE stamp (clock skew / an edited file) makes
        // `delta` negative; without the lower bound that would always read as
        // "< 24h" and suppress refresh indefinitely — so a future/out-of-range
        // stamp falls through to a fetch (the safe freshness direction).
        if (
          Number.isFinite(lastFetchedMs) &&
          delta >= 0 &&
          delta < FX_REFRESH_MIN_INTERVAL_MS
        ) {
          return; // fetched within 24h → no network (the CAP)
        }
      }

      // (4) Fetch the whole table through the gated provider. RE-READ the toggles
      // immediately before the fetch: the gate check in (2) happened before the
      // awaited `readOverride()`, so the user may have turned `fxRefresh` OFF during
      // that await. Pass the FRESH toggles (and bail if now off) so a request can
      // never open after the setting was saved as off — the gateway is also keyed
      // off these same toggles, so a stale "on" here would otherwise still fetch.
      // A NetworkGateError (toggle off / unregistered host) or any transport/parse
      // error is a silent miss — nothing written, prior snapshot stays effective.
      const online = (await this.services.getSettings()).online;
      if (!online.fxRefresh) return;
      const snapshot = await this.fxProvider(online, this.fetchImpl);

      // A stop() (quit) that landed while fetching halts the write/broadcast.
      if (this.stopped) return;

      // (5) Write the override atomically with the current wall-clock `fetchedAt`.
      // The port's write-time parse validates rates LOUDLY; a bad rate throws here
      // and is caught below as a silent miss (no override written).
      const override: FxOverride = {
        ...snapshot,
        fetchedAt: this.now().toISOString(),
      };
      await writeOverride(override);

      // (6) One coalesced broadcast so the renderer swaps in the newer rates via
      // the existing evt:dataChanged → store-reload → getFxSnapshot path (AD-8).
      this.scheduleBroadcast();
      this.flushBroadcast();
    } catch (err) {
      // DEGRADE, never propagate (AD-28). A NetworkGateError is the ordinary
      // gate-closed/off-toggle miss — nothing changed, nothing to log loudly. Any
      // other fault (transport, non-ok status, parse, write-validate) is a local
      // non-telemetry diagnostic; the prior snapshot stays effective.
      if (!(err instanceof NetworkGateError)) {
        console.error(
          `[subby] FX refresh degraded (caught, not thrown): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } finally {
      this.fxRefreshInFlight = false;
    }
  }

  /**
   * Drain the FIFO queue one job at a time. Public so tests can await the worker.
   *
   * The `draining` guard makes concurrent calls a no-op (the single serial
   * worker — a burst of enqueues yields ONE loop, AD-8). Each iteration:
   *   1. shift the next domain,
   *   2. read the live online toggles (so the gate keys off current state),
   *   3. skip if already cached (never-refetch),
   *   4. fetch through the gated provider; a `NetworkGateError` is a silent miss,
   *   5. write the blob atomically and mark a broadcast owed,
   *   6. catch EVERY throw (degrade, never propagate — AD-28).
   * When the queue empties, flush a final COALESCED broadcast so a batch yields
   * exactly one `evt:dataChanged` for tests and real users alike.
   */
  async drain(): Promise<void> {
    // Re-entrant: a concurrent call awaits the SAME in-flight batch (single
    // serial worker — AD-8) rather than starting a second loop.
    if (this.activeDrain !== null) return this.activeDrain;
    if (!this.started || this.stopped) return;
    const run = this.runDrain();
    this.activeDrain = run;
    try {
      await run;
    } finally {
      this.activeDrain = null;
    }
  }

  /** The actual drain loop; wrapped by {@link drain}'s re-entrancy guard. */
  private async runDrain(): Promise<void> {
    try {
      while (this.queue.length > 0 && !this.stopped) {
        const domain = this.queue.shift() as string;
        try {
          await this.processOne(domain);
        } catch (err) {
          // DEGRADE, never propagate (AD-28). A NetworkGateError is the ordinary
          // gate-closed/off-toggle miss — nothing changed, nothing to log loudly.
          // Any other fault (transport, non-ok status, cache write failure) is a
          // local non-telemetry diagnostic; the worker moves on to the next job.
          if (!(err instanceof NetworkGateError)) {
            console.error(
              `[subby] enrichment job degraded for "${domain}" (caught, not thrown): ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      }
    } finally {
      // The batch is done: flush the coalesced broadcast so the renderer reloads
      // the cache store exactly once for the whole batch.
      this.flushBroadcast();
    }
  }

  /**
   * Process one domain: never-refetch gate → gated fetch → atomic cache write →
   * mark a broadcast owed. Any throw propagates to {@link drain}'s per-job catch.
   */
  private async processOne(domain: string): Promise<void> {
    // Never-refetch (AD-8): a domain already on disk is skipped — no fetch, no
    // duplicate write.
    if (await this.blobCache.has(domain)) return;

    // A `stop()` (quit) that landed while this job was awaiting the `has` check
    // halts it BEFORE touching the network — no socket after a quit is requested.
    if (this.stopped) return;

    // Read the live toggles per job so the gate decision reflects the current
    // state (a toggle flipped between enqueue and drain is honored).
    const settings = await this.services.getSettings();

    // Fetch through the gated provider. With `liveLogoFetch` off the gateway
    // throws NetworkGateError BEFORE any socket — caught in drain as a silent
    // miss (nothing cached, no broadcast owed for this job).
    const { bytes, contentType } = await this.provider(
      domain,
      settings.online,
      this.fetchImpl,
    );

    // Persist atomically. `write` returns false for an uncacheable content-type
    // (dropped silently); only a real write owes a broadcast.
    const written = await this.blobCache.write(domain, bytes, contentType);
    if (written) this.scheduleBroadcast();
  }

  /**
   * Mark a broadcast owed and (re)arm the coalesce timer. A burst of N
   * completions within `coalesceMs` collapses to a SINGLE timer-driven broadcast
   * (AD-8): the timer is armed once and left running (not reset per completion),
   * so it fires at most once per window regardless of how many jobs land in it.
   * `drain` also flushes a final broadcast when the queue empties, so a batch
   * that completes faster than the window still yields exactly one broadcast.
   */
  private scheduleBroadcast(): void {
    if (this.stopped) return;
    this.broadcastPending = true;
    if (this.broadcastTimer === null) {
      this.broadcastTimer = setTimeout(() => {
        this.broadcastTimer = null;
        this.flushBroadcast();
      }, this.coalesceMs);
      // Don't let the coalesce timer keep a headless/test event loop alive.
      this.broadcastTimer.unref?.();
    }
  }

  /**
   * Emit a single `evt:dataChanged` IF one is owed, then clear the pending flag
   * and timer. Reuses the SAME `getWindow` accessor the IPC handlers use — no new
   * result-push channel (AD-8). A broadcast with no owed completion is a no-op
   * (nothing changed → no needless renderer reload).
   */
  private flushBroadcast(): void {
    if (this.broadcastTimer !== null) {
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    if (!this.broadcastPending || this.stopped) {
      this.broadcastPending = false;
      return;
    }
    this.broadcastPending = false;
    const win = this.getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(CH.events.dataChanged);
    }
  }
}
