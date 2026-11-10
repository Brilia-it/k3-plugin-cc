// BRILIA fork: tests for scripts/identity-map.mjs, the single definition of how
// upstream's names become ours. What must change, and what must not: Moonshot's
// CLI (`kimi`, `kimi-code`, KIMI_CODE_*), the model ("Kimi reviews"), the
// upstream repository and its npm package keep their names.
// Written as .js because the script is plain Node ESM and the TypeScript
// project does not allowJs.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { apply, applyIdentityMap, declaredReason, removedReason, verify } from "../../scripts/identity-map.mjs";

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
    ["cache/kimi-marketplace/kimi/1.0/", "cache/brilia-k3-marketplace/k3/1.0/"],
    ["C:\\plugins\\cache\\kimi-marketplace\\kimi\\2.0.7\\dist", "C:\\plugins\\cache\\brilia-k3-marketplace\\k3\\2.0.7\\dist"],
    ["data/kimi-kimi-marketplace", "data/k3-brilia-k3-marketplace"],
    ["data/kimi-marketplace-kimi", "data/brilia-k3-marketplace-k3"],
    ["enabledPlugins: kimi@kimi-marketplace", "enabledPlugins: k3@brilia-k3-marketplace"],
    ["Kimi Review: pending changes", "K3 Review: pending changes"],
    ["`Kimi ${label}`", "`K3 ${label}`"],
    ["Kimi review gate timed out", "K3 review gate timed out"],
    ["`kimi_ask`, `kimi_swarm_write` and kimi_job_status/result/cancel", "`k3_ask`, `k3_swarm_write` and k3_job_status/result/cancel"],
    ['case "kimi_job_cancel":', 'case "k3_job_cancel":'],
    ['title: "kimi job result"', 'title: "k3 job result"'],
    ['{\n  "mcpServers": {\n    "kimi": {', '{\n  "mcpServers": {\n    "k3": {'],
    ["mcpServers: {\n    kimi: {", "mcpServers: {\n    k3: {"],
    ["mcp.mcpServers.kimi.env_vars", "mcp.mcpServers.k3.env_vars"],
    ["Codex users can invoke the matching $kimi-* skills.", "Codex users can invoke the matching $k3-* skills."],
    ["# kimi:ask", "# k3:ask"],
    ["# kimi:swarm --write", "# k3:swarm --write"],
    ["the `kimi:kimi-challenge` subagent", "the `k3:k3-challenge` subagent"],
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
    "kimi_session_id kimi_session_id_source kimi_pid kimi_version kimi_command kimi_prefix_args kimi_identity",
    "kimi_ask_later and x-kimi_ask",
    '{ "command": "kimi", "type": "kimi" }',
    "providers: { kimi: { type: 'kimi' } }",
    "signalJobProcesses(job, signal, { companion: true, kimi: true })",
    "kimi:review-gate and xkimi:ask",
  ])("leaves %s alone", (input) => {
    expect(applyIdentityMap(input)).toBe(input);
  });

  test("is idempotent", () => {
    const sample = "/kimi:setup KIMI_PLUGIN_CC_CMD kimi-plugin-cc-managed kimi@kimi-marketplace Kimi Ask kimi_ask mcpServers.kimi";
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
      // Prose merged by hand: left as upstream wrote it, at the root only.
      const prose = "upstream keeps kimi-marketplace and /kimi:setup\n";
      for (const name of ["README.md", "CHANGELOG.md", "NOTICE"]) writeFileSync(path.join(root, name), prose);
      writeFileSync(path.join(root, "plugins", "kimi-codex", "README.md"), prose);

      const result = apply([root]);
      expect(result.rewritten).toBe(3);
      expect(result.kept).toBe(4);
      expect(readFileSync(path.join(root, "docs", "registry-releases.md"), "utf8")).toBe(verbatim);
      for (const name of ["README.md", "CHANGELOG.md", "NOTICE"]) {
        expect(readFileSync(path.join(root, name), "utf8")).toBe(prose);
      }
      expect(readFileSync(path.join(root, "plugins", "k3-codex", "README.md"), "utf8")).toBe(
        "upstream keeps brilia-k3-marketplace and /k3:setup\n",
      );
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

describe("apply, what it must never damage", () => {
  test("leaves a file that is not strict UTF-8 byte for byte, even without NUL", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "identity-map-binary-"));
    try {
      // "kimi-plugin-cc" followed by an invalid UTF-8 byte and no NUL.
      const bytes = Buffer.concat([Buffer.from("kimi-plugin-cc "), Buffer.from([0xff, 0xfe, 0x41])]);
      writeFileSync(path.join(root, "blob.dat"), bytes);
      const result = apply([root]);
      expect(result.binary).toBe(1);
      expect(result.rewritten).toBe(0);
      expect(readFileSync(path.join(root, "blob.dat"))).toEqual(bytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses, before writing anything, a rename onto a path that exists", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "identity-map-collision-"));
    try {
      mkdirSync(path.join(root, "agents"));
      writeFileSync(path.join(root, "agents", "kimi-ask.md"), "uses /kimi:ask\n");
      writeFileSync(path.join(root, "agents", "k3-ask.md"), "already here\n");
      expect(() => apply([root])).toThrow("nothing was changed");
      expect(readFileSync(path.join(root, "agents", "kimi-ask.md"), "utf8")).toBe("uses /kimi:ask\n");
      expect(readFileSync(path.join(root, "agents", "k3-ask.md"), "utf8")).toBe("already here\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a dry run reports and writes nothing", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "identity-map-dry-"));
    try {
      writeFileSync(path.join(root, "kimi-ask.md"), "/kimi:ask\n");
      const result = apply([root], { dryRun: true });
      expect(result).toMatchObject({ rewritten: 1, renamed: 1, dryRun: true });
      expect(readFileSync(path.join(root, "kimi-ask.md"), "utf8")).toBe("/kimi:ask\n");
      expect(existsSync(path.join(root, "k3-ask.md"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("verify, on a repository built for the test", () => {
  function gitIn(dir, ...args) {
    execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  }

  test("reports exactly the undeclared, the stale and the removed", () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "identity-map-verify-"));
    try {
      gitIn(repo, "init", "-q");
      gitIn(repo, "config", "user.email", "t@example.invalid");
      gitIn(repo, "config", "user.name", "t");
      mkdirSync(path.join(repo, "agents"));
      writeFileSync(path.join(repo, "agents", "kimi-ask.md"), "Run /kimi:ask.\n");
      writeFileSync(path.join(repo, "same.md"), "uses kimi-code\n");
      writeFileSync(path.join(repo, "changed.md"), "KIMI_PLUGIN_CC_CMD\n");
      writeFileSync(path.join(repo, "declared.md"), "old\n");
      writeFileSync(path.join(repo, "stale.md"), "unchanged\n");
      writeFileSync(path.join(repo, "gone.md"), "x\n");
      writeFileSync(path.join(repo, "gone-declared.md"), "x\n");
      gitIn(repo, "add", "-A");
      gitIn(repo, "commit", "-q", "-m", "upstream");
      gitIn(repo, "tag", "up");

      // The fork: renamed file mapped correctly, one file changed by hand
      // without a declaration, one declared, one declared but in fact
      // identical, two removed (one declared), one added (undeclared).
      rmSync(path.join(repo, "agents", "kimi-ask.md"));
      writeFileSync(path.join(repo, "agents", "k3-ask.md"), "Run /k3:ask.\n");
      writeFileSync(path.join(repo, "changed.md"), "K3_PLUGIN_CC_CMD plus a hand edit\n");
      writeFileSync(path.join(repo, "declared.md"), "new\n");
      rmSync(path.join(repo, "gone.md"));
      rmSync(path.join(repo, "gone-declared.md"));
      writeFileSync(path.join(repo, "added.md"), "new file\n");

      const { identical, problems } = verify(repo, "up", {
        declared: { "declared.md": "hand edit", "stale.md": "claimed but untrue", "missing.md": "not there" },
        removed: { "gone-declared.md": "dropped" },
      });
      expect(identical).toBe(3); // agents/k3-ask.md, same.md, stale.md
      expect(problems.sort()).toEqual(
        [
          "added without a declaration: added.md",
          "declared but not in this tree (stale declaration): missing.md",
          "declared divergent but identical after the map (stale declaration): stale.md",
          "differs from upstream after the map, and is not declared: changed.md",
          "removed without a declaration: gone.md",
        ].sort(),
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);

  test("a removed directory is declared once, and a removal still on disk is stale", () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "identity-map-removed-dir-"));
    try {
      gitIn(repo, "init", "-q");
      gitIn(repo, "config", "user.email", "t@example.invalid");
      gitIn(repo, "config", "user.name", "t");
      mkdirSync(path.join(repo, "host", "deep"), { recursive: true });
      writeFileSync(path.join(repo, "host", "a.md"), "a\n");
      writeFileSync(path.join(repo, "host", "deep", "b.md"), "b\n");
      writeFileSync(path.join(repo, "kept.md"), "kept\n");
      gitIn(repo, "add", "-A");
      gitIn(repo, "commit", "-q", "-m", "upstream");
      gitIn(repo, "tag", "up");

      rmSync(path.join(repo, "host"), { recursive: true });
      expect(verify(repo, "up", { declared: {}, removed: { "host/": "not carried" } }).problems).toEqual([]);

      // Declared removed, yet the file is still in the tree.
      expect(verify(repo, "up", { declared: {}, removed: { "host/": "not carried", "kept.md": "dropped" } }).problems).toEqual([
        "declared removed but still in this tree (stale declaration): kept.md",
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("declaredReason and removedReason", () => {
  test("compiled files follow their runtime source", () => {
    expect(declaredReason("runtime/version.ts")).toBe("fork version string");
    expect(declaredReason("dist/version.js")).toBe("fork version string (compiled)");
    expect(declaredReason("plugins/k3-codex/dist/version.js")).toBe("fork version string (compiled)");
    expect(declaredReason("runtime/render.ts")).toBeUndefined();
  });

  test("the DeepSeek Harness host is removed as whole directories", () => {
    expect(removedReason("plugins/kimi-dsh/dist/companion.js")).toContain("DeepSeek Harness");
    expect(removedReason("runtime/dsh/index.ts")).toContain("DeepSeek Harness");
    expect(removedReason("dsh/index.json")).toContain("DeepSeek Harness");
    expect(removedReason(".github/workflows/publish.yml")).toContain("npm");
    expect(removedReason("runtime/dsh-like.ts")).toBeUndefined();
    expect(removedReason("runtime/kimi-engine.ts")).toBeUndefined();
  });
});
