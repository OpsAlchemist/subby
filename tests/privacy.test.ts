import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildCsp } from "../electron/net/csp";

/**
 * Privacy checks (Task 30.2, Req 20.1–20.3; reworked for Epic 8 / Story 8.1).
 *
 * Subby is privacy-first and private-by-default. Through 1.0 it was fully
 * offline; Epic 8 introduces the FIRST outbound network behind ONE audited
 * boundary (`electron/net/`). These static, source-level assertions are the
 * headline privacy gate (node environment): they scan the production source
 * trees and prove the net boundary holds.
 *
 * The gate has three parts:
 *   1. Network primitives (`fetch`/XHR/WebSocket/EventSource) and networking /
 *      HTTP-client MODULES may appear ONLY under `electron/net/` — the single
 *      audited site. Anywhere else is a failure that names the offending file.
 *   2. Telemetry / tracking / `sendBeacon` are banned EVERYWHERE, INCLUDING
 *      inside `electron/net/` — that ban is permanent and never gated. The net
 *      module may fetch, but it may never beacon or pull an analytics SDK.
 *   3. The dynamic production CSP (`buildCsp`) carries NO remote origin while
 *      the online toggles are off: `connect-src` is exactly `'self'`, byte-
 *      identical to the fully-offline 1.0 policy.
 *
 * Tests and `node_modules` are excluded — only code that ships is scanned.
 */

// Repo root is the parent of this `tests/` directory.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Production source trees that ship in the app (Req 20: all must be clean). */
const SOURCE_DIRS = ["core", "electron", "src", "shared"] as const;

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/**
 * The ONE audited network-primitive SITE (AD-5): `electron/net/gateway.ts` is
 * the SOLE file where a network primitive or networking/HTTP-client module may
 * appear — NOT the whole `electron/net/` directory. A future sibling under
 * `net/` (csp.ts, hosts.ts, index.ts, or a new one) that adds a raw `fetch(`
 * must still fail the scan. Path is normalized to the OS separator so the check
 * holds on Windows too.
 */
const GATEWAY_FILE = join("electron", "net", "gateway.ts");

/** True ONLY for the single audited gateway file (AD-5). */
function isGatewayFile(file: string): boolean {
  return relative(ROOT, file) === GATEWAY_FILE;
}

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
 * shippable code (after comment stripping). Allowed ONLY under `electron/net/`
 * (the single audited boundary); banned everywhere else.
 *
 * NOTE: `sendBeacon` is deliberately NOT here — it is a TELEMETRY surface, not a
 * legitimate data-fetch primitive, so it is banned EVERYWHERE including inside
 * `net/` (see {@link TELEMETRY_APIS}).
 */
const FORBIDDEN_NETWORK_APIS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "fetch(", re: /\bfetch\s*\(/ },
  { name: "XMLHttpRequest", re: /\bXMLHttpRequest\b/ },
  { name: "WebSocket", re: /\bWebSocket\b/ },
  { name: "EventSource", re: /\bEventSource\b/ },
];

/**
 * Telemetry / tracking APIs banned EVERYWHERE — including inside `electron/net/`.
 * This ban is permanent and never gated: the net module may fetch, but it may
 * never beacon out. `sendBeacon` is the canonical fire-and-forget tracking
 * primitive, so it belongs here and not in {@link FORBIDDEN_NETWORK_APIS}.
 */
const TELEMETRY_APIS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "navigator.sendBeacon", re: /\bsendBeacon\s*\(/ },
];

/**
 * Forbidden networking / HTTP-client MODULE specifiers (Req 20.2): Node
 * networking modules and HTTP client libraries. Allowed ONLY under
 * `electron/net/`; banned everywhere else.
 */
const NETWORK_MODULES = new Set<string>([
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
]);

/**
 * Telemetry / analytics MODULE specifiers banned EVERYWHERE — including inside
 * `electron/net/`. The app's own *spending* analytics lives in `core/analytics`
 * and is NOT a telemetry SDK, so we match concrete tracking package names only.
 */
