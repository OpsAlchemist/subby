/**
 * FX refresh provider (Story 8.6; the one FX provider, gated).
 *
 * A THIN caller over the 8.1 {@link gateway.get}: it fetches the WHOLE ECB rate
 * table from Frankfurter and maps the response into a {@link BundledFxSnapshot}-
 * shaped value, or throws. It contains NO network primitive of its own — the only
 * `fetch` in the repo stays inside `gateway.ts` (AD-5). Every request runs through
 * the gate, so with `fxRefresh` OFF the gateway refuses before any socket opens (a
 * {@link NetworkGateError}) and the EnrichmentService treats that as a silent miss.
 *
 * Provider of record (AD-23): Frankfurter's ECB path at host
 * `api.frankfurter.dev`, path `/v2/providers/ecb/rates` — the SAME host registered
 * for `fxRefresh` in `net/hosts.ts`, so the gate's allowlist and this URL can
 * never diverge. The request sends NO user-specific query — it pulls the whole
 * table — so it reveals nothing about which currencies or subscriptions the user
 * tracks (the privacy-safe live fetch).
 *
 * Fail stance: a gate refusal, a transport error, a non-ok HTTP status, an empty
 * body, or an unparseable/malformed response all THROW — the EnrichmentService
 * catches every throw, treats a `NetworkGateError` as an ordinary silent miss, and
 * degrades to the last good snapshot (no override write, no toast, no retry). The
 * mapped value is NOT validated here; the StoragePort's loud
 * {@link parseFxOverride} on write is the single rate-validation discipline (a
 * wrong rate is rejected there, degrading to "no override written").
 */

import type { BundledFxSnapshot } from "core/fxSnapshot";
import { FX_SNAPSHOT_SCHEMA_VERSION } from "core/fxSnapshot";
import { knownCurrency } from "core/money";
import type { OnlineSettingsV2 } from "core/models/settings";

import { gateway } from "../gateway";

/**
 * Frankfurter's ECB rates endpoint. The `/v2/providers/ecb/rates` path returns
 * the latest ECB daily reference rates (base EUR), lineage-consistent with the
 * bundled ECB snapshot — the SAME `api.frankfurter.dev` host registered for
 * `fxRefresh` in `net/hosts.ts`.
 */
export const FX_PROVIDER_URL =
  "https://api.frankfurter.dev/v2/providers/ecb/rates";

/** The ECB attribution string stamped onto a refreshed override. */
const ECB_ATTRIBUTION =
  "European Central Bank (ECB) euro foreign exchange reference rates, " +
  "refreshed via Frankfurter (api.frankfurter.dev).";

/** `YYYY-MM-DD` — the shape `parseBundledSnapshot` expects for `asOf`. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Map a raw Frankfurter ECB response into a {@link BundledFxSnapshot}-shaped
 * value. Frankfurter returns `{ base, date, rates }` where `rates` is a
 * `currency → number` map that OMITS the base currency itself (the base is
 * implicit). The bundle shape requires:
 *   - `schemaVersion` — stamped to the single supported version.
 *   - `asOf`          — from the response `date` (`YYYY-MM-DD`).
 *   - `base`          — from the response `base` (ECB → EUR).
 *   - `attribution`   — a fixed ECB/Frankfurter string.
 *   - `rates`         — the response rates as DECIMAL STRINGS, PLUS `base: "1"`
 *                       (the bundle contract requires the base present ↦ 1).
 *
 * Numbers are rendered to decimal strings so the value matches the bundle's
 * string-rate contract; the money/`parseBundledSnapshot` positive-rate validation
 * (run on write via `parseFxOverride`) is the single source of rate validity, so
 * a non-finite / non-positive upstream rate is rejected THERE, degrading to "no
 * override written". This mapper throws only on a structurally unusable response
 * (missing base/date/rates or a non-string base/date).
 */
