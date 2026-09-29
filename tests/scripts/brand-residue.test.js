// BRILIA fork: this repository speaks its own names (k3), and upstream's names
// (the product name, the variable prefix, the slash-command namespace, the
// marketplace, the agent and skill names) appear only where they are needed on
// purpose. The definition of "upstream's names" is the identity map itself
// (scripts/identity-map.mjs): a line is clean when the map leaves it unchanged.
// This test fails when an upstream merge, or a hand edit, brings one back.
// Written as .js because the map is plain Node ESM and the TypeScript project
// does not allowJs.
//
// Where upstream's names stay on purpose, the count of lines is pinned, so a
// new occurrence in the same file still fails the test and gets looked at:
//   - the migration of a pre-0.6 install, which has to recognise the old marker,
//     the old data directory and the old variables;
//   - the identity map and the tests of all this;
//   - documentation that names the upstream project or describes the migration.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { applyIdentityMap } from "../../scripts/identity-map.mjs";

const repoRoot = path.resolve(import.meta.dir, "..", "..");

// File -> number of lines that keep an upstream name on purpose.
const PINNED = {
  "runtime/hooks/legacy-brand.ts": 5,
  "runtime/legacy-names.ts": 4,
  "runtime/paths.ts": 2,
  "runtime/commands/setup.ts": 3,
  "scripts/identity-map.mjs": 8,
  "tests/runtime/legacy-brand.test.ts": 22,
  "tests/scripts/identity-map.test.js": 22,
};
// Compiled counterparts carry the same lines as their source.
for (const [source, count] of Object.entries({ ...PINNED })) {
  if (!source.startsWith("runtime/")) continue;
  const compiled = source.replace(/^runtime\//, "").replace(/\.ts$/, ".js");
  PINNED[`dist/${compiled}`] = count;
  PINNED[`plugins/k3-codex/dist/${compiled}`] = count;
}
// Documents that name the upstream project, its history, or the migration.
// docs/registry-releases.md is upstream's npm release page, kept verbatim under a fork note.
const DOCUMENTS = new Set(["CHANGELOG.md", "README.md", "NOTICE", "docs/registry-releases.md"]);

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

describe("upstream names", () => {
  test("appear only where they are pinned, and exactly as often", () => {
    const unexpected = [];
    const counts = new Map();
    for (const { file, text } of trackedTextFiles()) {
      const lines = text.split("\n").filter((line) => applyIdentityMap(line) !== line);
      if (lines.length === 0) continue;
      if (DOCUMENTS.has(file)) continue;
      counts.set(file, lines.length);
      if (PINNED[file] === undefined) {
        unexpected.push(`${file}: ${lines.slice(0, 3).map((l) => l.trim()).join(" | ")}`);
      }
    }
    expect(unexpected).toEqual([]);
    for (const [file, count] of Object.entries(PINNED)) {
      expect({ file, count: counts.get(file) ?? 0 }).toEqual({ file, count });
    }
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
