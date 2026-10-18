/**
 * LogoTile — a small decorative brand-logo tile shown leading a subscription
 * NAME (Story 8.3; FR-26, AD-25).
 *
 * Rendered before a subscription name in the List (table + card) and the
 * Dashboard panels, beside the existing {@link CategoryColorDot}. It reads the
 * once-hydrated {@link logoPackStore} AND the reload-on-change
 * {@link logoCacheStore}, and resolves the tile SYNCHRONOUSLY via the pure
 * {@link resolveLogo} — no await, no per-row IPC, nothing network-touching on the
 * render path (AD-9):
 *
 *   - A bundled brand (its `website` normalizes to a domain in the pack) renders
 *     the Simple Icon SVG with ZERO network.
 *   - A cached brand (a logo fetched in a prior session and persisted to the
 *     `logos/` blob cache, Story 8.4) renders the persisted data-URI as an
 *     `<img>` — the tier BETWEEN bundled and lettered. It swaps in when the
 *     EnrichmentService broadcasts `evt:dataChanged` and the cache store reloads.
 *   - Any miss (no match, empty `website`, or a pack that failed to load → the
 *     EMPTY pack) renders a DETERMINISTIC lettered/colored fallback keyed off the
 *     NAME — never blank, never a spinner, never a blocking fetch.
 *
 * It is purely DECORATIVE and `aria-hidden`: the subscription NAME beside it is
 * the real text label, so the mark is never the sole carrier of meaning (mirror
 * {@link CategoryColorDot}'s rationale and the DESIGN state/color rule). It is
 * NOT a focus target and carries no alt text duplicating the name. The caller
 * renders the name itself.
 *
 * ## Live logo fetch trigger (Story 8.5; FR-27, AD-9, AD-14)
 *
 * This is the ONE place the opt-in live-logo pipeline is triggered. When — and
 * ONLY when — ALL of these hold:
 *
 *   1. `settings.online.liveLogoFetch === true` (the user turned the
 *      highest-scrutiny toggle on, having read the aggregate-exposure notice),
 *   2. the resolved logo is the lettered fallback (`kind === "letter"`) — a TRUE
 *      pack+cache miss, never a bundled or already-cached hit, and
 *   3. `domainFromWebsite(website)` is a non-null registrable domain,
 *
 * the tile fires a fire-and-forget {@link enqueueEnrichmentSafe} for that exact
 * domain (the same key the cache + resolver use). The EnrichmentService (8.4)
 * fetches through the audited gateway, persists the blob, and broadcasts
 * `evt:dataChanged`; the {@link logoCacheStore} reloads and the fetched logo
 * swaps in as `kind:"cached"` on the next render — nothing blocks, nothing awaits
 * (AD-9), and a failed/absent fetch degrades silently to the lettered tile.
 *
 * With the toggle OFF the effect NEVER enqueues and NO fetch occurs — the
 * headline "zero outbound when off" invariant. The REAL idempotency guarantor is
 * the BACKEND: the EnrichmentService's serial-queue de-dup + never-refetch
 * `has()` make any redundant enqueue harmless. The renderer's effect-dep keying
 * (`[domain, liveLogoFetch, logo.kind]`) is a best-effort quieting that avoids
 * churn on unrelated re-renders — it is NOT a hard exactly-once promise (a
 * StrictMode double-mount, for instance, can run it twice), which is exactly why
 * the backend owns the de-dup.
 */

import { useEffect } from "react";

import { domainFromWebsite, resolveLogo } from "core/logo";
import { enqueueEnrichmentSafe } from "@/api/subby";
import { logoPackStore } from "@/stores/logoPackStore";
import { logoCacheStore } from "@/stores/logoCacheStore";
import { settingsStore } from "@/stores/settingsStore";
import { useStoreData } from "@/stores/hooks";
import { cn } from "@/lib/utils";

export interface LogoTileProps {
  /** The subscription's display name (keys the deterministic lettered fallback). */
  name: string;
  /** The subscription's free-text website (normalized to a domain for lookup). */
  website: string;
  /** Optional extra classes (e.g. a margin from the caller). */
  className?: string;
}

/** ~22px square, `{rounded.md}` — the DESIGN logo-tile size (SubscriptionList/Dashboard). */
const TILE_CLASS =
  "inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center overflow-hidden rounded-md align-middle";

/**
 * A decorative, aria-hidden brand/lettered tile for a subscription row.
 *
 * Resolution is synchronous from the already-loaded local pack (AD-9); the
 * component holds no state and performs no I/O.
 */
export default function LogoTile({
  name,
  website,
  className,
}: LogoTileProps): JSX.Element {
  const pack = useStoreData(logoPackStore);
  const cache = useStoreData(logoCacheStore);
  const settings = useStoreData(settingsStore);
  const logo = resolveLogo(pack, cache, { name, website });

  // Live logo fetch trigger (Story 8.5; FR-27). The ONLY place the opt-in logo
  // pipeline is kicked off: a TRUE pack+cache miss (lettered fallback) for a real
  // registrable domain, while `liveLogoFetch` is ON, enqueues that domain for a
  // background fetch. Fire-and-forget (never awaited; AD-9). With the toggle OFF
  // this never enqueues and nothing fetches (the headline invariant). The deps are
  // the primitives that actually gate the enqueue — `domain`, `liveLogoFetch`, and
  // `logo.kind` (so a bundled/cached→letter transition at the SAME domain+toggle
  // would still fire; not reachable today but correct-by-construction) — rather
  // than the `logo` object (new identity each render). Redundant re-runs are
  // harmless: the backend serial-queue de-dup + never-refetch `has()` own the
  // real idempotency.
  const domain = domainFromWebsite(website);
  const liveLogoFetch = settings.online.liveLogoFetch;
  const logoKind = logo.kind;
  useEffect(() => {
    if (logoKind === "letter" && liveLogoFetch && domain !== null) {
      void enqueueEnrichmentSafe(domain);
    }
  }, [domain, liveLogoFetch, logoKind]);

  if (logo.kind === "bundled") {
    // Bundled Simple Icon: a single 24×24 path filled with the brand hex, on a
    // soft tinted plate so a dark/near-black mark stays legible on dark surfaces.
    return (
      <span
        aria-hidden="true"
        className={cn(TILE_CLASS, "bg-secondary", className)}
      >
        <svg
          viewBox="0 0 24 24"
          className="h-[14px] w-[14px]"
          role="presentation"
          focusable="false"
        >
          <path d={logo.path} fill={`#${logo.hex}`} />
        </svg>
      </span>
    );
  }

  if (logo.kind === "cached") {
    // A fetched-and-persisted logo (Story 8.4): render the data-URI as an image
    // on the same tinted plate. Decorative + aria-hidden (the name beside it is
    // the real label), so the `<img>` carries no meaningful alt text. The data-
    // URI is local (no network at render) and resolves synchronously.
    return (
      <span
        aria-hidden="true"
        className={cn(TILE_CLASS, "bg-secondary", className)}
      >
        <img
          src={logo.dataUri}
          alt=""
          aria-hidden="true"
          className="h-[14px] w-[14px] object-contain"
        />
      </span>
    );
  }

  // Deterministic lettered/colored fallback (same name → same letter AND color).
  return (
    <span
      aria-hidden="true"
      className={cn(TILE_CLASS, "text-[11px] font-semibold text-white", className)}
      style={{ backgroundColor: logo.color }}
    >
      {logo.letter}
    </span>
  );
}
