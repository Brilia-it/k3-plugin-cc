import { describe, expect, test } from "bun:test";

import { formatError, RuntimeError } from "../../runtime/errors.js";

describe("runtime error formatting", () => {
  test("formatError includes RuntimeError code and stage", () => {
    const error = new RuntimeError("INVALID_ARGS", "bad arguments", "args.parse", {
      details: { received: "--bad" },
    });

    // v1.9.0: structured details are serialized so an LLM caller can act on
    // them. Without this they existed only in the SQLite job row, so a
    // FOREGROUND command's context was lost entirely.
    expect(formatError(error)).toBe(
      '[INVALID_ARGS] [args.parse] bad arguments\ndetails: {"received":"--bad"}',
    );
    expect(error.details).toEqual({ received: "--bad" });
  });

  test("formatError omits the details line when there are none", () => {
    const error = new RuntimeError("INVALID_ARGS", "bad arguments", "args.parse");
    expect(formatError(error)).toBe("[INVALID_ARGS] [args.parse] bad arguments");
  });

  test("formatError survives non-serializable details", () => {
    // A circular value must never suppress the error itself.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const error = new RuntimeError("X", "boom", "stage", { details: circular });
    expect(formatError(error)).toBe("[X] [stage] boom");
  });

  test("formatError preserves plain Error messages", () => {
    expect(formatError(new Error("plain failure"))).toBe("plain failure");
  });

  test("RuntimeError exposes empty details by default", () => {
    const error = new RuntimeError("INVALID_ARGS", "bad arguments", "args.parse");

    expect(error.details).toEqual({});
  });
});
