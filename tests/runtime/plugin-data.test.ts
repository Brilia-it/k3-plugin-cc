import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";

import { resolvePluginDataRoot } from "../../runtime/plugin-data.js";

let root: string;
beforeAll(async () => { root = await mkdtemp(path.join(tmpdir(), "kimi-data-resolution-")); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

async function install(host: "claude" | "codex", marketplace = "kimi-marketplace", version = "2.0.0") {
  const plugins = path.join(root, host, "plugins");
  const packageRoot = path.join(plugins, "cache", marketplace, "kimi", version);
  const manifest = path.join(packageRoot, host === "claude" ? ".claude-plugin" : ".codex-plugin");
  await mkdir(manifest, { recursive: true });
  await writeFile(path.join(manifest, "plugin.json"), '{"name":"kimi"}');
  return { packageRoot, expected: path.join(plugins, "data", host === "claude" ? `kimi-${marketplace}` : `${marketplace}-kimi`) };
}

describe("plugin data ownership", () => {
  for (const host of ["claude", "codex"] as const) {
    test(`${host}: installed identity survives shared env pollution and version changes`, async () => {
      const { packageRoot, expected } = await install(host);
      expect(resolvePluginDataRoot({}, packageRoot)).toBe(expected);
      expect(resolvePluginDataRoot({ CLAUDE_PLUGIN_DATA: expected, PLUGIN_DATA: expected }, packageRoot)).toBe(expected);
      expect(resolvePluginDataRoot({ CLAUDE_PLUGIN_DATA: expected }, (await install(host, "kimi-marketplace", "2.1.0")).packageRoot)).toBe(expected);
      for (const env of [
        { CLAUDE_PLUGIN_DATA: path.join(root, "foreign") },
        { PLUGIN_DATA: path.join(root, "foreign") },
        { CLAUDE_PLUGIN_DATA: path.join(root, "foreign"), PLUGIN_DATA: expected },
        { CLAUDE_PLUGIN_DATA: expected, PLUGIN_DATA: path.join(root, "foreign") },
        { CLAUDE_PLUGIN_DATA: path.join(root, "foreign"), PLUGIN_DATA: path.join(root, "foreign") },
      ]) {
        expect(() => resolvePluginDataRoot(env, packageRoot)).toThrow("Shared plugin data variables");
        expect(resolvePluginDataRoot({ ...env, KIMI_PLUGIN_CC_DATA: expected }, packageRoot)).toBe(expected);
      }
    });
  }

  test("loaded package selects ownership despite spoofed root/home variables", async () => {
    const { packageRoot, expected } = await install("codex");
    expect(resolvePluginDataRoot({ CLAUDE_PLUGIN_ROOT: "/fake", PLUGIN_ROOT: "/fake", HOME: "/fake", CODEX_HOME: "/fake" }, packageRoot)).toBe(expected);
  });

  test("existing symlink aliases preserve the same installed data directory", async () => {
    const { packageRoot, expected } = await install("claude");
    await mkdir(expected, { recursive: true });
    const alias = path.join(root, "data-alias");
    await symlink(expected, alias);
    expect(resolvePluginDataRoot({ CLAUDE_PLUGIN_DATA: alias }, packageRoot)).toBe(expected);
    expect(resolvePluginDataRoot({ CLAUDE_PLUGIN_DATA: alias, PLUGIN_DATA: expected }, root)).toBe(alias);
  });

  test("first-run aliases resolve through existing ancestors without creating data", async () => {
    const { packageRoot, expected } = await install("claude", "first-run-market");
    const physical = path.join(root, "claude");
    const alias = path.join(root, "first-run-home-alias");
    await symlink(physical, alias);
    const aliasedData = path.join(alias, "plugins/data/kimi-first-run-market");
    expect(existsSync(expected)).toBe(false);
    expect(resolvePluginDataRoot({ CLAUDE_PLUGIN_DATA: aliasedData }, packageRoot)).toBe(expected);
    expect(existsSync(expected)).toBe(false);
    expect(() => resolvePluginDataRoot({ CLAUDE_PLUGIN_DATA: path.join(alias, "plugins/data/foreign") }, packageRoot)).toThrow("Shared plugin data variables");
  });

  test("dangling links and non-directory ancestors do not establish identity", async () => {
    const { packageRoot, expected } = await install("claude", "broken-alias-market");
    const dangling = path.join(root, "dangling-data");
    await symlink(expected, dangling);
    expect(() => resolvePluginDataRoot({ CLAUDE_PLUGIN_DATA: dangling }, packageRoot)).toThrow("Shared plugin data variables");
    const file = path.join(root, "not-a-directory");
    await writeFile(file, "fixture");
    expect(() => resolvePluginDataRoot({ CLAUDE_PLUGIN_DATA: path.join(file, "child") }, packageRoot)).toThrow("Shared plugin data variables");
  });

  test("custom roots preserve unambiguous legacy paths and require a choice on conflict", () => {
    expect(resolvePluginDataRoot({ CLAUDE_PLUGIN_DATA: root }, root)).toBe(root);
    expect(resolvePluginDataRoot({ PLUGIN_DATA: root }, root)).toBe(root);
    expect(() => resolvePluginDataRoot({ CLAUDE_PLUGIN_DATA: root, PLUGIN_DATA: path.join(root, "other") }, root)).toThrow("disagree");
    expect(resolvePluginDataRoot({ CLAUDE_PLUGIN_DATA: root, PLUGIN_DATA: "/other", KIMI_PLUGIN_CC_DATA: path.join(root, "chosen") }, root)).toBe(path.join(root, "chosen"));
  });

  test("invalid explicit choices fail instead of falling back", () => {
    for (const value of ["", "relative/path"]) {
      expect(() => resolvePluginDataRoot({ KIMI_PLUGIN_CC_DATA: value, CLAUDE_PLUGIN_DATA: root }, root)).toThrow("absolute directory");
    }
  });

  test("custom shell launches retain the existing Codex fallback; direct callers need a path", () => {
    expect(resolvePluginDataRoot({ KIMI_PLUGIN_CC_SHELL_LAUNCH: "1", CODEX_HOME: root }, root)).toBe(path.join(root, "plugins/data/kimi-marketplace-kimi"));
    expect(resolvePluginDataRoot({ KIMI_PLUGIN_CC_SHELL_LAUNCH: "1", HOME: root }, root)).toBe(path.join(root, ".codex/plugins/data/kimi-marketplace-kimi"));
    expect(() => resolvePluginDataRoot({ KIMI_PLUGIN_CC_SHELL_LAUNCH: "1" }, root)).toThrow("Set KIMI_PLUGIN_CC_DATA");
    expect(resolvePluginDataRoot({ KIMI_PLUGIN_CC_SHELL_LAUNCH: "1", KIMI_PLUGIN_CC_DATA: root }, root)).toBe(root);
    expect(() => resolvePluginDataRoot({}, root)).toThrow("Set KIMI_PLUGIN_CC_DATA");
  });
});
