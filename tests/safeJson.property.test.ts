import { afterAll, beforeAll, describe, it, expect } from "vitest";
import fc from "fast-check";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeReadJson } from "../electron/storage/safeJson";

/**
 * Property 23: Reading malformed data never crashes and identifies the file.
 * Validates: Requirements 19.1, 19.2
 *
 * Req 19.1 — when a JSON data file is malformed (not parseable), the read keeps
 *            running rather than crashing, and surfaces a result that identifies
 *            the affected file's raw contents.
 * Req 19.2 — when a JSON data file is valid JSON but fails schema validation, the
 *            read reports a `corrupt` outcome (so the caller can offer a restore).
 *
 * For arbitrary file contents written to a real temp file, `safeReadJson`:
 *   - NEVER throws / rejects (it always resolves a discriminated result), and
 *   - classifies the file correctly:
 *       not valid JSON                  -> { ok:false, reason:"malformed", raw }   (Req 19.1)
 *       valid JSON failing the validator-> { ok:false, reason:"corrupt",  raw }   (Req 19.2)
 *       valid JSON passing the validator-> { ok:true,  value }
 *       a non-existent path             -> { ok:false, reason:"missing" }
 */

const NUM_RUNS = 200;

// --- A strict reference validator -------------------------------------------

interface SubbyDoc {
  kind: "subby";
  n: number;
}

/**
 * Accepts ONLY an object of shape `{ kind: "subby"; n: number }`; throws on any
 * other parsed value (primitives, arrays, wrong/missing fields). Stands in for
 * a zod `parse` so the test exercises the validate-throws -> `corrupt` path.
 */
function validate(data: unknown): SubbyDoc {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("expected an object");
  }
  const d = data as Record<string, unknown>;
  if (d.kind !== "subby") {
    throw new Error('expected kind === "subby"');
  }
  if (typeof d.n !== "number") {
    throw new Error("expected numeric n");
  }
  return { kind: "subby", n: d.n };
}

/** True when `validate` rejects the value (used to constrain generators). */
function failsValidate(value: unknown): boolean {
  try {
    validate(value);
    return false;
  } catch {
    return true;
  }
}

/** True when the string is NOT valid JSON. */
function isNotJson(s: string): boolean {
  try {
    JSON.parse(s);
    return false;
  } catch {
    return true;
  }
}

// --- Generators of (content -> known expected classification) ---------------

type Case =
  | { kind: "malformed"; content: string }
  | { kind: "corrupt"; content: string }
  | { kind: "ok"; content: string; value: SubbyDoc };

/** Random strings that are guaranteed not to parse as JSON (Req 19.1). */
const malformedArb: fc.Arbitrary<Case> = fc
  .oneof(
    // Mostly-random strings (the large majority are not valid JSON).
    fc.string(),
    // A few deliberately broken JSON fragments to exercise common corruption.
    fc.constantFrom("{", "[1, 2,", "{'a': 1}", '{"a":}', "undefined", "NaN", "}{", '{"a":1', ""),
  )
  .filter(isNotJson)
  .map((content) => ({ kind: "malformed", content }));

/** Valid JSON values that fail the strict validator (Req 19.2). */
const corruptArb: fc.Arbitrary<Case> = fc
  .oneof(
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.string(),
    fc.boolean(),
    fc.constant(null),
    fc.array(fc.integer()),
    // Objects of the wrong shape: wrong `kind`, missing `n`, or non-numeric `n`.
    fc.record({ kind: fc.string(), n: fc.integer() }),
    fc.record({ kind: fc.constant("subby"), n: fc.string() }),
    fc.record({ foo: fc.string() }),
    fc.constant({}),
  )
  .filter(failsValidate)
  .map((value) => ({ kind: "corrupt", content: JSON.stringify(value) }));

/** Valid JSON objects that the validator accepts. */
const okArb: fc.Arbitrary<Case> = fc
  .record({
    kind: fc.constant("subby" as const),
    // Normalize -0 to 0 so the JSON round-trip (where -0 serializes to "0")
    // matches the generated value under toEqual, which distinguishes -0 from +0.
    n: fc.double({ noNaN: true, noDefaultInfinity: true }).map((x) => x + 0),
  })
  .map((value) => ({ kind: "ok", content: JSON.stringify(value), value }));

const caseArb: fc.Arbitrary<Case> = fc.oneof(malformedArb, corruptArb, okArb);

// --- Temp directory lifecycle -----------------------------------------------

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "subby-safejson-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("Feature: subby, Property 23: Reading malformed data never crashes and identifies the file", () => {
  it("Feature: subby, Property 23: never throws and classifies arbitrary contents (Req 19.1, 19.2)", async () => {
    const file = join(dir, "data.json");

    await fc.assert(
      fc.asyncProperty(caseArb, async (testCase) => {
        await writeFile(file, testCase.content, "utf8");

        // The read must resolve a result rather than throw/reject (Req 19.1).
        let result: Awaited<ReturnType<typeof safeReadJson<SubbyDoc>>>;
        let threw = false;
        try {
          result = await safeReadJson<SubbyDoc>(file, validate);
        } catch {
          threw = true;
          throw new Error("safeReadJson threw instead of returning a result");
        }
        expect(threw).toBe(false);

        switch (testCase.kind) {
          case "malformed": {
            // Not valid JSON -> malformed, and raw reflects the file (Req 19.1).
            expect(result.ok).toBe(false);
            if (!result.ok) {
              expect(result.reason).toBe("malformed");
              expect(result.raw).toBe(testCase.content);
            }
            break;
          }
          case "corrupt": {
            // Valid JSON failing the validator -> corrupt, raw reflects the file (Req 19.2).
            expect(result.ok).toBe(false);
            if (!result.ok) {
              expect(result.reason).toBe("corrupt");
              expect(result.raw).toBe(testCase.content);
            }
            break;
          }
          case "ok": {
            // Valid + accepted -> ok with the validated value.
            expect(result.ok).toBe(true);
            if (result.ok) {
              expect(result.value).toEqual(testCase.value);
            }
            break;
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 23: a non-existent path resolves to missing (never throws)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.hexaString({ minLength: 1, maxLength: 24 }), async (name) => {
        const missingPath = join(dir, `missing-${name}.json`);

        let result: Awaited<ReturnType<typeof safeReadJson<SubbyDoc>>>;
        try {
          result = await safeReadJson<SubbyDoc>(missingPath, validate);
        } catch {
          throw new Error("safeReadJson threw for a non-existent file");
        }

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe("missing");
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
