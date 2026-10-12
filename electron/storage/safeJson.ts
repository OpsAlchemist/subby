/**
 * Safe JSON read/write primitives (Req 19.1, 19.2, 19.3).
 *
 * Electron MAIN process module. Node imports (`node:fs/promises`, `node:path`)
 * are allowed here.
 *
 * Reading a data file must NEVER throw or crash the app (Req 19.1). Instead,
 * `safeReadJson` returns a discriminated `SafeReadResult` describing one of:
 *   - `missing`   : the file does not exist (the adapter recreates defaults,
 *                   Req 19.3),
 *   - `malformed` : the bytes are not valid JSON (Req 19.1),
 *   - `corrupt`   : valid JSON but fails schema validation (Req 19.2, offer
 *                   restore from latest backup).
 *
 * Writes are atomic: data is written to a temp file in the same directory and
 * then renamed over the target, so an interrupted write cannot leave a
 * partially written (and therefore corrupt) target file.
 */

import { randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Result of a safe read. On success carries the validated value; on failure
 * carries a machine-readable reason and (when available) the raw file contents
 * so the caller can surface diagnostics or offer recovery.
 */
export type SafeReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "missing" | "malformed" | "corrupt"; raw?: string };

/**
 * Result of a version-aware safe read (AD-15). On success it carries the
 * **parsed-but-not-yet-schema-validated** JSON object together with its detected
 * on-disk `version`, deferring the choice of which schema to validate against to
 * the caller — the migrate-before-validate read path (Story 1.4) needs the
 * version *before* it can pick a schema. On failure it carries the same
 * machine-readable reason as {@link SafeReadResult}.
 *
 *   - `missing`   : the file does not exist (ENOENT).
 *   - `malformed` : not valid JSON, unreadable, not a JSON object, or missing a
 *                   usable integer `version` field. A versioned data file that
 *                   carries no detectable version cannot be gated and is treated
 *                   as unreadable rather than silently assumed to be any version.
 *
 * There is no `corrupt` reason here: schema validation (the only thing that can
 * yield `corrupt`) is deliberately deferred to the caller, which runs it against
 * the version-appropriate schema and raises its own typed error.
 */
export type SafeReadVersionedResult =
  | { ok: true; value: Record<string, unknown>; version: number }
  | { ok: false; reason: "missing" | "malformed"; raw?: string };

/** Node error shape with an errno `code` (e.g. `ENOENT`). */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string"
  );
}

/**
 * Read and validate a JSON file without ever throwing.
 *
 * @param file     Absolute path to the JSON file.
 * @param validate A function (typically a zod `parse`) that validates the
 *                 parsed data and returns the typed value, or throws on
 *                 invalid shape.
 * @returns A `SafeReadResult<T>`:
 *   - `{ ok: true, value }`                         when read + parse + validate succeed,
 *   - `{ ok: false, reason: "missing" }`            when the file does not exist (Req 19.3),
 *   - `{ ok: false, reason: "malformed", raw }`     when `JSON.parse` throws (Req 19.1),
 *   - `{ ok: false, reason: "corrupt", raw }`       when `validate` throws (Req 19.2).
 */
export async function safeReadJson<T>(
  file: string,
  validate: (data: unknown) => T,
): Promise<SafeReadResult<T>> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") {
      return { ok: false, reason: "missing" };
    }
    // Any other read error (permissions, etc.) is treated as malformed/unreadable
    // rather than crashing the app (Req 19.1).
    return { ok: false, reason: "malformed" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, reason: "malformed", raw };
  }

  try {
    const value = validate(parsed);
    return { ok: true, value };
  } catch {
    return { ok: false, reason: "corrupt", raw };
  }
}

/**
 * Read a JSON file and detect its on-disk `version` **without** validating it
 * against any particular schema (AD-15). This is the version-detection seam the
 * migrate-before-validate read path needs: it must know a file's version before
 * it can decide whether to migrate, validate at the current version, or refuse a
 * newer file — so schema choice is deferred to the caller.
 *
 * Like {@link safeReadJson}, this never throws; it classifies failures. The
 * only reasons returned are `missing` (ENOENT) and `malformed` (unreadable, not
 * valid JSON, not a JSON object, or carrying no usable integer `version`). It
 * never returns `corrupt`: schema validation — the sole source of `corrupt` — is
 * the caller's responsibility, run against the version-appropriate schema.
 *
 * @param file Absolute path to the JSON file.
 * @returns A {@link SafeReadVersionedResult}:
 *   - `{ ok: true, value, version }`               parsed object + its detected `version`,
 *   - `{ ok: false, reason: "missing" }`           the file does not exist,
 *   - `{ ok: false, reason: "malformed", raw }`    unreadable / not JSON / not an
 *                                                  object / no integer `version`.
 */
export async function safeReadVersionedJson(
  file: string,
): Promise<SafeReadVersionedResult> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") {
      return { ok: false, reason: "missing" };
    }
    return { ok: false, reason: "malformed" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, reason: "malformed", raw };
  }

  // A versioned data file must be a JSON object carrying a non-negative integer
  // `version`. Anything else (array, primitive, null, or a missing/non-integer
  // version) cannot be version-gated, so it is treated as unreadable rather than
  // silently assumed to be any particular version. Schema validation at the
  // target version still runs afterwards in the caller and will reject other
  // shape problems as `corrupt`.
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return { ok: false, reason: "malformed", raw };
  }
  const obj = parsed as Record<string, unknown>;
  const version = obj.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    return { ok: false, reason: "malformed", raw };
  }

  return { ok: true, value: obj, version };
}

/**
 * Atomically write a value as pretty-printed JSON to `file` (Req 19).
 *
 * Ensures the parent directory exists, writes to a unique temp file in the
 * same directory, then renames it over the target. The rename is atomic on the
 * same filesystem, so a crash mid-write cannot corrupt the existing target.
 *
 * @param file Absolute path to write.
 * @param data Serializable value to persist.
 */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true });

  const tmp = join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
  const contents = `${JSON.stringify(data, null, 2)}\n`;

  try {
    await writeFile(tmp, contents, "utf8");
    await rename(tmp, file);
  } catch (err) {
    // Best-effort cleanup of the temp file if the rename never happened.
    try {
      await unlink(tmp);
    } catch {
      // Ignore: temp file may not exist or was already renamed.
    }
    throw err;
  }
}
