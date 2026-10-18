import { describe, it, expect, vi } from "vitest";

import type { OnlineSettingsV2 } from "core/models/settings";

import { allowedHosts, FEATURE_HOSTS } from "../../electron/net/hosts";
import { get, gateway, NetworkGateError } from "../../electron/net/gateway";

/**
 * Gated-network foundation — the Node-level runtime proof (Story 8.1, AD-5/6).
 *
 * The pure-Node CI harness cannot packet-capture a real Chromium (that stays a
 * documented release-QA step in RELEASE.md). What it CAN prove is the gate
 * itself: with the fetch primitive INJECTED as a spy, a request to an
 * off-toggle feature or an unregistered host is refused BEFORE the primitive is
 * invoked (zero spy calls = no socket), while an allowed request calls the
 * primitive exactly once with the resolved URL. It also pins the shared
 * `allowedHosts` resolver (off → ∅, on → exactly the registered host(s)) that
 * BOTH the gate and the dynamic CSP key off, so they can never disagree.
 */

const ALL_OFF: OnlineSettingsV2 = { liveLogoFetch: false, fxRefresh: false };

const LOGO_HOST = FEATURE_HOSTS.liveLogoFetch; // t2.gstatic.com
const FX_HOST = FEATURE_HOSTS.fxRefresh; // api.frankfurter.dev

/** A spy that resolves a dummy Response, so we can assert call count/args. */
function makeFetchSpy(): ReturnType<typeof vi.fn> {
  return vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response("ok", { status: 200 }),
  );
}

describe("allowedHosts resolver (shared by gate + CSP)", () => {
  it("returns the EMPTY set when every toggle is off", () => {
    const hosts = allowedHosts(ALL_OFF);
    expect(hosts.size).toBe(0);
  });

  it("returns exactly the logo host when only liveLogoFetch is on", () => {
    const hosts = allowedHosts({ liveLogoFetch: true, fxRefresh: false });
    expect([...hosts]).toEqual([LOGO_HOST]);
  });

  it("returns exactly the FX host when only fxRefresh is on", () => {
    const hosts = allowedHosts({ liveLogoFetch: false, fxRefresh: true });
    expect([...hosts]).toEqual([FX_HOST]);
  });

  it("returns exactly both registered hosts (and no others) when both are on", () => {
    const hosts = allowedHosts({ liveLogoFetch: true, fxRefresh: true });
    expect(hosts.has(LOGO_HOST)).toBe(true);
    expect(hosts.has(FX_HOST)).toBe(true);
    expect(hosts.size).toBe(2);
  });
});

describe("gateway.get: gate runs BEFORE the network primitive (AD-5/6)", () => {
  it("refuses when the feature toggle is off — primitive is never called (no socket)", async () => {
    const fetchImpl = makeFetchSpy();
    const url = `https://${LOGO_HOST}/favicon?domain=example.com`;

    await expect(get(url, { online: ALL_OFF, fetchImpl })).rejects.toBeInstanceOf(
      NetworkGateError,
    );
    // The spy recorded ZERO calls: the gate rejected before any socket work.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses an unregistered host even when a feature is enabled — primitive never called", async () => {
    const fetchImpl = makeFetchSpy();
    // liveLogoFetch is on (its host IS allowed), but we request a DIFFERENT host.
    const online: OnlineSettingsV2 = { liveLogoFetch: true, fxRefresh: false };
    const url = "https://evil.example.com/track";

    await expect(get(url, { online, fetchImpl })).rejects.toBeInstanceOf(
      NetworkGateError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a malformed URL before touching the primitive", async () => {
    const fetchImpl = makeFetchSpy();
    await expect(
      get("not a url", { online: { liveLogoFetch: true, fxRefresh: true }, fetchImpl }),
    ).rejects.toBeInstanceOf(NetworkGateError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a non-https (http://) URL to an allowed host — fail-closed on scheme", async () => {
    const fetchImpl = makeFetchSpy();
    // liveLogoFetch is on so the HOST is allowed, but the scheme is http:// —
    // the paired CSP lists https:// only, so the gate must refuse before fetch.
    const online: OnlineSettingsV2 = { liveLogoFetch: true, fxRefresh: false };
    const url = `http://${LOGO_HOST}/favicon?domain=example.com`;

    await expect(get(url, { online, fetchImpl })).rejects.toBeInstanceOf(
      NetworkGateError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("calls the primitive exactly once with the resolved URL and redirect:error when feature on AND host registered", async () => {
    const fetchImpl = makeFetchSpy();
    const online: OnlineSettingsV2 = { liveLogoFetch: true, fxRefresh: false };
    const url = `https://${LOGO_HOST}/favicon?domain=example.com`;

    const res = await get(url, { online, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // `redirect: "error"` is passed so a cross-host 30x rejects (AD-6).
    expect(fetchImpl).toHaveBeenCalledWith(url, { redirect: "error" });
    expect(res.status).toBe(200);
  });

  it("allows the FX host only when fxRefresh is on", async () => {
    const fetchImpl = makeFetchSpy();
    const url = `https://${FX_HOST}/v2/providers/ecb/rates`;

    // Off: refused, no call.
    await expect(
      get(url, { online: ALL_OFF, fetchImpl }),
    ).rejects.toBeInstanceOf(NetworkGateError);
    expect(fetchImpl).not.toHaveBeenCalled();

    // On: reaches the primitive exactly once.
    await get(url, { online: { liveLogoFetch: false, fxRefresh: true }, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(url, { redirect: "error" });
  });

  it("propagates a transport error from the primitive as a rejected promise (no retry)", async () => {
    // A TRANSPORT error (DNS/connection failure, or a redirect under
    // redirect:"error") is the only thing `fetch` rejects on; an HTTP error
    // STATUS resolves with a non-ok Response and is the caller's to inspect.
    const boom = new Error("network down");
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      throw boom;
    });
    const online: OnlineSettingsV2 = { liveLogoFetch: true, fxRefresh: false };
    const url = `https://${LOGO_HOST}/favicon?domain=example.com`;

    await expect(get(url, { online, fetchImpl })).rejects.toBe(boom);
    // Exactly one attempt: the gateway does not retry.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("exposes the same gate through the `gateway.get` surface", async () => {
    const fetchImpl = makeFetchSpy();
    await expect(
      gateway.get(`https://${LOGO_HOST}/x`, { online: ALL_OFF, fetchImpl }),
    ).rejects.toBeInstanceOf(NetworkGateError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
