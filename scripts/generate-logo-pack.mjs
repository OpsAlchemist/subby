/**
 * Devtime Logo Pack generator (Story 8.3; AD-25, SM-C2).
 *
 * NOT shipped: this script runs only at author time (`npm run logopack:generate`)
 * and is deliberately OUTSIDE the privacy-scanned source trees (`core`/`electron`/
 * `src`/`shared`). It imports `simple-icons` — a **devDependency** — to read the
 * curated brands' 24×24 single-path SVGs and brand hex, then writes the committed
 * `resources/logo-pack.json`. The shipped app NEVER imports `simple-icons`; it
 * reads only the generated JSON via the resource reader.
 *
 * Why a curated subset (AD-25 / SM-C2 — "lightness is the product"): the full
 * ~3,400-icon Simple Icons catalog would bloat the install. We ship a curated
 * top ~200 common streaming / music / software / cloud / news / gaming / finance
 * services, well under the ~1MB / ≤250-icon budget the size-guard test enforces.
 *
 * Determinism: {@link CURATED} is sorted and de-duplicated, and icons are written
 * in sorted-domain order, so a clean re-run produces a byte-identical file (the
 * `generatedAt` field is pinned to the pack's logical date, NOT `Date.now()`, so
 * re-running does not churn the committed asset).
 *
 * Brand-removal path (documented in docs/privacy-and-security.md): to drop a
 * brand, remove its line from {@link CURATED} and re-run, OR delete its entry
 * from `resources/logo-pack.json` directly. Simple Icons honors brand-removal
 * requests; this keeps Subby able to comply without shipping the full catalog.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as simpleIcons from "simple-icons";

const SCHEMA_VERSION = 1;

// The logical "as of" date of this curated pack. Pinned (not Date.now()) so a
// clean re-run is byte-identical and never churns the committed asset.
const GENERATED_AT = "2026-10-18T00:00:00.000Z";

const NOTE =
  "Curated subset of Simple Icons (https://simpleicons.org), CC0 1.0 Universal. " +
  "Logos are brand trademarks of their respective owners. To remove a brand, " +
  "delete its entry here or remove it from scripts/generate-logo-pack.mjs and " +
  "regenerate. See docs/privacy-and-security.md.";

/**
 * The curated brand list: `[simpleIconsSlug, registrableDomain]`.
 *
 * The domain is the registrable domain `core/logo.ts:domainFromWebsite` yields
 * from a subscription's `website` (lowercased, last two labels), so a row whose
 * website is this brand resolves to this icon. Keep this sorted-ish and grouped
 * by category for maintenance; the generator sorts + de-dupes before writing.
 */
