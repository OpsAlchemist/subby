import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Privacy checks (Task 30.2, Req 20.1–20.3).
 *
 * Subby is privacy-first and fully offline: it must operate with no analytics,
 * telemetry, or tracking (Req 20.1) and make no outbound internet request
 * (Req 20.2), storing data only on the local file system (Req 20.3). These are
 * static, source-level assertions (node environment): they scan the production
 * source trees and assert the absence of any network/telemetry usage, and they
 * read the renderer Content-Security-Policy and assert it blocks remote origins.
 *
 * The intent is ZERO outbound calls, so the assertions fail loudly if any
 * forbidden API or module ever appears in shipped source. Tests and
 * `node_modules` are excluded — only code that ships is scanned.
 */

// Repo root is the parent of this `tests/` directory.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Production source trees that ship in the app (Req 20: all must be clean). */
const SOURCE_DIRS = ["core", "electron", "src", "shared"] as const;

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/** A source file is excluded from the scan if it is itself a test/spec file. */
function isTestFile(path: string): boolean {
  return /\.(test|spec)\.[tj]sx?$/.test(path) || /(^|\/)tests?\//.test(path);
}

/** Recursively collect shippable source files under `dir`. */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // directory may not exist on every build
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git" || entry === "out") continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (SOURCE_EXTENSIONS.has(extname(full)) && !isTestFile(full)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Strip line and block comments so a benign mention of (say) `fetch` in a
 * JSDoc block never trips the scan. We remove block comments and any line that
 * is purely a comment (`//…` or a JSDoc `*` continuation). String literals on
 * code lines (e.g. a URL) are left intact — the call/import regexes are precise
 * enough that those do not match.
 */
function stripComments(source: string): string {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutBlocks
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*");
    })
    .join("\n");
}

/**
 * Forbidden runtime network APIs (Req 20.2). Matched as call/usage sites in
 * shippable code (after comment stripping).
 */
const FORBIDDEN_NETWORK_APIS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "fetch(", re: /\bfetch\s*\(/ },
  { name: "XMLHttpRequest", re: /\bXMLHttpRequest\b/ },
  { name: "WebSocket", re: /\bWebSocket\b/ },
  { name: "EventSource", re: /\bEventSource\b/ },
  { name: "navigator.sendBeacon", re: /\bsendBeacon\s*\(/ },
];

/**
 * Forbidden module specifiers (Req 20.1, 20.2): Node networking modules, HTTP
 * client libraries, and analytics/telemetry SDKs. Scoped packages match by
 * prefix. The app's own *spending* analytics lives in `core/analytics` and is
 * NOT a telemetry SDK, so we match concrete tracking package names only.
 */
const FORBIDDEN_EXACT_MODULES = new Set<string>([
  // Node networking
  "http",
  "https",
  "net",
  "dgram",
  "dns",
  "tls",
  "http2",
  "node:http",
  "node:https",
  "node:net",
  "node:dgram",
  "node:dns",
  "node:tls",
  "node:http2",
  // HTTP client libraries
  "axios",
  "node-fetch",
  "got",
  "superagent",
  "ky",
  "undici",
  "request",
  // Analytics / telemetry SDKs
  "mixpanel",
  "mixpanel-browser",
  "posthog-js",
  "posthog-node",
  "amplitude-js",
  "analytics-node",
  "react-ga",
  "react-ga4",
  "@vercel/analytics",
]);

/** Scoped/prefix telemetry packages that must never be imported. */
const FORBIDDEN_MODULE_PREFIXES = [
  "@sentry/",
  "@amplitude/",
  "@segment/",
  "@google-analytics/",
  "@posthog/",
] as const;

function isForbiddenModule(spec: string): boolean {
  if (FORBIDDEN_EXACT_MODULES.has(spec)) return true;
  return FORBIDDEN_MODULE_PREFIXES.some((p) => spec.startsWith(p));
}

/** Extract every module specifier from `import ... from "x"` / `require("x")` / dynamic `import("x")`. */
function extractModuleSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re =
    /(?:import[\s\S]*?from\s*|(?:^|[^.\w])(?:require|import)\s*\(\s*)["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    specs.push(m[1]);
  }
  return specs;
}

// --- Source scan (Req 20.1, 20.2, 20.3) --------------------------------------

