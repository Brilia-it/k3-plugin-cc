// BRILIA fork: tests for scripts/identity-map.mjs, the single definition of how
// upstream's names become ours. What must change, and what must not: Moonshot's
// CLI (`kimi`, `kimi-code`, KIMI_CODE_*), the model ("Kimi reviews"), the
// upstream repository and its npm package keep their names.
// Written as .js because the script is plain Node ESM and the TypeScript
// project does not allowJs.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { apply, applyIdentityMap, declaredReason } from "../../scripts/identity-map.mjs";

describe("applyIdentityMap", () => {
  test.each([
    ["/kimi:setup --check", "/k3:setup --check"],
    ["ask `$kimi-setup` to check", "ask `$k3-setup` to check"],
    ["agents/kimi-swarm-write.md", "agents/k3-swarm-write.md"],
    ["plugins/kimi-codex/skills/kimi-review/SKILL.md", "plugins/k3-codex/skills/k3-review/SKILL.md"],
    ["KIMI_PLUGIN_CC_KIMI_BIN=/opt/kimi", "K3_PLUGIN_CC_KIMI_BIN=/opt/kimi"],
    ["${KIMI_PLUGIN_CC_NODE_BIN:-node}", "${K3_PLUGIN_CC_NODE_BIN:-node}"],
    ["# === BEGIN kimi-plugin-cc-managed:claude-code (v1) ===", "# === BEGIN k3-plugin-cc-managed:claude-code (v1) ==="],
    ["config.toml.kimi-plugin-cc.lock", "config.toml.k3-plugin-cc.lock"],
    ["[kimi-plugin-cc] swarm failed", "[k3-plugin-cc] swarm failed"],
    ["cache/kimi-marketplace/kimi/1.0/", "cache/brilia-k3-marketplace/kimi/1.0/"],
    ["data/kimi-kimi-marketplace", "data/k3-brilia-k3-marketplace"],
    ["data/kimi-marketplace-kimi", "data/brilia-k3-marketplace-k3"],
    ["enabledPlugins: kimi@kimi-marketplace", "enabledPlugins: k3@brilia-k3-marketplace"],
    ["Kimi Review: pending changes", "K3 Review: pending changes"],
    ["`Kimi ${label}`", "`K3 ${label}`"],
    ["Kimi review gate timed out", "K3 review gate timed out"],
  ])("%s -> %s", (input, output) => {
    expect(applyIdentityMap(input)).toBe(output);
  });

  test.each([
    "kimi-code 2.1.1 spawns hooks",
    "KIMI_CODE_HOME=/x KIMI_CODE_EXPERIMENTAL_FLAG=1",
    "kimi -p --output-format stream-json",
    "Have Kimi review the runtime directory",
    "Run a read-only Kimi review over the diff",
    "could not find the Kimi CLI",
    "Kimi K3 from Claude Code",
    "https://github.com/linxule/kimi-plugin-cc/releases/tag/v2.0.7",
    "/plugin marketplace add linxule/kimi-plugin-cc",
    "https://www.npmjs.com/package/kimi-plugin-cc",
    "The npm package `kimi-plugin-cc` ships the Claude plugin",
    "does not expose an `npx kimi-plugin-cc` command",
    "npm publish kimi-plugin-cc-X.Y.Z.tgz --access public",
    "[`kimi-plugin-cc` on npm](https://www.npmjs.com/package/kimi-plugin-cc)",
    "assets/claude-code-kimi-review.jpg",
    "kimi-for-coding",
    "KIMI_SESSION_LINEAGE_UNKNOWN",
  ])("leaves %s alone", (input) => {
    expect(applyIdentityMap(input)).toBe(input);
  });

  test("is idempotent", () => {
    const sample = "/kimi:setup KIMI_PLUGIN_CC_CMD kimi-plugin-cc-managed kimi@kimi-marketplace Kimi Ask";
    const once = applyIdentityMap(sample);
    expect(applyIdentityMap(once)).toBe(once);
  });
});

describe("apply", () => {
  test("rewrites contents and renames files and directories, deepest first", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "identity-map-apply-"));
    try {
      mkdirSync(path.join(root, "plugins", "kimi-codex", "skills", "kimi-setup"), { recursive: true });
      writeFileSync(path.join(root, "plugins", "kimi-codex", "skills", "kimi-setup", "SKILL.md"), "Run /kimi:setup.\n");
      mkdirSync(path.join(root, "agents"));
      writeFileSync(path.join(root, "agents", "kimi-ask.md"), "name: kimi-ask\nuses kimi-code\n");
      writeFileSync(path.join(root, "image.bin"), Buffer.from([0, 1, 2, 107, 105, 109, 105]));
      mkdirSync(path.join(root, "docs"));
      const verbatim = "Repository: `kimi-plugin-cc`, see /kimi:setup\n";
      writeFileSync(path.join(root, "docs", "registry-releases.md"), verbatim);

      const result = apply([root]);
      expect(result.rewritten).toBe(2);
      expect(result.kept).toBe(1);
      expect(readFileSync(path.join(root, "docs", "registry-releases.md"), "utf8")).toBe(verbatim);
      expect(readFileSync(path.join(root, "plugins", "k3-codex", "skills", "k3-setup", "SKILL.md"), "utf8")).toBe(
        "Run /k3:setup.\n",
      );
      expect(readFileSync(path.join(root, "agents", "k3-ask.md"), "utf8")).toBe("name: k3-ask\nuses kimi-code\n");
      expect(existsSync(path.join(root, "plugins", "kimi-codex"))).toBe(false);
      expect(readFileSync(path.join(root, "image.bin"))).toEqual(Buffer.from([0, 1, 2, 107, 105, 109, 105]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("declaredReason", () => {
  test("compiled files follow their runtime source", () => {
    expect(declaredReason("runtime/paths.ts")).toContain("NOTICE 6");
    expect(declaredReason("dist/paths.js")).toContain("(compiled)");
    expect(declaredReason("plugins/k3-codex/dist/hooks/legacy-brand.js")).toContain("(compiled)");
    expect(declaredReason("runtime/kimi-engine.ts")).toBeUndefined();
  });
});
