/**
 * Dynamic, settings-driven Content-Security-Policy builder (AD-7; Story 8.1).
 *
 * The production renderer loads from `file://` and the strict CSP is enforced at
 * the network layer (`onHeadersReceived` in `main.ts`) as defense-in-depth
 * alongside the `index.html` meta tag. `connect-src` is NOT a static literal:
 * it is `'self'` until an online feature is enabled, then exactly that feature's
 * host(s) — computed from the SAME {@link allowedHosts} resolver the socket-level
 * gate uses, so the CSP allowlist and the gate allowlist can never disagree
 * (AD-6/AD-7).
 *
 * This module is PURE and network-free (it imports only `allowedHosts` and the
 * `OnlineSettingsV2` type), so the privacy test can import `buildCsp` under the
 * pure-Node harness WITHOUT booting Electron — `main.ts` cannot be imported
 * under Node because it pulls in the `electron` runtime at module load.
 */

import type { OnlineSettingsV2 } from "core/models/settings";

import { allowedHosts } from "./hosts";

/**
 * Every CSP directive EXCEPT `connect-src`. These are static and identical to
 * the fully-offline 1.0 policy; only `connect-src` is settings-driven.
 */
const STATIC_DIRECTIVES =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; " +
  "object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

/**
 * Compute the `connect-src` value for the given toggles:
 *   - no enabled feature → `'self'` (no remote origin, byte-identical to 1.0).
 *   - one or more enabled → `'self'` plus exactly each enabled feature's
 *     `https://<host>`, and nothing more.
 *
 * Hosts are sorted so the output is deterministic regardless of `Set` insertion
 * order.
 */
function connectSrc(online: OnlineSettingsV2): string {
  const hosts = [...allowedHosts(online)].sort();
  if (hosts.length === 0) return "connect-src 'self'";
  const origins = hosts.map((h) => `https://${h}`).join(" ");
  return `connect-src 'self' ${origins}`;
}

/**
 * Build the full production CSP string for the given `settings.online` toggles.
 * The one source for both the `onHeadersReceived` header and the privacy test's
 * assertion that a toggles-off policy carries no remote origin.
 */
export function buildCsp(online: OnlineSettingsV2): string {
  return `${STATIC_DIRECTIVES}; ${connectSrc(online)}`;
}
