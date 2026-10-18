/**
 * Logo fetch provider (Story 8.4; the one logo provider, gated).
 *
 * A THIN caller over the 8.1 {@link gateway.get}: given a registrable domain it
 * builds the provider URL and performs ONE gated GET, returning the raw bytes +
 * content-type, or throwing. It contains NO network primitive of its own — the
 * only `fetch` in the repo stays inside `gateway.ts` (AD-5). Every request runs
 * through the gate, so with `liveLogoFetch` OFF the gateway refuses before any
 * socket opens (a {@link NetworkGateError}) and 8.4 is fully exercisable with the
 * gate CLOSED (enqueue → refused → silent fallback).
 *
 * Provider of record (run-level Epic 8 decision): Google `s2/faviconV2`, host
 * `t2.gstatic.com` — the SAME host registered for `liveLogoFetch` in
 * `net/hosts.ts`, so the gate's allowlist and this URL can never diverge. The
 * query sends the subscription's domain to that host; that user-facing exposure
 * only goes live in Story 8.5 when the toggle can be enabled. Here the provider
 * is minimal and exercised via an injected fake + the gate-closed path.
 *
 * Fail stance: a gate refusal, a transport error, a non-ok HTTP status, or an
 * empty body all THROW — the EnrichmentService catches every throw, treats a
 * `NetworkGateError` as an ordinary silent miss, and degrades to the fallback
 * (no cache write, no toast, no retry).
 */

import type { OnlineSettingsV2 } from "core/models/settings";

import { gateway } from "../gateway";

/** The bytes + content-type a successful logo fetch returns. */
export interface FetchedLogo {
  /** The raw image bytes. */
  bytes: Uint8Array;
  /** The response `Content-Type` (e.g. `image/png`), used to pick the cache extension. */
  contentType: string;
}

/**
 * The Google favicon provider host + size. `t2.gstatic.com` is the registered
 * `liveLogoFetch` host; `faviconV2` returns a reasonably crisp mark for a domain.
 * `sz=64` keeps the cached blob small (SM-C2 "lightness is the product").
 */
const PROVIDER_ORIGIN = "https://t2.gstatic.com";

/**
 * Build the provider URL that queries a mark for `domain`. Google's `faviconV2`
 * takes the target as a `url` parameter; we pass the bare domain as an https
 * origin so the provider resolves the site's favicon.
 */
export function logoProviderUrl(domain: string): string {
  const params = new URLSearchParams({
    client: "SOCIAL",
    type: "FAVICON",
    fallback_opts: "TYPE,SIZE,URL",
    url: `https://${domain}`,
    size: "64",
  });
  return `${PROVIDER_ORIGIN}/faviconV2?${params.toString()}`;
}

/**
 * Fetch a logo for `domain` through the gated gateway.
 *
 * @param domain  The registrable domain (the resolver's `domainFromWebsite`
 *                output) to look up a mark for.
 * @param online  The live `settings.online` toggles — passed straight to the
 *                gateway so the gate keys off the current `liveLogoFetch` state.
 * @param fetchImpl Optional injected network primitive, threaded through the
 *                gateway for tests. Omitted in production (the gateway's global
 *                `fetch`, reached only past the gate).
 * @returns the bytes + content-type on success.
 * @throws {NetworkGateError} when the gate refuses (toggle off / unregistered
 *                host) — treated as a silent miss by the caller.
 * @throws Error on a transport failure, a non-ok HTTP status, or an empty body.
 */
export async function fetchLogo(
  domain: string,
  online: OnlineSettingsV2,
  fetchImpl?: typeof fetch,
): Promise<FetchedLogo> {
  const response = await gateway.get(logoProviderUrl(domain), {
    online,
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });

  // The gateway resolves even on a non-ok HTTP status (it only rejects on a
  // transport error / blocked redirect); a 4xx/5xx is NOT a usable logo, so
  // treat it as a failed fetch the caller silently drops.
  if (!response.ok) {
    throw new Error(`logo fetch failed: HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error("logo fetch returned an empty body");
  }

  return { bytes, contentType };
}
