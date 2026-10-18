import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  domainFromWebsite,
  letterTile,
  resolveLogo,
  parseLogoPack,
  EMPTY_LOGO_PACK,
  LETTER_TILE_PALETTE,
  LOGO_PACK_SCHEMA_VERSION,
  type LogoPack,
} from "core/logo";

/**
 * Pure logo-resolution core (Story 8.3; FR-26, AD-25).
 *
 * Covers the I/O & edge-case matrix: bundled hit, bundled miss, empty website,
 * a failed/empty pack, domain normalization (scheme / www. / path / subdomain),
 * fallback DETERMINISM (same name → same letter AND color), and the lenient
 * never-throwing parse. Property tests pin determinism and the "never throws,
 * never blank" contract across arbitrary inputs.
 */

// --- A small fixture pack ----------------------------------------------------

const PACK: LogoPack = {
  version: LOGO_PACK_SCHEMA_VERSION,
  generatedAt: "2026-10-18T00:00:00.000Z",
  note: "fixture",
  icons: {
    "netflix.com": { title: "Netflix", hex: "E50914", path: "M0 0h24v24H0z" },
    "youtube.com": { title: "YouTube", hex: "FF0000", path: "M1 1h22v22H1z" },
  },
};

// --- domainFromWebsite -------------------------------------------------------

describe("domainFromWebsite: normalize website → registrable domain", () => {
  it("strips scheme, www., path, query and fragment", () => {
    expect(domainFromWebsite("https://www.netflix.com/browse")).toBe("netflix.com");
    expect(domainFromWebsite("http://netflix.com")).toBe("netflix.com");
    expect(domainFromWebsite("netflix.com/title/80057281?x=1#frag")).toBe("netflix.com");
    expect(domainFromWebsite("//www.netflix.com")).toBe("netflix.com");
  });

  it("reduces a subdomain to the last two labels (registrable domain)", () => {
    expect(domainFromWebsite("music.youtube.com")).toBe("youtube.com");
    expect(domainFromWebsite("https://foo.bar.youtube.com/x")).toBe("youtube.com");
  });

  it("lowercases the host and drops userinfo + port", () => {
    expect(domainFromWebsite("NETFLIX.COM")).toBe("netflix.com");
    expect(domainFromWebsite("https://user@Netflix.com:443/path")).toBe("netflix.com");
  });

  it("returns null for empty / whitespace / dot-less / junk input", () => {
    expect(domainFromWebsite("")).toBeNull();
    expect(domainFromWebsite("   ")).toBeNull();
    expect(domainFromWebsite("acme")).toBeNull(); // no dot → not a registrable domain
    expect(domainFromWebsite("not a url")).toBeNull(); // whitespace in host
    // Not a string (defensive) → null, never a throw.
    expect(domainFromWebsite(undefined as unknown as string)).toBeNull();
  });
});

// --- letterTile --------------------------------------------------------------

describe("letterTile: deterministic lettered/colored fallback", () => {
  it("uses the first alphanumeric char, uppercased, from the trimmed name", () => {
    expect(letterTile("Netflix").letter).toBe("N");
    expect(letterTile("  netflix ").letter).toBe("N");
    expect(letterTile("37signals").letter).toBe("3");
    expect(letterTile("—Spotify").letter).toBe("S"); // skips leading symbol
  });

  it("falls back to '#' when the name has no alphanumeric character", () => {
    expect(letterTile("").letter).toBe("#");
    expect(letterTile("   ").letter).toBe("#");
    expect(letterTile("—–—").letter).toBe("#");
  });

  it("always picks a color from the warm palette", () => {
    for (const name of ["Netflix", "Spotify", "Acme", "", "zzz", "A"]) {
      expect(LETTER_TILE_PALETTE).toContain(letterTile(name).color);
    }
  });

  it("is case-insensitively deterministic (same name → same letter AND color)", () => {
    expect(letterTile("Netflix")).toEqual(letterTile("Netflix"));
    expect(letterTile("Netflix").color).toBe(letterTile("netflix").color);
    expect(letterTile("  Netflix  ").color).toBe(letterTile("netflix").color);
  });
});

// --- Palette accessibility (WCAG AA against the white letter) ----------------

