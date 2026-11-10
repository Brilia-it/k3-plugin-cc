// BRILIA fork (NOTICE kind 3): tests of the Windows shell probe changes in
// runtime/commands/setup.ts. Section 4(b) of the License requires this notice.

import { describe, expect, test } from "bun:test";

import { classifyProbeExit } from "../../runtime/commands/setup.js";

describe("classifyProbeExit", () => {
  test("names a hang when there is no exit code", () => {
    expect(classifyProbeExit(null)).toContain("hang");
  });

  test("POSIX 127 and cmd.exe 9009 are the same environment cause", () => {
    expect(classifyProbeExit(127)).toContain("environment");
    expect(classifyProbeExit(9009)).toBe(classifyProbeExit(127));
  });

  test("255 is the quoting failure the single-quoted command produced under cmd.exe", () => {
    expect(classifyProbeExit(255)).toContain("quoting");
  });

  test("0 is a hook that allowed what it must deny", () => {
    expect(classifyProbeExit(0)).toContain("no deny");
  });

  test("anything else points at stderr", () => {
    expect(classifyProbeExit(1)).toContain("stderr");
  });
});
