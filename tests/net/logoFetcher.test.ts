import { describe, it, expect, vi } from "vitest";

import type { OnlineSettingsV2 } from "core/models/settings";

import { FEATURE_HOSTS } from "../../electron/net/hosts";
import { NetworkGateError } from "../../electron/net/gateway";
import { fetchLogo, logoProviderUrl } from "../../electron/net/providers/logoFetcher";

/**
 * Logo fetch provider (Story 8.4; the one logo provider, gated).
 *
 * The provider is a THIN caller over the gated `gateway.get`. These tests pin
 * (a) that `logoProviderUrl` targets the SAME host registered for
 * `liveLogoFetch` (a wrong host would silently gate-refuse every real fetch in
 * 8.5) and carries the queried domain, and (b) the non-ok / empty-body guards in
 * `fetchLogo`, driven with an injected `fetchImpl` spy so no real socket opens
 * (mirror `tests/net/gateway.test.ts`).
 */

const LOGO_ON: OnlineSettingsV2 = { liveLogoFetch: true, fxRefresh: false };

describe("logoProviderUrl: targets the registered liveLogoFetch host", () => {
  it("resolves to FEATURE_HOSTS.liveLogoFetch and carries the queried domain", () => {
    const url = logoProviderUrl("netflix.com");
    const parsed = new URL(url);
    // A wrong host here would make every real fetch gate-refuse in 8.5.
    expect(parsed.hostname).toBe(FEATURE_HOSTS.liveLogoFetch);
    expect(parsed.protocol).toBe("https:");
    // The domain is sent to the provider (as the `url` query param).
    expect(decodeURIComponent(url)).toContain("netflix.com");
  });

  it("fail-closed SSRF guard: rejects a non-domain-shaped value (CWE-918)", () => {
    // Regression (PR #2, amazon-q): `logoProviderUrl` is exported and embeds its
    // arg in the `url` query param. A caller bypassing the EnrichmentService's
    // normalizeDomainKey gate (a direct call, or a future call site) must not be
    // able to steer the favicon service at an attacker-controlled target.
    for (const bad of [
      "https://attacker.example/pwn", // a full URL
      "evil.example/path", // embedded path
      "a.com&x=y", // query-injection chars
      "a.com#frag",
      "a.com/../../x",
      "nodot", // no dot → not a registrable domain
      " ", // empty after trim
      "..", // empty labels
    ]) {
      expect(() => logoProviderUrl(bad)).toThrow(/invalid domain/);
    }
    // A legitimate bare registrable domain still works (and lowercases).
    expect(new URL(logoProviderUrl("Netflix.COM")).hostname).toBe(
      FEATURE_HOSTS.liveLogoFetch,
    );
    expect(decodeURIComponent(logoProviderUrl("Netflix.COM"))).toContain("netflix.com");
  });
});

describe("fetchLogo: gated fetch with injected fetchImpl", () => {
  it("resolves { bytes, contentType } for an ok Response with a body", async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    const fetchImpl = vi.fn(
      async () =>
        new Response(body, { status: 200, headers: { "content-type": "image/png" } }),
    );

    const result = await fetchLogo("netflix.com", LOGO_ON, fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.contentType).toBe("image/png");
    expect(Array.from(result.bytes)).toEqual([1, 2, 3, 4]);
  });

  it("rejects on a non-ok HTTP status (not a usable logo)", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 }));
    await expect(
      fetchLogo("netflix.com", LOGO_ON, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("rejects on an ok Response with an empty body", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(new Uint8Array([]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );
    await expect(
      fetchLogo("netflix.com", LOGO_ON, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/empty body/);
  });

  it("gate-refuses (NetworkGateError) when liveLogoFetch is off — no socket", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    await expect(
      fetchLogo("netflix.com", { liveLogoFetch: false, fxRefresh: false }, fetchImpl as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(NetworkGateError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