describe("LETTER_TILE_PALETTE: every color clears WCAG AA against white text", () => {
  /** sRGB relative luminance (WCAG 2.x). `hex` is `#rrggbb`. */
  function relativeLuminance(hex: string): number {
    const c = hex.replace("#", "");
    const channels = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
    const linear = channels.map((v) =>
      v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4),
    );
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  }

  /** Contrast ratio of `hex` against pure white (#ffffff). */
  function contrastWithWhite(hex: string): number {
    const whiteL = 1; // relative luminance of #ffffff
    const L = relativeLuminance(hex);
    return (whiteL + 0.05) / (L + 0.05);
  }

  it("each palette color has ≥ 4.5:1 contrast against #ffffff (the white letter)", () => {
    for (const color of LETTER_TILE_PALETTE) {
      const ratio = contrastWithWhite(color);
      expect(
        ratio,
        `${color} contrast against white is ${ratio.toFixed(2)}:1 (needs ≥ 4.5)`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

// --- resolveLogo -------------------------------------------------------------

describe("resolveLogo: bundled → lettered fallback (this story's full order)", () => {
  it("bundled hit: a pack domain renders the bundled SVG mark", () => {
    const r = resolveLogo(PACK, { name: "Netflix", website: "https://www.netflix.com/browse" });
    expect(r.kind).toBe("bundled");
    if (r.kind === "bundled") {
      expect(r.title).toBe("Netflix");
      expect(r.hex).toBe("E50914");
      expect(r.path).toBe("M0 0h24v24H0z");
    }
  });

  it("bundled miss: an unknown domain falls back to the lettered tile", () => {
    const r = resolveLogo(PACK, { name: "Acme", website: "acme.example" });
    expect(r.kind).toBe("letter");
    if (r.kind === "letter") expect(r.letter).toBe("A");
  });

  it("empty website: falls back to the lettered tile keyed off the name", () => {
    const r = resolveLogo(PACK, { name: "Acme", website: "" });
    expect(r.kind).toBe("letter");
    if (r.kind === "letter") {
      expect(r.letter).toBe("A");
      expect(r).toEqual(resolveLogo(PACK, { name: "Acme", website: "" })); // deterministic
    }
  });

  it("failed/empty pack: every row shows the lettered fallback, no crash", () => {
    const r = resolveLogo(EMPTY_LOGO_PACK, { name: "Netflix", website: "https://netflix.com" });
    expect(r.kind).toBe("letter");
    if (r.kind === "letter") expect(r.letter).toBe("N");
  });

  it("same name → identical fallback across calls (determinism)", () => {
    const a = resolveLogo(EMPTY_LOGO_PACK, { name: "Disney Plus", website: "" });
    const b = resolveLogo(EMPTY_LOGO_PACK, { name: "Disney Plus", website: "https://x.invalid" });
    expect(a).toEqual(b);
  });
});

// --- parseLogoPack (lenient, never throws) -----------------------------------

describe("parseLogoPack: lenient — degrades to EMPTY on any defect, never throws", () => {
  it("parses a valid raw pack and lowercases domain keys", () => {
    const pack = parseLogoPack({
      version: 1,
      generatedAt: "2026-10-18T00:00:00.000Z",
      note: "n",
      icons: { "Netflix.com": { title: "Netflix", hex: "E50914", path: "M0 0h1v1H0z" } },
    });
    expect(Object.keys(pack.icons)).toEqual(["netflix.com"]);
    expect(pack.icons["netflix.com"].title).toBe("Netflix");
  });

  it("degrades to the EMPTY pack on a wrong version / shape / missing icons", () => {
    expect(parseLogoPack({ version: 2, icons: {} }).icons).toEqual({});
    expect(parseLogoPack({ version: 1 }).icons).toEqual({}); // no icons map
    expect(parseLogoPack(null).icons).toEqual({});
    expect(parseLogoPack("nope").icons).toEqual({});
    expect(parseLogoPack([]).icons).toEqual({});
  });

  it("skips individual malformed icon entries without blanking the pack", () => {
    const pack = parseLogoPack({
      version: 1,
      generatedAt: "",
      note: "",
      icons: {
        "netflix.com": { title: "Netflix", hex: "E50914", path: "M0 0h1v1H0z" },
        "bad.com": { title: "", hex: "zzz", path: "" }, // malformed → skipped
        "nohex.com": { title: "X", path: "M0z" }, // missing hex → skipped
      },
    });
    expect(Object.keys(pack.icons)).toEqual(["netflix.com"]);
  });
});

// --- Property tests ----------------------------------------------------------

describe("properties: determinism + never-blank + never-throws", () => {
  it("letterTile is deterministic and always returns a palette color + a single-char letter", () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        const a = letterTile(name);
        const b = letterTile(name);
        expect(a).toEqual(b); // same input → same output
        expect(LETTER_TILE_PALETTE).toContain(a.color);
        expect(a.letter.length).toBe(1);
      }),
    );
  });

  it("resolveLogo never throws and always returns a non-empty tile for any inputs", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (name, website) => {
        const r = resolveLogo(PACK, { name, website });
        if (r.kind === "letter") {
          expect(r.letter.length).toBe(1);
          expect(LETTER_TILE_PALETTE).toContain(r.color);
        } else {
          expect(r.path.length).toBeGreaterThan(0);
          expect(r.hex.length).toBeGreaterThan(0);
        }
      }),
    );
  });

  it("domainFromWebsite never throws for any string and lowercases its result", () => {
    fc.assert(
      fc.property(fc.string(), (website) => {
        const d = domainFromWebsite(website);
        if (d !== null) {
          expect(d).toBe(d.toLowerCase());
          expect(d.includes(".")).toBe(true);
        }
      }),
    );
  });

  it("a bundled hit via any scheme/subdomain/path for a packed domain always resolves bundled", () => {
    const prefixes = ["https://", "http://", "https://www.", "//", ""];
    const suffixes = ["", "/", "/browse", "?q=1", "#x", ":443/x"];
    fc.assert(
      fc.property(
        fc.constantFrom(...prefixes),
        fc.constantFrom(...suffixes),
        (prefix, suffix) => {
          const website = `${prefix}netflix.com${suffix}`;
          const r = resolveLogo(PACK, { name: "Netflix", website });
          expect(r.kind).toBe("bundled");
        },
      ),
    );
  });
});
