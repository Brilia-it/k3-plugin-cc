// BRILIA fork: this repository speaks its own names (k3), and upstream's names
// (the product name, the variable prefix, the slash-command namespace, the
// marketplace, the agent and skill names) appear only where they are needed on
// purpose. The definition of "upstream's names" is the identity map itself
// (scripts/identity-map.mjs): a line is clean when the map leaves it unchanged.
// This test fails when an upstream merge, or a hand edit, brings one back.
// Written as .js because the map is plain Node ESM and the TypeScript project
// does not allowJs.
//
// Where upstream's names stay on purpose, each such LINE is pinned: its text,
// trimmed, hashed into tests/scripts/brand-residue.pins.json. A new line fails,
// and so does an allowed line replaced by another one in the same file (a count
// per file would not see that). Documents are pinned like code: no file is
// exempt. The pinned lines are:
//   - the migration of a pre-0.6 install, which has to recognise the old marker,
//     the old data directory and the old variables;
//   - the identity map, the coexistence smoke and the tests of all this;
//   - documentation that names the upstream project, its npm package, its
//     history, or describes the migration; docs/registry-releases.md is kept
//     verbatim from upstream (KEEP_VERBATIM in the map).
// After a deliberate change, look at the lines the failure lists, then
// regenerate: K3_UPDATE_RESIDUE_PINS=1 bun test tests/scripts/brand-residue.test.js
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { applyIdentityMap } from "../../scripts/identity-map.mjs";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const PINS_FILE = "tests/scripts/brand-residue.pins.json";

const hashLine = (line) => createHash("sha256").update(line, "utf8").digest("hex").slice(0, 16);

function trackedTextFiles() {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  const out = [];
  for (const file of files) {
    let bytes;
    try {
      bytes = readFileSync(path.join(repoRoot, file));
    } catch {
      continue; // listed but deleted in the working tree
    }
    if (bytes.includes(0)) continue;
    out.push({ file, text: bytes.toString("utf8") });
  }
  return out;
}

// File -> the trimmed lines that keep an upstream name.
function residue() {
  const found = {};
  for (const { file, text } of trackedTextFiles()) {
    const lines = text
      .split("\n")
      .filter((line) => applyIdentityMap(line) !== line)
      .map((line) => line.trim());
    if (lines.length > 0) found[file] = lines;
  }
  return found;
}

describe("upstream names", () => {
  test("appear only in lines pinned one by one", () => {
    const found = residue();
    if (process.env.K3_UPDATE_RESIDUE_PINS === "1") {
      const pins = Object.fromEntries(
        Object.keys(found)
          .sort()
          .map((file) => [file, found[file].map(hashLine).sort()]),
      );
      writeFileSync(path.join(repoRoot, PINS_FILE), `${JSON.stringify(pins, null, 2)}\n`);
      return;
    }
    const pins = JSON.parse(readFileSync(path.join(repoRoot, PINS_FILE), "utf8"));
    const problems = [];
    for (const [file, lines] of Object.entries(found)) {
      const remaining = [...(pins[file] ?? [])];
      for (const line of lines) {
        const index = remaining.indexOf(hashLine(line));
        if (index === -1) problems.push(`${file}: not pinned: ${line}`);
        else remaining.splice(index, 1);
      }
      if (remaining.length > 0) problems.push(`${file}: ${remaining.length} pinned line(s) no longer present`);
    }
    for (const file of Object.keys(pins)) {
      if (found[file] === undefined) problems.push(`${file}: pinned, but has no upstream name any more`);
    }
    expect(problems).toEqual([]);
  });

  test("every variable the hook reads is one the plugin sets on the kimi process", () => {
    // A rename applied to one side only would leave the hook reading a name
    // nobody sets: the hook would then see no label and allow every tool call.
    const hook = readFileSync(path.join(repoRoot, "runtime/hooks/approval-hook.ts"), "utf8");
    const client = readFileSync(path.join(repoRoot, "runtime/cli-client.ts"), "utf8");
    const read = [...hook.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]);
    const written = new Set([...client.matchAll(/env\.([A-Z0-9_]+)\s*=/g)].map((m) => m[1]));
    expect(read.length).toBeGreaterThan(0);
    for (const name of read) {
      expect({ name, written: written.has(name) }).toEqual({ name, written: true });
    }
  });
});
