/**
 * Barrel for the single audited network module (`electron/net/`; Story 8.1).
 *
 * Re-exports the gate, the shared allowlist resolver, the CSP builder, and the
 * typed gate error so callers import from one place. No network primitive lives
 * here — the sole primitive site is {@link ./gateway}.
 */

export { allowedHosts, FEATURE_HOSTS } from "./hosts";
export { buildCsp } from "./csp";
export { gateway, get, NetworkGateError, type GatewayDeps } from "./gateway";
