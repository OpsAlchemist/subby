/**
 * Pure logo resolution core (FR-26, AD-25; Story 8.3).
 *
 * Platform-independent. MUST NOT import from `electron`, `react`, or Node's
 * `fs`/`node:*`, and reads no wall-clock, filesystem, or NETWORK (AD-1, AD-9).
 * Every function here is PURE: it never mutates its inputs, reads no clock, and
 * — critically for this epic — contains NO network primitive. The whole module
 * resolves a row's logo from already-loaded local data only (mirror
 * `core/money.ts` / `core/priceSeed.ts`).
 *
 * The resolution order is bundled Logo Pack → `logos/` cache → deterministic
 * lettered/colored fallback. There is NO fetch here (that is Story 8.5): the
 * cache is a plain already-loaded `Record<string,string>` (domain→data-URI)
 * param (Story 8.4), so this module stays pure and network-free. A bundled brand
 * renders with zero network; a cached brand renders a persisted data-URI; any
 * miss (no match, empty website, or a pack that failed to load) renders a
 * deterministic lettered tile — never blank, never a blocking fetch.
 *
 *   - {@link parseLogoPack} validates a raw (`unknown`) object into a typed
 *     {@link LogoPack}, degrading to an EMPTY pack on any defect (so a missing/
 *     corrupt bundle makes every row show the lettered fallback — never a crash,
 *     never a toast). Unlike the money/price cores (which fail LOUD on a bad
 *     bundle because a wrong number is dangerous), a bad logo pack is a cosmetic
 *     degrade: the correct behavior is a silent fallback, so parse is lenient.
 *   - {@link domainFromWebsite} normalizes a subscription's free-text `website`
 *     to a registrable domain (strip scheme / `www.` / path / query / port), or
 *     `null` when it is empty or unparseable.
 *   - {@link letterTile} is a SELF-CONTAINED deterministic hash of a name to a
 *     `{ letter, color }` — same name always yields the same tile, with no
 *     dependency on any store (unlike `CategoryColorDot`, which looks the color
 *     up in the categories store).
 *   - {@link resolveLogo} is the single resolver: a bundled hit → the SVG path +
 *     hex; a cache hit → the persisted data-URI (`kind:"cached"`); otherwise the
 *     lettered fallback.
 */

/**
 * The single supported logo-pack schema version. A pack whose `version` is not
 * exactly this integer is treated as unreadable and degraded to EMPTY (every
 * row falls back to the lettered tile) — never guessed at.
 */
export const LOGO_PACK_SCHEMA_VERSION = 1 as const;

/**
 * One bundled brand mark, keyed by registrable domain in {@link LogoPack.icons}.
 * The compact Simple-Icon shape: the single 24×24 `path` (the SVG `d`), the brand
 * `hex` (no leading `#`), and the human `title`. The {@link LogoTile} component
 * renders `<svg viewBox="0 0 24 24"><path d={path} fill={"#"+hex}/></svg>`.
 */
export interface LogoIcon {
  /** Human-readable brand title (e.g. "Netflix"). */
  title: string;
  /** Brand hex color WITHOUT a leading `#` (e.g. `E50914`). */
  hex: string;
  /** The single 24×24 SVG path `d` attribute. */
  path: string;
}

/**
 * A validated, typed bundled Logo Pack.
 *
 *   - `version`     — the integer schema version (=== {@link LOGO_PACK_SCHEMA_VERSION}).
 *   - `generatedAt` — ISO timestamp the pack was generated (provenance only).
 *   - `note`        — a short provenance / licensing note (Simple Icons, CC0).
 *   - `icons`       — a map of registrable domain → {@link LogoIcon}.
 */
export interface LogoPack {
  version: number;
  generatedAt: string;
  note: string;
  icons: Readonly<Record<string, LogoIcon>>;
}

/** The canonical EMPTY pack: a pack that resolves every row to the fallback. */
export const EMPTY_LOGO_PACK: LogoPack = Object.freeze({
  version: LOGO_PACK_SCHEMA_VERSION,
  generatedAt: "1970-01-01T00:00:00.000Z",
  note: "empty",
  icons: Object.freeze({}),
});

/**
 * The resolution of a row's logo (the output of {@link resolveLogo}):
 *   - `kind: "bundled"` — a bundled brand mark (its SVG `path` + `hex` + `title`).
 *   - `kind: "cached"`  — a fetched-and-persisted logo (Story 8.4): the
 *     `data:<mime>;base64,…` URI from the `logos/` blob cache, rendered as an
 *     `<img src>`. The cache tier sits BETWEEN bundled and letter.
 *   - `kind: "letter"`  — the deterministic lettered/colored fallback.
 */
export type LogoResolution =
  | { kind: "bundled"; path: string; hex: string; title: string }
  | { kind: "cached"; dataUri: string; title: string }
  | { kind: "letter"; letter: string; color: string };

