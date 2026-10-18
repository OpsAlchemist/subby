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

import type { OnlineSettingsV2, SettingsV2 } from "core/models/settings";

import { NetworkGateError } from "../net/gateway";
import type { FetchedLogo } from "../net/providers/logoFetcher";
import { fetchLogo } from "../net/providers/logoFetcher";
import type { GetWindow } from "../ipc/handlers";
import { CH } from "../ipc/channels";
import type { LogoBlobCache } from "./logoBlobCache";
import { normalizeDomainKey } from "./logoBlobCache";

/**
 * The subset of app services the enrichment worker needs: the live online
 * toggles (read per job so the gate always keys off the current state). Matches
 * `AppServices` structurally, so the production context passes directly while
 * tests supply a tiny stub.
 */
export interface EnrichmentServices {
  /** Read the persisted settings (re-read per job so the gate sees current toggles). */
  getSettings(): Promise<SettingsV2>;
}

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
  /** Injectable network primitive, threaded through the provider to the gateway (tests). */
  fetchImpl?: typeof fetch;
  /** Coalesce window in ms. Defaults to {@link DEFAULT_COALESCE_MS}. */
  coalesceMs?: number;
  /** Injectable wall clock (unused today; reserved for parity with the Scheduler). */
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
  private readonly fetchImpl?: typeof fetch;
  private readonly coalesceMs: number;

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

  constructor(opts: EnrichmentOptions) {
    this.services = opts.services;
    this.blobCache = opts.blobCache;
    this.getWindow = opts.getWindow;
    this.provider = opts.provider ?? fetchLogo;
    this.fetchImpl = opts.fetchImpl;
    this.coalesceMs = opts.coalesceMs ?? DEFAULT_COALESCE_MS;
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
