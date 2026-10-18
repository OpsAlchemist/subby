import { describe, it, expect } from "vitest";

import type { OnlineSettingsV2 } from "core/models/settings";

import { buildCsp } from "../../electron/net/csp";
import { allowedHosts, FEATURE_HOSTS } from "../../electron/net/hosts";

/**
 * Dynamic production CSP (Story 8.1, AD-7) — the settings-driven `connect-src`.
 *
 * Covers the I/O matrix's "CSP on" row: when an online toggle is enabled the
 * production `connect-src` is exactly `'self'` plus that feature's registered
 * host over HTTPS, and NOTHING more. The "CSP off" row (toggles off →
 * `connect-src 'self'`, no remote origin) is pinned by the privacy test; this
 * file pins the enabled composition, derived from the SAME `allowedHosts`
 * resolver the socket-level gate uses (so the CSP and gate can never disagree).
 */

const LOGO_HOST = FEATURE_HOSTS.liveLogoFetch; // t2.gstatic.com
const FX_HOST = FEATURE_HOSTS.fxRefresh; // api.frankfurter.dev

/** Pull a single directive's value out of a CSP string. */
function cspDirective(csp: string, directive: string): string | null {
  const match = csp.match(new RegExp(`${directive}\\s+([^;]+)`));
  return match ? match[1].trim() : null;
}

describe("buildCsp: connect-src is settings-driven (AD-7)", () => {
  it("adds exactly the logo host (and nothing more) when only liveLogoFetch is on", () => {
    const csp = buildCsp({ liveLogoFetch: true, fxRefresh: false });
    expect(cspDirective(csp, "connect-src")).toBe(`'self' https://${LOGO_HOST}`);
    // The logo host is EXACTLY t2.gstatic.com (the Story 8.5 provider of record).
    expect(LOGO_HOST).toBe("t2.gstatic.com");
    expect(csp).toContain("https://t2.gstatic.com");
    // The FX host must NOT appear when its toggle is off.
    expect(csp).not.toContain(FX_HOST);
    // Static directives are preserved.
    expect(cspDirective(csp, "default-src")).toBe("'self'");
    expect(cspDirective(csp, "object-src")).toBe("'none'");
  });

  it("removes the logo host when liveLogoFetch flips off — the toggle add/remove is symmetric (Story 8.5)", () => {
    // The headline off-invariant seen from the CSP side: with every online toggle
    // off, connect-src is exactly 'self' and the logo host is gone — proving the
    // host is ADDED only while the toggle is on and REMOVED the moment it is off
    // (the dynamic CSP computes the same allowlist the socket gate does, AD-6/7).
    const off = buildCsp({ liveLogoFetch: false, fxRefresh: false });
    expect(cspDirective(off, "connect-src")).toBe("'self'");
    expect(off).not.toContain(LOGO_HOST);
    expect(off).not.toMatch(/https?:/);
    expect(off).not.toMatch(/\bws{1,2}:/);
  });

  it("adds exactly the FX host (and nothing more) when only fxRefresh is on", () => {
    const csp = buildCsp({ liveLogoFetch: false, fxRefresh: true });
    expect(cspDirective(csp, "connect-src")).toBe(`'self' https://${FX_HOST}`);
    expect(csp).not.toContain(LOGO_HOST);
  });

  it("adds exactly both registered hosts (deterministic order) when both toggles are on", () => {
    const online: OnlineSettingsV2 = { liveLogoFetch: true, fxRefresh: true };
    const connect = cspDirective(buildCsp(online), "connect-src");
    // Hosts are sorted for a deterministic header regardless of Set order.
    const expected = [LOGO_HOST, FX_HOST]
      .sort()
      .map((h) => `https://${h}`)
      .join(" ");
    expect(connect).toBe(`'self' ${expected}`);
  });

  it("permits no http: (only https:) and no scheme beyond the registered host", () => {
    const csp = buildCsp({ liveLogoFetch: true, fxRefresh: true });
    expect(csp).not.toMatch(/\bhttp:/);
    expect(csp).not.toMatch(/\bws{1,2}:/);
  });
});

describe("allowedHosts: single-provider invariant for live logo fetch (Story 8.5)", () => {
  it("resolves to EXACTLY one origin — the provider of record t2.gstatic.com — and no second origin", () => {
    // Pins "exactly one logo origin, the provider of record": if a future change
    // ever adds a second logo provider / per-service origin, this fails loudly.
    const hosts = allowedHosts({ liveLogoFetch: true, fxRefresh: false });
    expect(hosts).toEqual(new Set(["t2.gstatic.com"]));
    expect(hosts.size).toBe(1);
  });
});