describe("Privacy: no network or telemetry in shippable source (Req 20.1, 20.2)", () => {
  const files = SOURCE_DIRS.flatMap((d) => collectSourceFiles(join(ROOT, d)));

  it("scans a non-trivial set of source files", () => {
    // Guard against the walker silently finding nothing (which would make the
    // remaining assertions vacuously pass).
    expect(files.length).toBeGreaterThan(10);
  });

  it("contains no forbidden network API calls (fetch/XHR/WebSocket/sendBeacon)", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const api of FORBIDDEN_NETWORK_APIS) {
        if (api.re.test(code)) {
          offenders.push(`${relative(ROOT, file)} → ${api.name}`);
        }
      }
    }
    expect(offenders, `Unexpected network API usage:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("imports no network, HTTP-client, or telemetry modules", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const spec of extractModuleSpecifiers(code)) {
        if (isForbiddenModule(spec)) {
          offenders.push(`${relative(ROOT, file)} → ${spec}`);
        }
      }
    }
    expect(offenders, `Forbidden module imports:\n${offenders.join("\n")}`).toEqual([]);
  });
});

// --- Renderer CSP blocks remote origins (Req 20.2) ---------------------------

/** Pull a single directive's value out of a CSP string. */
function cspDirective(csp: string, directive: string): string | null {
  const match = csp.match(new RegExp(`${directive}\\s+([^;]+)`));
  return match ? match[1].trim() : null;
}

describe("Privacy: renderer CSP disallows remote origins (Req 20.2)", () => {
  it("the index.html meta CSP sets default-src 'self' and never allows http(s) connect-src", () => {
    const html = readFileSync(join(ROOT, "src", "index.html"), "utf8");
    const cspMatch = html.match(
      /http-equiv="Content-Security-Policy"\s*content="([^"]+)"/,
    );
    expect(cspMatch, "index.html must declare a meta CSP").not.toBeNull();
    const csp = cspMatch![1];

    expect(cspDirective(csp, "default-src")).toBe("'self'");

    const connect = cspDirective(csp, "connect-src");
    expect(connect, "CSP must declare connect-src").not.toBeNull();
    // No remote http(s) origins may be permitted (ws:/wss: support dev HMR only).
    expect(connect).not.toMatch(/https?:/);

    expect(cspDirective(csp, "object-src")).toBe("'none'");
  });

  it("the production CSP in electron/main.ts restricts connect-src to 'self' and sets object-src 'none'", () => {
    const main = readFileSync(join(ROOT, "electron", "main.ts"), "utf8");
    // Locate the PROD_CSP string literal: one or more double-quoted fragments
    // joined by `+`, terminated by `;`. The `;` directive separators inside the
    // string never match because they sit inside the `[^"]*` fragment bodies.
    const prodMatch = main.match(
      /const\s+PROD_CSP\s*=\s*((?:"[^"]*"\s*\+?\s*)+);/,
    );
    expect(prodMatch, "main.ts must define PROD_CSP").not.toBeNull();
    // Reconstruct the literal by joining the quoted string fragments.
    const fragments = prodMatch![1].match(/"([^"]*)"/g) ?? [];
    const csp = fragments.map((f) => f.slice(1, -1)).join("");

    expect(csp.length).toBeGreaterThan(0);
    expect(cspDirective(csp, "default-src")).toBe("'self'");
    expect(cspDirective(csp, "connect-src")).toBe("'self'");
    // Remote origins of any scheme are forbidden in production.
    expect(csp).not.toMatch(/https?:/);
    expect(csp).not.toMatch(/\bws{1,2}:/);
    expect(cspDirective(csp, "object-src")).toBe("'none'");
  });
});

// --- Local-only storage (Req 20.3) -------------------------------------------

describe("Privacy: storage is local-file-only (Req 20.3)", () => {
  it("the Electron storage adapter uses node:fs and no network module", () => {
    const storageDir = join(ROOT, "electron", "storage");
    const files = collectSourceFiles(storageDir);
    expect(files.length).toBeGreaterThan(0);

    let usesFs = false;
    for (const file of files) {
      const code = stripComments(readFileSync(file, "utf8"));
      const specs = extractModuleSpecifiers(code);
      if (specs.some((s) => s === "node:fs" || s === "fs" || s.startsWith("node:fs"))) {
        usesFs = true;
      }
      // Re-assert: storage must not reach for any network module.
      for (const spec of specs) {
        expect(isForbiddenModule(spec), `${relative(ROOT, file)} imports ${spec}`).toBe(
          false,
        );
      }
    }
    expect(usesFs, "storage adapter should read/write via node:fs").toBe(true);
  });
});