function mapFrankfurterResponse(raw: unknown): BundledFxSnapshot {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("FX refresh: response is not a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  const base = obj["base"];
  if (typeof base !== "string" || base.trim() === "") {
    throw new Error("FX refresh: response has no usable base currency");
  }

  const date = obj["date"];
  if (typeof date !== "string" || !DATE_RE.test(date)) {
    throw new Error("FX refresh: response has no usable YYYY-MM-DD date");
  }

  const rawRates = obj["rates"];
  if (typeof rawRates !== "object" || rawRates === null || Array.isArray(rawRates)) {
    throw new Error("FX refresh: response has no rates object");
  }

  // Render each numeric rate to a decimal string (the bundle's rate contract),
  // and anchor the base to exactly "1" (Frankfurter omits the base from `rates`).
  const baseCode = base.trim();
  const rates: Record<string, string> = { [baseCode]: "1" };
  for (const [currency, value] of Object.entries(rawRates as Record<string, unknown>)) {
    // Never let a `base` key in the response overwrite the anchored "1".
    if (currency === baseCode) continue;
    // DROP a currency Subby does not model (ECB's reference set may differ from
    // the bundle's). Letting one unmodeled currency reach the loud write-time
    // parser would reject the ENTIRE override — all refreshes would silently fail
    // forever. A known currency with a BAD rate still reaches (and is rejected by)
    // the write-time validation; only unmodeled currencies are skipped here.
    if (!knownCurrency(currency)) continue;
    // Keep raw non-numbers as-is (strings) so the loud write-time parser can
    // reject anything invalid uniformly; numbers become their decimal string.
    rates[currency] =
      typeof value === "number" ? numberToDecimalString(value) : String(value);
  }

  return {
    schemaVersion: FX_SNAPSHOT_SCHEMA_VERSION,
    asOf: date,
    base: base.trim(),
    attribution: ECB_ATTRIBUTION,
    rates,
  };
}

/**
 * Render a finite number to a plain decimal string WITHOUT exponent notation,
 * so a small rate never serializes as `1e-7` (which the bundle's rate regex
 * rejects). A non-finite value is rendered to `"0"` so the loud write-time
 * positive-rate check rejects it (degrading to "no override written") rather than
 * emitting `"NaN"`/`"Infinity"`.
 */
function numberToDecimalString(n: number): string {
  if (!Number.isFinite(n)) return "0";
  // `toFixed(12)` keeps full FX precision as a fixed-point string (no exponent),
  // then trim trailing zeros / a dangling dot for a clean canonical form.
  const fixed = n.toFixed(12);
  return fixed.replace(/\.?0+$/, "") || "0";
}

/**
 * Fetch the WHOLE ECB rate table through the gated gateway and map it into a
 * {@link BundledFxSnapshot}-shaped value.
 *
 * @param online    The live `settings.online` toggles — passed straight to the
 *                  gateway so the gate keys off the current `fxRefresh` state.
 * @param fetchImpl Optional injected network primitive, threaded through the
 *                  gateway for tests. Omitted in production (the gateway's global
 *                  `fetch`, reached only past the gate).
 * @returns the mapped snapshot-shaped value on success (not yet rate-validated —
 *          the StoragePort's loud write-time parse is the single validator).
 * @throws {NetworkGateError} when the gate refuses (toggle off / unregistered
 *                  host) — treated as a silent miss by the caller.
 * @throws Error on a transport failure, a non-ok HTTP status, an empty body, or
 *                  a structurally unusable response.
 */
export async function fetchFxRates(
  online: OnlineSettingsV2,
  fetchImpl?: typeof fetch,
): Promise<BundledFxSnapshot> {
  const response = await gateway.get(FX_PROVIDER_URL, {
    online,
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });

  // The gateway resolves even on a non-ok HTTP status (it only rejects on a
  // transport error / blocked redirect); a 4xx/5xx is NOT a usable table.
  if (!response.ok) {
    throw new Error(`FX refresh failed: HTTP ${response.status}`);
  }

  const raw = (await response.json()) as unknown;
  return mapFrankfurterResponse(raw);
}
