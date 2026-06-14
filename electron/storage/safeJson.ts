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
