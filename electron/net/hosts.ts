/**
 * Feature→host registry and the single `allowedHosts` resolver (AD-5, AD-6;
 * Story 8.1).
 *
 * This is the one place that maps an online feature toggle to the host(s) it is
 * permitted to reach. It is PURE and network-free: it imports only the
 * `OnlineSettingsV2` *type* and contains no network primitive. Both the
 * socket-level gate ({@link ../gateway} `gateway.get`) AND the dynamic
 * production CSP ({@link ./csp} `buildCsp`) derive their allowlist from the SAME
 * {@link allowedHosts} call over the SAME `settings.online` input, so the gate
 * and the CSP can never compute different allowlists (AD-6/AD-7).
 *
 * Adding a new online feature means adding a field to `OnlineSettingsV2`
 * (`core/models/settings.ts`) AND a mapping here — nowhere else (AD-22).
 */

import type { OnlineSettingsV2 } from "core/models/settings";

/**
 * The registered host for each online feature (run-level decisions, Epic 8
 * context):
 *   - `liveLogoFetch` → `t2.gstatic.com` — Google `s2/faviconV2` logo provider
 *     of record (Story 8.5). Confirmed to receive the queried domain.
 *   - `fxRefresh` → `api.frankfurter.dev` — Frankfurter's ECB rate path (AD-23),
 *     lineage-consistent with the bundled ECB FX snapshot.
 *
 * Keyed by the exact `OnlineSettingsV2` field name so a new field cannot be
 * added to the settings block without a compile-time nudge to register its host
 * here (`FeatureHosts` is a `Record<keyof OnlineSettingsV2, …>`).
 */
export const FEATURE_HOSTS: Readonly<Record<keyof OnlineSettingsV2, string>> = {
  liveLogoFetch: "t2.gstatic.com",
  fxRefresh: "api.frankfurter.dev",
};

/**
 * Resolve the set of hosts that may currently be reached, given the live
 * `settings.online` toggles. The SINGLE source of truth shared by the gate and
 * the CSP (AD-6).
 *
 * A feature contributes its registered host ONLY when its toggle is `true`. With
 * every toggle `false` the result is an EMPTY set — so the gateway refuses every
 * request and the production CSP stays `connect-src 'self'` with no remote
 * origin (byte-identical to the fully-offline 1.0 behavior).
 *
 * Pure: no I/O, no clock, no network — deterministic in its single input.
 */
export function allowedHosts(online: OnlineSettingsV2): Set<string> {
  const hosts = new Set<string>();
  for (const feature of Object.keys(FEATURE_HOSTS) as (keyof OnlineSettingsV2)[]) {
    if (online[feature]) {
      hosts.add(FEATURE_HOSTS[feature]);
    }
  }
  return hosts;
}