/**
 * The warm, muted fallback palette (aligned to the DESIGN tokens). It
 * DELIBERATELY avoids the brand accent (ochre `#92400e` / amber `#f59e0b`) and
 * the destructive red so a logo tile is never confused with an action or a
 * danger affordance — the same rule {@link DEFAULT_CATEGORY_COLORS} follows.
 * These are the only colors a lettered tile can take; the hash below picks one
 * deterministically from the name, so the set is a stable, bounded palette.
 *
 * Every entry clears WCAG AA (≥ 4.5:1 contrast) against the WHITE letter it
 * carries — the cyan/emerald/green/teal are the DARKER shades of their hues for
 * exactly that reason (the lighter `#0891b2` / `#059669` / `#16a34a` / `#0d9488`
 * fail 4.5:1 for an 11px-semibold white glyph). `tests/logo.test.ts` guards this.
 */
export const LETTER_TILE_PALETTE: readonly string[] = Object.freeze([
  "#7c3aed", // violet
  "#2563eb", // blue
  "#0e7490", // cyan (darkened for AA white contrast)
  "#db2777", // pink
  "#047857", // emerald (darkened for AA white contrast)
  "#9333ea", // purple
  "#4f46e5", // indigo
  "#15803d", // green (darkened for AA white contrast)
  "#0f766e", // teal (darkened for AA white contrast)
  "#64748b", // slate
  "#7c6f64", // warm stone
  "#be123c", // rose (distinct from destructive #b91c1c)
]);

/** The letter shown when a name has no alphanumeric character to key off. */
const FALLBACK_LETTER = "#";

/**
 * A deterministic lettered/colored fallback tile for `name`.
 *
 * SELF-CONTAINED and PURE (no store, no clock): the same `name` always yields
 * the same `{ letter, color }`, on every surface and every render. The `letter`
 * is the first alphanumeric character of the trimmed name, uppercased (so
 * "netflix" and "  Netflix " both give "N"); a name with no alphanumeric
 * character (empty, whitespace, or all-symbol) yields {@link FALLBACK_LETTER}.
 * The `color` is one of {@link LETTER_TILE_PALETTE}, chosen by a stable string
 * hash of the trimmed, lowercased name so the choice is deterministic and
 * well-distributed.
 */
export function letterTile(name: string): { letter: string; color: string } {
  const trimmed = (name ?? "").trim();

  // First alphanumeric char, uppercased — or the `#` sentinel if there is none.
  let letter = FALLBACK_LETTER;
  for (const ch of trimmed) {
    if (/[a-z0-9]/i.test(ch)) {
      letter = ch.toUpperCase();
      break;
    }
  }

  // Stable 32-bit FNV-1a hash over the normalized name, mapped into the palette.
  // Hashing the normalized (lowercased) name keeps "Netflix" and "netflix" on
  // the same color, so the choice is case-insensitively deterministic.
  const key = trimmed.toLowerCase();
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    // FNV prime 16777619, kept in 32-bit unsigned space via Math.imul + >>> 0.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const color = LETTER_TILE_PALETTE[hash % LETTER_TILE_PALETTE.length];

  return { letter, color };
}

/**
 * Normalize a subscription's free-text `website` to a registrable domain, or
 * `null` when it is empty or unparseable.
 *
 * The transform strips an optional scheme, a leading `www.`, any path / query /
 * fragment / port, and lowercases the host. A multi-label host is reduced to its
 * registrable domain by taking the LAST TWO labels (`music.youtube.com` →
 * `youtube.com`), which is a deliberately simple heuristic — it is good enough
 * for a logo lookup (a wrong lookup just falls back to the lettered tile, never
 * a wrong number), and it keeps this core free of a public-suffix-list
 * dependency. A value that yields no dot-separated host (e.g. a bare `acme`, or
 * pure junk) returns `null` and is treated as a miss by {@link resolveLogo}.
 *
 * Examples:
 *   domainFromWebsite("https://www.netflix.com/browse") === "netflix.com"
 *   domainFromWebsite("music.youtube.com")              === "youtube.com"
 *   domainFromWebsite("NETFLIX.COM")                    === "netflix.com"
 *   domainFromWebsite("")                               === null
 *   domainFromWebsite("not a url")                      === null
 */
