/**
 * LogoTile — a small decorative brand-logo tile shown leading a subscription
 * NAME (Story 8.3; FR-26, AD-25).
 *
 * Rendered before a subscription name in the List (table + card) and the
 * Dashboard panels, beside the existing {@link CategoryColorDot}. It reads the
 * once-hydrated {@link logoPackStore} and resolves the tile SYNCHRONOUSLY via the
 * pure {@link resolveLogo} — no await, no per-row IPC, nothing network-touching
 * on the render path (AD-9):
 *
 *   - A bundled brand (its `website` normalizes to a domain in the pack) renders
 *     the Simple Icon SVG with ZERO network.
 *   - Any miss (no match, empty `website`, or a pack that failed to load → the
 *     EMPTY pack) renders a DETERMINISTIC lettered/colored fallback keyed off the
 *     NAME — never blank, never a spinner, never a blocking fetch.
 *
 * It is purely DECORATIVE and `aria-hidden`: the subscription NAME beside it is
 * the real text label, so the mark is never the sole carrier of meaning (mirror
 * {@link CategoryColorDot}'s rationale and the DESIGN state/color rule). It is
 * NOT a focus target and carries no alt text duplicating the name. The caller
 * renders the name itself.
 */

import { resolveLogo } from "core/logo";
import { logoPackStore } from "@/stores/logoPackStore";
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
  const logo = resolveLogo(pack, { name, website });

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