const CURATED = [
  // NOTE: some ubiquitous brands (Hulu, Disney+, Slack, Adobe, OpenAI, Amazon,
  // Microsoft, LinkedIn, Xbox, Nintendo, Twilio, etc.) are intentionally ABSENT:
  // Simple Icons removed them on brand-removal / trademark grounds, so they are
  // not in the CC0 catalog. Those rows get the deterministic lettered fallback —
  // which is exactly the AD-25 removal path working as designed. Only slugs that
  // exist in the installed `simple-icons` devDep are listed; the generator warns
  // (author-time only) on any slug it cannot resolve.

  // --- Streaming video ---
  ["netflix", "netflix.com"],
  ["youtube", "youtube.com"],
  ["hbo", "hbo.com"],
  ["max", "max.com"],
  ["paramountplus", "paramountplus.com"],
  ["crunchyroll", "crunchyroll.com"],
  ["twitch", "twitch.tv"],
  ["vimeo", "vimeo.com"],
  ["plex", "plex.tv"],
  ["dazn", "dazn.com"],
  ["mubi", "mubi.com"],
  ["imdb", "imdb.com"],
  ["letterboxd", "letterboxd.com"],
  ["rottentomatoes", "rottentomatoes.com"],

  // --- Music / audio / podcasts ---
  ["spotify", "spotify.com"],
  ["tidal", "tidal.com"],
  ["deezer", "deezer.com"],
  ["soundcloud", "soundcloud.com"],
  ["pandora", "pandora.com"],
  ["audible", "audible.com"],
  ["bandcamp", "bandcamp.com"],
  ["lastdotfm", "last.fm"],
  ["overcast", "overcast.fm"],
  ["pocketcasts", "pocketcasts.com"],

  // --- Software / productivity ---
  ["notion", "notion.so"],
  ["figma", "figma.com"],
  ["framer", "framer.com"],
  ["grammarly", "grammarly.com"],
  ["evernote", "evernote.com"],
  ["todoist", "todoist.com"],
  ["trello", "trello.com"],
  ["asana", "asana.com"],
  ["clickup", "clickup.com"],
  ["airtable", "airtable.com"],
  ["miro", "miro.com"],
  ["zoom", "zoom.us"],
  ["dropbox", "dropbox.com"],
  ["box", "box.com"],
  ["icloud", "icloud.com"],
  ["mega", "mega.io"],
  ["lastpass", "lastpass.com"],
  ["bitwarden", "bitwarden.com"],
  ["1password", "1password.com"],
  ["dashlane", "dashlane.com"],
  ["nordvpn", "nordvpn.com"],
  ["expressvpn", "expressvpn.com"],
  ["protonvpn", "protonvpn.com"],
  ["proton", "proton.me"],
  ["malwarebytes", "malwarebytes.com"],
  ["backblaze", "backblaze.com"],
  ["obsidian", "obsidian.md"],
  ["logseq", "logseq.com"],
  ["anytype", "anytype.io"],
  ["joplin", "joplinapp.org"],
  ["linear", "linear.app"],
  ["loom", "loom.com"],
  ["calendly", "calendly.com"],
  ["zapier", "zapier.com"],
  ["ifttt", "ifttt.com"],
  ["mailchimp", "mailchimp.com"],
  ["sentry", "sentry.io"],
  ["jira", "jira.com"],
  ["confluence", "confluence.com"],
  ["basecamp", "basecamp.com"],
  ["wetransfer", "wetransfer.com"],
  ["instapaper", "instapaper.com"],
  ["webflow", "webflow.com"],
  ["wix", "wix.com"],
  ["duckduckgo", "duckduckgo.com"],
  ["brave", "brave.com"],
  ["firefox", "firefox.com"],
  ["opera", "opera.com"],
  ["vivaldi", "vivaldi.com"],

  // --- Developer / cloud / data ---
  ["github", "github.com"],
  ["gitlab", "gitlab.com"],
  ["bitbucket", "bitbucket.org"],
  ["vercel", "vercel.com"],
  ["netlify", "netlify.com"],
  ["cloudflare", "cloudflare.com"],
  ["digitalocean", "digitalocean.com"],
  ["railway", "railway.app"],
  ["vultr", "vultr.com"],
  ["namecheap", "namecheap.com"],
  ["godaddy", "godaddy.com"],
  ["mongodb", "mongodb.com"],
  ["supabase", "supabase.com"],
  ["planetscale", "planetscale.com"],
  ["firebase", "firebase.com"],
  ["redis", "redis.io"],
  ["postgresql", "postgresql.org"],
  ["mysql", "mysql.com"],
  ["sqlite", "sqlite.org"],
  ["cockroachlabs", "cockroachlabs.com"],
  ["neo4j", "neo4j.com"],
  ["influxdb", "influxdata.com"],
  ["clickhouse", "clickhouse.com"],
  ["snowflake", "snowflake.com"],
  ["databricks", "databricks.com"],
  ["jetbrains", "jetbrains.com"],
  ["docker", "docker.com"],
  ["postman", "postman.com"],
  ["stripe", "stripe.com"],
  ["anthropic", "anthropic.com"],
  ["perplexity", "perplexity.ai"],
  ["huggingface", "huggingface.co"],
  ["replit", "replit.com"],
  ["render", "render.com"],
  ["fastly", "fastly.com"],
  ["elastic", "elastic.co"],
  ["datadog", "datadoghq.com"],
  ["pagerduty", "pagerduty.com"],
  ["newrelic", "newrelic.com"],
  ["grafana", "grafana.com"],
  ["algolia", "algolia.com"],
  ["circleci", "circleci.com"],
  ["jenkins", "jenkins.io"],
  ["terraform", "terraform.io"],
  ["ansible", "ansible.com"],
  ["deno", "deno.com"],
  ["bun", "bun.sh"],
  ["pnpm", "pnpm.io"],
  ["rust", "rust-lang.org"],

  // --- Analytics / support / marketing SaaS ---
  ["mixpanel", "mixpanel.com"],
  ["posthog", "posthog.com"],
  ["plausibleanalytics", "plausible.io"],
  ["matomo", "matomo.org"],
  ["hotjar", "hotjar.com"],
  ["intercom", "intercom.com"],
  ["zendesk", "zendesk.com"],
  ["helpscout", "helpscout.com"],
  ["hubspot", "hubspot.com"],
  ["mailgun", "mailgun.com"],
  ["resend", "resend.com"],
  ["buffer", "buffer.com"],
  ["hootsuite", "hootsuite.com"],
  ["typeform", "typeform.com"],
  ["surveymonkey", "surveymonkey.com"],

  // --- News / reading / writing ---
  ["medium", "medium.com"],
  ["substack", "substack.com"],
  ["wordpress", "wordpress.com"],
  ["ghost", "ghost.org"],
  ["feedly", "feedly.com"],
  ["goodreads", "goodreads.com"],
  ["discourse", "discourse.org"],

  // --- Gaming ---
  ["steam", "steampowered.com"],
  ["epicgames", "epicgames.com"],
  ["playstation", "playstation.com"],
  ["ea", "ea.com"],
  ["ubisoft", "ubisoft.com"],
  ["roblox", "roblox.com"],
  ["discord", "discord.com"],
  ["gogdotcom", "gog.com"],
  ["humblebundle", "humblebundle.com"],

  // --- Fitness / health / learning ---
  ["strava", "strava.com"],
  ["peloton", "onepeloton.com"],
  ["fitbit", "fitbit.com"],
  ["headspace", "headspace.com"],
  ["duolingo", "duolingo.com"],

  // --- Finance / commerce / creator ---
  ["paypal", "paypal.com"],
  ["patreon", "patreon.com"],
  ["kofi", "ko-fi.com"],
  ["buymeacoffee", "buymeacoffee.com"],
  ["opencollective", "opencollective.com"],
  ["gumroad", "gumroad.com"],
  ["lemonsqueezy", "lemonsqueezy.com"],
  ["paddle", "paddle.com"],
  ["shopify", "shopify.com"],
  ["squarespace", "squarespace.com"],
  ["wise", "wise.com"],
  ["revolut", "revolut.com"],
  ["coinbase", "coinbase.com"],
  ["quickbooks", "intuit.com"],
  ["xero", "xero.com"],
  ["gusto", "gusto.com"],

  // --- Platforms / misc consumer ---
  ["google", "google.com"],
  ["apple", "apple.com"],
  ["x", "x.com"],
  ["reddit", "reddit.com"],
  ["pinterest", "pinterest.com"],
  ["instagram", "instagram.com"],
  ["facebook", "facebook.com"],
  ["snapchat", "snapchat.com"],
  ["tiktok", "tiktok.com"],
  ["telegram", "telegram.org"],
  ["whatsapp", "whatsapp.com"],
  ["signal", "signal.org"],
  ["coursera", "coursera.org"],
  ["udemy", "udemy.com"],
  ["skillshare", "skillshare.com"],
  ["codecademy", "codecademy.com"],
  ["pluralsight", "pluralsight.com"],
  ["frontendmentor", "frontendmentor.io"],
  ["leetcode", "leetcode.com"],
  ["kaggle", "kaggle.com"],
  ["wikipedia", "wikipedia.org"],
];