export function domainFromWebsite(website: string): string | null {
  if (typeof website !== "string") return null;
  let s = website.trim();
  if (s === "") return null;

  // Strip a scheme (`https://`, `http://`, or a scheme-relative `//`).
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  s = s.replace(/^\/\//, "");

  // Drop any path / query / fragment: the host is everything up to the first
  // `/`, `?`, or `#`.
  s = s.split(/[/?#]/, 1)[0];

  // Drop userinfo (`user@host`) and a port (`host:443`).
  const at = s.lastIndexOf("@");
  if (at !== -1) s = s.slice(at + 1);
  s = s.split(":", 1)[0];

  s = s.replace(/^www\./i, "").toLowerCase();

  // A valid host must contain at least one dot (a registrable domain always
  // does). Reject anything with whitespace or no label structure.
  if (s === "" || /\s/.test(s) || !s.includes(".")) return null;

  const labels = s.split(".").filter((l) => l.length > 0);
  if (labels.length < 2) return null;

  // Registrable domain ≈ the last two labels. Simple and dependency-free; a
  // ccTLD edge like `co.uk` just resolves one label too shallow, which at worst
  // misses the bundled icon and falls back to the lettered tile — never wrong.
  return labels.slice(-2).join(".");
}

/**
 * Resolve a row's logo from the bundled {@link LogoPack}, the fetched-logo cache,
 * and a deterministic lettered fallback — the full three-tier order (Story 8.4):
 *
 *   1. Normalize `website` to a registrable domain. If the domain is in the
 *      PACK, return the bundled mark (`kind: "bundled"`) — bundled always wins
 *      (zero network, a curated/correct mark).
 *   2. Else if the domain is in the `cache` map, return the persisted data-URI
 *      (`kind: "cached"`) — a logo fetched in a prior session that swapped in.
 *   3. Otherwise (no website, no match in pack or cache, or an empty/failed
 *      pack), return the deterministic lettered/colored fallback
 *      (`kind: "letter"`) keyed off `name` — never blank, never a fetch.
 *
 * `cache` is a plain `Record<string,string>` of domain→`data:<mime>;base64,…`,
 * keyed by the SAME lowercased registrable domain as the pack. Passing `{}`
 * (the default) collapses to the Story 8.3 bundled→letter order, so existing
 * callers/tests that do not know about the cache behave identically.
 *
 * Pure and synchronous: no clock, no filesystem, no network — safe on the render
 * hot path (AD-9). Story 8.5 only turns ON the fetch that fills the cache; it
 * does not change this contract.
 */
export function resolveLogo(
  pack: LogoPack,
  cache: Record<string, string>,
  sub: { name: string; website: string },
): LogoResolution {
  const domain = domainFromWebsite(sub.website);
  if (domain !== null) {
    const icon = pack.icons[domain];
    if (icon !== undefined) {
      return { kind: "bundled", path: icon.path, hex: icon.hex, title: icon.title };
    }
    // Cache tier (Story 8.4): a persisted logo for this domain, below bundled.
    const dataUri = cache[domain];
    if (typeof dataUri === "string" && dataUri.length > 0) {
      return { kind: "cached", dataUri, title: sub.name };
    }
  }
  const { letter, color } = letterTile(sub.name);
  return { kind: "letter", letter, color };
}

/** True for a single valid {@link LogoIcon} shape (non-empty title/hex/path). */
function isValidIcon(raw: unknown): raw is LogoIcon {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const obj = raw as Record<string, unknown>;
  return (
    typeof obj.title === "string" &&
    obj.title.length > 0 &&
    typeof obj.hex === "string" &&
    // Valid CSS hex lengths only: 3 (#rgb), 6 (#rrggbb), or 8 (#rrggbbaa).
    /^(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(obj.hex) &&
    typeof obj.path === "string" &&
    obj.path.length > 0
  );
}

/**
 * Validate a raw (`unknown`) object into a typed {@link LogoPack}, degrading to
 * the {@link EMPTY_LOGO_PACK} on ANY defect.
 *
 * Unlike `parseBundledSnapshot` / `parsePriceSeed` (which throw LOUD on a bad
 * bundle because a wrong *number* is dangerous), a bad logo pack is purely
 * cosmetic: the correct degraded behavior is "every row shows the lettered
 * fallback", so this parser never throws — a wrong shape, wrong version, or a
 * malformed `icons` map all collapse to an empty pack. Individual malformed icon
 * entries are SKIPPED (not fatal), so one bad entry never blanks the whole pack.
 * Icon-domain keys are lowercased so lookup matches {@link domainFromWebsite}'s
 * lowercased output.
 */
export function parseLogoPack(raw: unknown): LogoPack {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return EMPTY_LOGO_PACK;
  }
  const obj = raw as Record<string, unknown>;

  if (obj.version !== LOGO_PACK_SCHEMA_VERSION) return EMPTY_LOGO_PACK;

  const icons = obj.icons;
  if (typeof icons !== "object" || icons === null || Array.isArray(icons)) {
    return EMPTY_LOGO_PACK;
  }

  const validated: Record<string, LogoIcon> = {};
  for (const [domain, value] of Object.entries(icons as Record<string, unknown>)) {
    if (typeof domain !== "string" || domain.length === 0) continue;
    if (!isValidIcon(value)) continue; // skip one bad entry, never blank the pack
    validated[domain.toLowerCase()] = {
      title: value.title,
      hex: value.hex,
      path: value.path,
    };
  }

  return {
    version: LOGO_PACK_SCHEMA_VERSION,
    generatedAt: typeof obj.generatedAt === "string" ? obj.generatedAt : "",
    note: typeof obj.note === "string" ? obj.note : "",
    icons: validated,
  };
}