const TELEMETRY_EXACT_MODULES = new Set<string>([
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

/** Scoped/prefix telemetry packages that must never be imported, anywhere. */
const TELEMETRY_MODULE_PREFIXES = [
  "@sentry/",
  "@amplitude/",
  "@segment/",
  "@google-analytics/",
  "@posthog/",
] as const;

/** True for a networking/HTTP-client module (allowed only under `net/`). */
function isNetworkModule(spec: string): boolean {
  return NETWORK_MODULES.has(spec);
}

/** True for a telemetry/analytics module (banned everywhere). */
function isTelemetryModule(spec: string): boolean {
  if (TELEMETRY_EXACT_MODULES.has(spec)) return true;
  return TELEMETRY_MODULE_PREFIXES.some((p) => spec.startsWith(p));
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

// --- Source scan (Req 20.1, 20.2, 20.3; AD-5) --------------------------------

describe("Privacy: network confined to electron/net, telemetry banned everywhere (Req 20.1, 20.2, AD-5)", () => {
  const files = SOURCE_DIRS.flatMap((d) => collectSourceFiles(join(ROOT, d)));

  it("scans a non-trivial set of source files", () => {
    // Guard against the walker silently finding nothing (which would make the
    // remaining assertions vacuously pass).
    expect(files.length).toBeGreaterThan(10);
  });

  it("confines network API calls (fetch/XHR/WebSocket/EventSource) to electron/net/gateway.ts", () => {
    const offenders: string[] = [];
    for (const file of files) {
      // Network PRIMITIVES are allowed in the one audited FILE only (AD-5) —
      // not the whole net/ directory. A sibling net/ file adding a primitive
      // must still be caught here.
      if (isGatewayFile(file)) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      for (const api of FORBIDDEN_NETWORK_APIS) {
        if (api.re.test(code)) {
          offenders.push(`${relative(ROOT, file)} → ${api.name}`);
        }
      }
    }
    expect(
      offenders,
      `Network API outside electron/net/gateway.ts:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("confines network / HTTP-client module imports to electron/net/gateway.ts", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (isGatewayFile(file)) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      for (const spec of extractModuleSpecifiers(code)) {
        if (isNetworkModule(spec)) {
          offenders.push(`${relative(ROOT, file)} → ${spec}`);
        }
      }
    }
    expect(
      offenders,
      `Network/HTTP-client module outside electron/net/gateway.ts:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("bans telemetry / sendBeacon EVERYWHERE, including inside electron/net", () => {
    const offenders: string[] = [];
    for (const file of files) {
      // NO exception for electron/net here — the telemetry ban is permanent.
      const code = stripComments(readFileSync(file, "utf8"));
      for (const api of TELEMETRY_APIS) {
        if (api.re.test(code)) {
          offenders.push(`${relative(ROOT, file)} → ${api.name}`);
        }
      }
      for (const spec of extractModuleSpecifiers(code)) {
        if (isTelemetryModule(spec)) {
          offenders.push(`${relative(ROOT, file)} → ${spec}`);
        }
      }
    }
    expect(
      offenders,
      `Telemetry/tracking usage (banned everywhere):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("exempts ONLY gateway.ts, not sibling net/ files — a primitive in net/csp.ts would be caught", () => {
    // gateway.ts is exempt; its siblings are NOT (AD-5: gateway is the sole site).
    expect(isGatewayFile(join(ROOT, "electron", "net", "gateway.ts"))).toBe(true);
    for (const sibling of ["csp.ts", "hosts.ts", "index.ts", "future.ts"]) {
      expect(
        isGatewayFile(join(ROOT, "electron", "net", sibling)),
        `${sibling} must NOT be exempt`,
      ).toBe(false);
    }

    // The scan the confinement test runs: a `fetch(` found in a non-gateway net
    // file is scanned (not skipped) and therefore flagged as an offender.
    const siblingFile = join(ROOT, "electron", "net", "csp.ts");
    const synthetic = stripComments("export const f = () => fetch('https://x');");
    const flagged = !isGatewayFile(siblingFile)
      ? FORBIDDEN_NETWORK_APIS.some((api) => api.re.test(synthetic))
      : false;
    expect(flagged, "a primitive in net/csp.ts must be caught").toBe(true);
  });
});

// --- Renderer / production CSP blocks remote origins (Req 20.2, AD-7) --------

/** Pull a single directive's value out of a CSP string. */
function cspDirective(csp: string, directive: string): string | null {
  const match = csp.match(new RegExp(`${directive}\\s+([^;]+)`));
  return match ? match[1].trim() : null;
}

describe("Privacy: CSP disallows remote origins while online toggles are off (Req 20.2, AD-7)", () => {
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

  it("buildCsp with both online toggles off yields connect-src 'self' and no remote origin", () => {
    // The dynamic production CSP is settings-driven (AD-7): with every online
    // feature off it must be byte-identical to the fully-offline 1.0 policy.
    const csp = buildCsp({ liveLogoFetch: false, fxRefresh: false });

    expect(csp.length).toBeGreaterThan(0);
    expect(cspDirective(csp, "default-src")).toBe("'self'");
    expect(cspDirective(csp, "connect-src")).toBe("'self'");
    // Remote origins of any scheme are forbidden while toggles are off.
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
      // Re-assert: storage must not reach for any network or telemetry module.
      for (const spec of specs) {
        expect(
          isNetworkModule(spec) || isTelemetryModule(spec),
          `${relative(ROOT, file)} imports ${spec}`,
        ).toBe(false);
      }
    }
    expect(usesFs, "storage adapter should read/write via node:fs").toBe(true);
  });
});
