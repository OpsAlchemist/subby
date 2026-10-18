import { describe, it, expect, vi } from "vitest";

import type { OnlineSettingsV2 } from "core/models/settings";

import { FEATURE_HOSTS } from "../../electron/net/hosts";
import { NetworkGateError } from "../../electron/net/gateway";
import { fetchFxRates, FX_PROVIDER_URL } from "../../electron/net/providers/fxFetcher";

/**
 * FX refresh provider (Story 8.6; the one FX provider, gated).
 *
 * The provider is a THIN caller over the gated `gateway.get` that maps
 * Frankfurter's ECB response into a `BundledFxSnapshot`-shaped value. These tests
 * pin (a) that `FX_PROVIDER_URL` targets the SAME host registered for `fxRefresh`
 * (a wrong host would silently gate-refuse every real refresh), (b) the mapping
 * (schema stamp, `date`→`asOf`, base anchored to "1", NON-exponent decimal
 * strings, unknown-currency DROP, base-key skip), and (c) the non-ok / empty /
 * structurally-unusable throws — all driven with an injected `fetchImpl` spy so no
 * real socket opens (mirror `tests/net/logoFetcher.test.ts`).
 */

const FX_ON: OnlineSettingsV2 = { liveLogoFetch: false, fxRefresh: true };

/** A canned Frankfurter ECB body wrapped in an ok JSON Response. */
function okResponse(body: unknown): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

describe("FX_PROVIDER_URL: targets the registered fxRefresh host", () => {
  it("resolves to FEATURE_HOSTS.fxRefresh over https (a wrong host would gate-refuse every refresh)", () => {
    const parsed = new URL(FX_PROVIDER_URL);
    expect(parsed.hostname).toBe(FEATURE_HOSTS.fxRefresh);
    expect(parsed.protocol).toBe("https:");
    expect(parsed.pathname).toBe("/v2/providers/ecb/rates");
  });
});

describe("fetchFxRates: maps the Frankfurter ECB response", () => {
  it("stamps schemaVersion, maps date→asOf, anchors base to '1', renders decimal strings", async () => {
    const fetchImpl = okResponse({
      base: "EUR",
      date: "2026-10-15",
      rates: { USD: 1.1, JPY: 170, INR: 92.0, TINY: 0.0000123 },
    });

    const snap = await fetchFxRates(FX_ON, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(snap.schemaVersion).toBe(1);
    expect(snap.asOf).toBe("2026-10-15");
    expect(snap.base).toBe("EUR");
    // Base anchored to exactly "1" (Frankfurter omits the base from `rates`).
    expect(snap.rates.EUR).toBe("1");
    // A whole-number rate renders as a plain decimal string.
    expect(snap.rates.JPY).toBe("170");
    expect(snap.rates.USD).toBe("1.1");
  });

  it("renders a very small rate as a NON-exponent decimal string (no 'e')", async () => {
    // "TINY" is not a real currency; use a known small-rate currency instead so it
    // survives the drop. Assert the number→string rendering has no exponent.
    const fetchImpl = okResponse({
      base: "EUR",
      date: "2026-10-15",
      rates: { USD: 0.0000123 },
    });
    const snap = await fetchFxRates(FX_ON, fetchImpl);
    expect(snap.rates.USD).not.toMatch(/e/i);
    expect(Number(snap.rates.USD)).toBeCloseTo(0.0000123, 10);
  });

  it("DROPS an unknown currency key so one unmodeled currency cannot reject the whole override", async () => {
    const fetchImpl = okResponse({
      base: "EUR",
      date: "2026-10-15",
      rates: { USD: 1.1, XYZ: 2.2 },
    });
    const snap = await fetchFxRates(FX_ON, fetchImpl);
    expect(snap.rates.USD).toBe("1.1");
    expect("XYZ" in snap.rates).toBe(false); // dropped (not modeled by Subby)
  });

  it("skips a `base` key in rates so it never overwrites the anchored '1'", async () => {
    const fetchImpl = okResponse({
      base: "EUR",
      date: "2026-10-15",
      rates: { EUR: 999, USD: 1.1 }, // a stray EUR must NOT overwrite "1"
    });
    const snap = await fetchFxRates(FX_ON, fetchImpl);
    expect(snap.rates.EUR).toBe("1");
  });

  it("rejects on a non-ok HTTP status", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("nope", { status: 503 }),
    ) as unknown as typeof fetch;
    await expect(fetchFxRates(FX_ON, fetchImpl)).rejects.toThrow(/HTTP 503/);
  });

  it("rejects a structurally-unusable body (missing base / date / rates)", async () => {
    await expect(fetchFxRates(FX_ON, okResponse({ date: "2026-10-15", rates: {} }))).rejects.toThrow(
      /base/,
    );
    await expect(fetchFxRates(FX_ON, okResponse({ base: "EUR", rates: {} }))).rejects.toThrow(
      /date/,
    );
    await expect(fetchFxRates(FX_ON, okResponse({ base: "EUR", date: "2026-10-15" }))).rejects.toThrow(
      /rates/,
    );
  });

  it("rejects an empty/invalid-JSON body", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("", { status: 200, headers: { "content-type": "application/json" } }),
    ) as unknown as typeof fetch;
    await expect(fetchFxRates(FX_ON, fetchImpl)).rejects.toThrow();
  });

  it("gate-refuses (NetworkGateError) when fxRefresh is off — no socket", async () => {
    const fetchImpl = okResponse({ base: "EUR", date: "2026-10-15", rates: { USD: 1.1 } });
    await expect(
      fetchFxRates({ liveLogoFetch: false, fxRefresh: false }, fetchImpl),
    ).rejects.toBeInstanceOf(NetworkGateError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