/**
 * Convert a Simple Icons slug to its exported `si<...>` key. simple-icons
 * exports each icon under `si` + the slug with only its FIRST character
 * uppercased and the rest left as-is ("1password" -> "si1password",
 * "gogdotcom" -> "siGogdotcom"). It does NOT PascalCase word boundaries, so a
 * multi-word slug keeps the derived key simple; the `main()` loop falls back to
 * a `.slug` scan for the rare case the derived key does not match.
 */
function slugToExportKey(slug) {
  return "si" + slug.charAt(0).toUpperCase() + slug.slice(1);
}

/**
 * The registrable-domain reduction `core/logo.ts:domainFromWebsite` applies
 * (last two non-empty labels). A CURATED domain that is NOT equal to its own
 * reduction can NEVER be produced from a `website`, so it is a dead, unreachable
 * key — the generator rejects it loudly below.
 */
function registrableReduction(domain) {
  const labels = domain.split(".").filter((l) => l.length > 0);
  return labels.slice(-2).join(".");
}

function main() {
  // De-dupe by domain and sort by domain for a deterministic file.
  const byDomain = new Map();
  const missing = [];
  const unreachable = [];
  const collisions = [];

  for (const [slug, domain] of CURATED) {
    const key = domain.toLowerCase();

    // GUARD 1: reject an unreachable subdomain key — one that domainFromWebsite
    // can never produce, so the icon would be dead weight (and a popular sub
    // would silently fall back). Author-time only; the shipped app never runs this.
    if (key !== registrableReduction(key)) {
      unreachable.push(`${slug} → "${key}" (reduces to "${registrableReduction(key)}")`);
    }

    const icon =
      simpleIcons[slugToExportKey(slug)] ??
      // Fallback: some slugs may differ from the derived key; try a scan.
      Object.values(simpleIcons).find(
        (v) => v && typeof v === "object" && v.slug === slug,
      );
    if (!icon || typeof icon.path !== "string") {
      missing.push(`${slug} (${domain})`);
      continue;
    }

    // GUARD 2: a loud warning on a duplicate registrable domain — two curated
    // brands collapsing onto one key would make the Map silently last-wins, so
    // one brand's mark would overwrite the other. Surface it instead of hiding it.
    if (byDomain.has(key)) {
      collisions.push(`"${key}": "${byDomain.get(key).title}" overwritten by "${icon.title}" (${slug})`);
    }

    byDomain.set(key, {
      title: icon.title,
      hex: icon.hex,
      path: icon.path,
    });
  }

  if (missing.length > 0) {
    // Loud at author time only — never affects the shipped app.
    console.error(
      `WARNING: ${missing.length} curated slug(s) not found in simple-icons:\n  ` +
        missing.join("\n  "),
    );
  }
  if (collisions.length > 0) {
    console.error(
      `WARNING: ${collisions.length} duplicate registrable domain(s) (last-wins):\n  ` +
        collisions.join("\n  "),
    );
  }
  // An unreachable subdomain key is a defect, not a warning: fail the generator
  // so the committed pack can never carry a dead key.
  if (unreachable.length > 0) {
    console.error(
      `ERROR: ${unreachable.length} curated domain(s) are unreachable subdomains ` +
        `(domainFromWebsite can never produce them):\n  ` +
        unreachable.join("\n  "),
    );
    process.exit(1);
  }

  const sortedDomains = [...byDomain.keys()].sort();
  const icons = {};
  for (const domain of sortedDomains) icons[domain] = byDomain.get(domain);

  const pack = {
    version: SCHEMA_VERSION,
    generatedAt: GENERATED_AT,
    note: NOTE,
    icons,
  };

  const here = dirname(fileURLToPath(import.meta.url));
  const outPath = join(here, "..", "resources", "logo-pack.json");
  mkdirSync(dirname(outPath), { recursive: true });
  // Two-space indent + trailing newline, matching the repo's JSON asset style.
  writeFileSync(outPath, JSON.stringify(pack, null, 2) + "\n", "utf8");

  const bytes = Buffer.byteLength(JSON.stringify(pack, null, 2) + "\n", "utf8");
  console.log(
    `Wrote ${outPath}\n  icons: ${sortedDomains.length}\n  size:  ${(bytes / 1024).toFixed(1)} KB`,
  );
}

main();
