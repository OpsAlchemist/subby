/**
 * The network gateway — the SOLE audited net-primitive site in the repo (AD-5,
 * AD-6; Story 8.1).
 *
 * This is the ONE file where a network primitive (`fetch`) may appear. Every
 * other file under `core/`, `src/`, `shared/`, and all of `electron/` OUTSIDE
 * `electron/net/` stays network-free — the privacy test enforces that, allowing
 * net primitives/modules ONLY under `electron/net/`.
 *
 * The gate decision is PURE and runs BEFORE the primitive is ever invoked: a
 * request whose feature toggle is off, or whose host is not registered in
 * `hosts.ts`, is refused with a typed {@link NetworkGateError} without a socket
 * ever opening. The gate reads its allowlist from the SAME {@link allowedHosts}
 * resolver the dynamic CSP uses, so the two can never disagree (AD-6/AD-7).
 *
 * The `fetch` primitive is INJECTABLE (`deps.fetchImpl`) so the pure-Node test
 * harness can prove "no socket when gated" with a spy — the gate is reached and
 * the spy records zero calls — without booting Chromium (addendum §SM-3; the
 * true packet-capture of a running build is a documented release-QA step in
 * `RELEASE.md`, not faked in CI).
 *
 * Fail-soft (AD-28): this never throws into the event loop. A gated/refused
 * request REJECTS with {@link NetworkGateError}. Past the gate, a TRANSPORT
 * error (DNS/connection failure) and a cross-host REDIRECT (the fetch is issued
 * with `redirect: "error"`, so a 30x to any other host rejects rather than
 * silently following off the allowlist — AD-6) both reject as a rejected
 * promise with no retry here; an HTTP ERROR STATUS (404/500/…) is NOT a
 * rejection — `fetch` resolves with a non-ok `Response` the caller inspects.
 */

import type { OnlineSettingsV2 } from "core/models/settings";

import { allowedHosts } from "./hosts";

/**
 * Thrown (as a rejected promise) when the gate refuses a request BEFORE any
 * socket is opened: either the request's feature toggle is off, or its host is
 * not registered in `hosts.ts`. A typed error so the caller can distinguish a
 * policy refusal from a genuine network/HTTP failure (AD-28).
 */
export class NetworkGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkGateError";
  }
}

/**
 * Dependencies for a gated request:
 *   - `online`: the live `settings.online` toggles — the single source of truth
 *     for which hosts may be reached.
 *   - `fetchImpl`: the network primitive, injectable for tests. Defaults to the
 *     global `fetch`, reached ONLY past the gate.
 */
export interface GatewayDeps {
  online: OnlineSettingsV2;
  fetchImpl?: typeof fetch;
}

/**
 * Perform a gated GET.
 *
 * Resolves the request's host, consults {@link allowedHosts} over the supplied
 * toggles, and REFUSES — before touching the network primitive — any host that
 * is not currently allowed (off-toggle or unregistered). Only a host that is in
 * the allowed set reaches the primitive, which is called exactly once with the
 * resolved URL.
 */
export async function get(url: string, deps: GatewayDeps): Promise<Response> {
  // A malformed URL cannot name an allowed host, so it is refused the same way
  // as an unregistered host — before any socket work.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new NetworkGateError(`blocked: malformed URL`);
  }

  // Fail-closed on scheme BEFORE the host check: the paired CSP lists `https://`
  // origins only, so a non-https request (e.g. `http://<allowed-host>`) must be
  // refused or the gate and the CSP would disagree on scheme (AD-6).
  if (parsed.protocol !== "https:") {
    throw new NetworkGateError(`blocked: non-https scheme (${parsed.protocol})`);
  }

  if (!allowedHosts(deps.online).has(parsed.hostname)) {
    // Off-toggle OR unregistered host: refused before the primitive runs. No
    // socket is opened — the injected primitive is never invoked.
    throw new NetworkGateError(`blocked: ${parsed.hostname}`);
  }

  // Past the gate: the ONLY place the network primitive is reached. `redirect:
  // "error"` makes a cross-host 30x reject rather than silently follow to an
  // unlisted host — closing the redirect-based allowlist bypass (AD-6).
  const fetchImpl = deps.fetchImpl ?? fetch;
  return fetchImpl(url, { redirect: "error" });
}

/** The gateway surface callers (future providers) use: a single gated `get`. */
export const gateway = { get } as const;
