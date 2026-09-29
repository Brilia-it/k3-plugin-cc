// BRILIA fork (0.6.0): migration of what a pre-0.6 install left under
// upstream's names. Three rules are load-bearing and each has a test here:
//
//   1. a hook block under the OLD marker is removed only when it is this
//      fork's own; the upstream kimi plugin's block is kept byte for byte;
//   2. a hook that runs an OLD hook script is never counted as installed: that
//      script reads KIMI_PLUGIN_CC_CMD, which this plugin no longer sets, so for
//      a K3 session it would allow every tool call;
//   3. the data directory moves only when no job is running, and the paths the
//      job store kept for past jobs follow it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runSetup } from "../../runtime/commands/setup.js";
import { buildHookShellCommand, resolveHookScriptPath } from "../../runtime/hooks/install-paths.js";
import {
  describeLegacyBrandBlocks,
  findLegacyBrandBlocks,
  stripLegacyBrandBlocks,
} from "../../runtime/hooks/legacy-brand.js";
import { evaluateInstalled } from "../../runtime/hooks/managed-block.js";
import { JobStore } from "../../runtime/job-store.js";
import {
  collectLegacyEnvWarnings,
  legacyEnvNames,
  migrateLegacyDataDir,
} from "../../runtime/legacy-names.js";
import { ensurePluginPaths, resolvePluginPaths } from "../../runtime/paths.js";
import type { CommandContext } from "../../runtime/types.js";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const hookScriptPath = path.join(repoRoot, "dist", "hooks", "approval-hook.js");

const OUR_OLD_SCRIPT = "/home/u/.claude/plugins/cache/brilia-k3-marketplace/k3/2.0.7-brilia.0.5.1/dist/hooks/approval-hook.js";
const OUR_OLD_CODEX_SCRIPT = "/home/u/.codex/plugins/cache/brilia-k3-marketplace/k3/2.0.7-brilia.0.5.1/dist/hooks/approval-hook.js";
const UPSTREAM_SCRIPT = "/home/u/.claude/plugins/cache/kimi-marketplace/kimi/2.0.7/dist/hooks/approval-hook.js";

function legacyBlock(host: string, script: string, extra: string[] = []): string[] {
  return [
    `# === BEGIN kimi-plugin-cc-managed:${host} (v2.0.7-brilia.0.5.1) ===`,
    "# DO NOT EDIT — managed by /k3:setup.",
    "[[hooks]]",
    'event = "PreToolUse"',
    `command = "'/usr/bin/node' '${script}'"`,
    "timeout = 15",
    ...extra,
    `# === END kimi-plugin-cc-managed:${host} ===`,
  ];
}

const USER_BEFORE = ["# my settings", 'default_model = "kimi-for-coding"', ""];
const UPSTREAM_BLOCK = legacyBlock("claude-code", UPSTREAM_SCRIPT);

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "k3-legacy-brand-"));
});
afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

describe("blocks under the old marker", () => {
  test("ours only when the hook lives under this fork's tree and the body is ours", () => {
    const contents = [
      ...legacyBlock("claude-code", OUR_OLD_SCRIPT),
      "",
      ...UPSTREAM_BLOCK,
      "",
      ...legacyBlock("claude-code", OUR_OLD_SCRIPT, ['note = "hand-added"']),
      "",
    ].join("\n");
    const blocks = findLegacyBrandBlocks(contents);
    expect(blocks.map((b) => [b.host, b.ours])).toEqual([
      ["claude-code", true],
      ["claude-code", false],
      // Our command, but a key we never write: not ours to delete.
      ["claude-code", false],
    ]);
  });

  test("an unmatched old BEGIN is not a block", () => {
    const contents = ["# === BEGIN kimi-plugin-cc-managed:claude-code ===", "[[hooks]]", ""].join("\n");
    expect(findLegacyBrandBlocks(contents)).toEqual([]);
  });

  test("host-scoped strip removes this host's own, keeps the other host's and upstream's byte for byte", () => {
    const contents = [
      ...USER_BEFORE,
      ...legacyBlock("claude-code", OUR_OLD_SCRIPT),
      "",
      ...legacyBlock("codex", OUR_OLD_CODEX_SCRIPT),
      "",
      ...UPSTREAM_BLOCK,
      "",
    ].join("\r\n");
    const { stripped, removed, kept } = stripLegacyBrandBlocks(contents, "\r\n", "claude-code");
    expect(removed.map((b) => b.host)).toEqual(["claude-code"]);
    expect(kept.map((b) => [b.host, b.ours])).toEqual([
      ["codex", true],
      ["claude-code", false],
    ]);
    expect(stripped).not.toContain(OUR_OLD_SCRIPT);
    expect(stripped).toContain(OUR_OLD_CODEX_SCRIPT);
    expect(stripped).toContain(UPSTREAM_BLOCK.join("\r\n"));
    expect(stripped).toContain(USER_BEFORE.slice(0, 2).join("\r\n"));
    expect(stripped.split("\r\n").every((line) => !line.includes("\n"))).toBe(true);
    const notes = describeLegacyBrandBlocks(removed, kept, "removed").join("\n");
    expect(notes).toContain("Migrated 1 hook block(s)");
    expect(notes).toContain("codex");
    expect(notes).toContain("not this plugin's");
  });

  test("a block running exactly this install's command is ours, whatever its path or host", () => {
    // A development checkout keeps one path across versions, so its old block
    // can run the current command from a path that carries none of our segments.
    const devScript = "/home/u/src/some-checkout/dist/hooks/approval-hook.js";
    const devCommand = `'/usr/bin/node' '${devScript}'`;
    const contents = `${legacyBlock("some-other-host", devScript).join("\n")}\n${UPSTREAM_BLOCK.join("\n")}\n`;
    expect(stripLegacyBrandBlocks(contents, "\n", "claude-code").removed).toHaveLength(0);
    const { stripped, removed } = stripLegacyBrandBlocks(contents, "\n", "claude-code", devCommand);
    expect(removed).toHaveLength(1);
    expect(stripped).toBe(`${UPSTREAM_BLOCK.join("\n")}\n`);
  });

  test("the all-hosts strip removes every one of ours and still keeps upstream's", () => {
    const contents = [
      ...legacyBlock("claude-code", OUR_OLD_SCRIPT),
      ...legacyBlock("codex", OUR_OLD_CODEX_SCRIPT),
      ...UPSTREAM_BLOCK,
      "",
    ].join("\n");
    const { stripped, removed } = stripLegacyBrandBlocks(contents, "\n");
    expect(removed).toHaveLength(2);
    expect(stripped).toBe(`${UPSTREAM_BLOCK.join("\n")}\n`);
  });
});

describe("an old hook script is never an installed hook", () => {
  test("our pre-0.6 block alone: not installed, whatever its marker says", () => {
    const expected = buildHookShellCommand(hookScriptPath, process.env);
    const contents = `${legacyBlock("claude-code", OUR_OLD_SCRIPT).join("\n")}\n`;
    expect(evaluateInstalled(contents, expected, { hostId: "claude-code" }).installed).toBe(false);
  });

  test("the new hook ignores the old label variable, the new one enforces", async () => {
    const invoke = (env: NodeJS.ProcessEnv) =>
      new Promise<number | null>((resolve, reject) => {
        const child = spawn("node", ["--import", "tsx", path.join(repoRoot, "runtime/hooks/approval-hook.ts")], {
          cwd: repoRoot,
          env,
          stdio: ["pipe", "ignore", "ignore"],
        });
        child.once("error", reject);
        child.once("close", resolve);
        child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }));
      });
    const base = { ...process.env };
    delete base.K3_PLUGIN_CC_CMD;
    delete base.KIMI_PLUGIN_CC_CMD;
    // Upstream's variable belongs to upstream's sessions: this hook does not govern them.
    expect(await invoke({ ...base, KIMI_PLUGIN_CC_CMD: "review" })).toBe(0);
    expect(await invoke({ ...base, K3_PLUGIN_CC_CMD: "review" })).toBe(2);
  });
});

describe("setup migrates the old block", () => {
  async function makeCase(name: string) {
    const kimiCodeHome = path.join(scratch, name, "kimi-code-home");
    const pluginData = path.join(scratch, name, "plugin-data");
    await mkdir(kimiCodeHome, { recursive: true });
    await mkdir(pluginData, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      KIMI_CODE_HOME: kimiCodeHome,
      CLAUDE_PLUGIN_DATA: pluginData,
      K3_PLUGIN_CC_HOST_ID: "claude-code",
    };
    const context: CommandContext = { cwd: process.cwd(), env, stdout: process.stdout, stderr: process.stderr };
    return { env, context, configPath: path.join(kimiCodeHome, "config.toml"), pluginData };
  }

  test("install replaces our pre-0.6 block and leaves upstream's untouched", async () => {
    const { context, configPath } = await makeCase("install-migrates");
    const before = [...USER_BEFORE, ...legacyBlock("claude-code", OUR_OLD_SCRIPT), "", ...UPSTREAM_BLOCK, ""].join("\n");
    await writeFile(configPath, before, "utf8");

    const result = await runSetup([], context);
    expect(result.blockWritten).toBe(true);
    const after = await readFile(configPath, "utf8");
    expect(after).not.toContain(OUR_OLD_SCRIPT);
    expect(after).toContain(UPSTREAM_BLOCK.join("\n"));
    expect(after.match(/# === BEGIN k3-plugin-cc-managed:claude-code /g)).toHaveLength(1);
    // Our old block goes whole, markers and comments included: the only lines
    // left under the old marker are upstream's BEGIN and END.
    expect(after.split("\n").filter((line) => line.includes("kimi-plugin-cc-managed"))).toEqual([
      UPSTREAM_BLOCK[0],
      UPSTREAM_BLOCK[UPSTREAM_BLOCK.length - 1],
    ]);
    expect(after.split("\n").filter((line) => line === "# DO NOT EDIT — managed by /k3:setup.")).toHaveLength(1);
    expect(after).toContain(hookScriptPath.replace(/\\/g, "/").split("/").pop()!);
    expect(result.warnings.join("\n")).toContain("Migrated 1 hook block(s)");

    // A second run finds nothing left to migrate.
    const again = await runSetup([], context);
    expect(again.warnings.join("\n")).not.toContain("Migrated");
  }, 60_000);

  test("install also takes an old block that runs exactly its own command, under another host id", async () => {
    const { env, context, configPath } = await makeCase("install-exact-command");
    const expected = buildHookShellCommand(resolveHookScriptPath(env), env);
    const old = [
      "# === BEGIN kimi-plugin-cc-managed:elsewhere (v2.0.7-brilia.0.5.1) ===",
      "[[hooks]]",
      'event = "PreToolUse"',
      `command = ${JSON.stringify(expected)}`,
      "timeout = 15",
      "# === END kimi-plugin-cc-managed:elsewhere ===",
      "",
    ].join("\n");
    await writeFile(configPath, old, "utf8");

    await runSetup([], context);
    const after = await readFile(configPath, "utf8");
    expect(after).not.toContain("kimi-plugin-cc-managed");
    expect(after.match(/# === BEGIN k3-plugin-cc-managed:claude-code /g)).toHaveLength(1);
  }, 60_000);

  test("--check reports the old block without failing on it, and --uninstall removes it", async () => {
    const { context, configPath } = await makeCase("check-and-uninstall");
    await runSetup([], context);
    const installed = await readFile(configPath, "utf8");
    await writeFile(configPath, `${installed}\n${legacyBlock("claude-code", OUR_OLD_SCRIPT).join("\n")}\n`, "utf8");

    const check = await runSetup(["--check"], context);
    expect(check.probe).toBe("ok");
    const notes = check.warnings.join("\n");
    expect(notes).toContain("Found 1 hook block(s) written by k3-plugin-cc before 0.6.0");
    expect(notes).not.toContain("stale marker-less");

    const uninstall = await runSetup(["--uninstall"], context);
    expect(uninstall.blockRemoved).toBe(true);
    const after = await readFile(configPath, "utf8");
    expect(after).not.toContain("kimi-plugin-cc-managed");
    expect(after).not.toContain("k3-plugin-cc-managed");
  }, 60_000);
});

describe("old variable names", () => {
  test("are listed and reported, never read", () => {
    const env = { KIMI_PLUGIN_CC_KIMI_BIN: "/opt/kimi", KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "1", K3_PLUGIN_CC_DATA: "/x" };
    expect(legacyEnvNames(env)).toEqual(["KIMI_PLUGIN_CC_KIMI_BIN", "KIMI_PLUGIN_CC_SKIP_HOOK_CHECK"]);
    const warnings: string[] = [];
    collectLegacyEnvWarnings(env, warnings);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("KIMI_PLUGIN_CC_SKIP_HOOK_CHECK -> K3_PLUGIN_CC_SKIP_HOOK_CHECK");
    const none: string[] = [];
    collectLegacyEnvWarnings({ K3_PLUGIN_CC_DATA: "/x" }, none);
    expect(none).toEqual([]);
  });
});

describe("the data directory", () => {
  async function dataCase(name: string) {
    const root = path.join(scratch, name);
    await mkdir(root, { recursive: true });
    return { root, env: { K3_PLUGIN_CC_DATA: root } as NodeJS.ProcessEnv };
  }

  function seedJob(store: JobStore, jobId: string, status: "running" | "completed", dir: string) {
    store.createJob({
      job_id: jobId,
      repo_id: "repo",
      command_type: "review",
      cwd: "/tmp",
      model: null,
      thinking: null,
      background: false,
      pid: null,
      kimi_pid: null,
      status,
      kimi_session_id: null,
      agent_profile: "review",
      prompt_digest: "digest",
      summary: "seeded",
      final_output_path: path.join(dir, "artifacts", `${jobId}.md`),
      stream_log_path: path.join(dir, "logs", `${jobId}.jsonl`),
      error: null,
    });
  }

  test("only the old one: it stays in use; the new name is used once it exists", async () => {
    const { root, env } = await dataCase("resolve");
    expect(resolvePluginPaths(env).pluginRoot).toBe(path.join(root, "k3-plugin-cc"));
    await mkdir(path.join(root, "kimi-plugin-cc"));
    const legacy = resolvePluginPaths(env);
    expect(legacy.pluginRoot).toBe(path.join(root, "kimi-plugin-cc"));
    expect(legacy.usingLegacyDataDir).toBe(true);
    await mkdir(path.join(root, "k3-plugin-cc"));
    expect(resolvePluginPaths(env).pluginRoot).toBe(path.join(root, "k3-plugin-cc"));
  });

  test("a legacy directory that vanished is never recreated", async () => {
    const { root, env } = await dataCase("vanished");
    await mkdir(path.join(root, "kimi-plugin-cc"));
    const paths = resolvePluginPaths(env);
    await rm(path.join(root, "kimi-plugin-cc"), { recursive: true });
    await expect(ensurePluginPaths(paths)).rejects.toThrow("Run the command again");
    expect(existsSync(path.join(root, "kimi-plugin-cc"))).toBe(false);
  });

  test("moves when no job runs, and past jobs' paths follow", async () => {
    const { root, env } = await dataCase("migrate");
    const old = path.join(root, "kimi-plugin-cc");
    await mkdir(old, { recursive: true });
    const seeded = resolvePluginPaths(env);
    expect(seeded.pluginRoot).toBe(old);
    await ensurePluginPaths(seeded);
    const store = new JobStore(seeded);
    seedJob(store, "job-done", "completed", old);
    store.close();
    await writeFile(path.join(old, "config.json"), '{"reviewGateEnabled":true}');

    const result = await migrateLegacyDataDir(env);
    expect(result).toEqual({ status: "migrated", from: old, to: path.join(root, "k3-plugin-cc") });
    expect(existsSync(old)).toBe(false);
    const moved = resolvePluginPaths(env);
    expect(moved.usingLegacyDataDir).toBe(false);
    expect(await readFile(moved.configPath, "utf8")).toContain("reviewGateEnabled");
    const reopened = new JobStore(moved);
    const job = reopened.getJob("job-done")!;
    reopened.close();
    expect(job.final_output_path).toBe(path.join(root, "k3-plugin-cc", "artifacts", "job-done.md"));
    expect(job.stream_log_path).toBe(path.join(root, "k3-plugin-cc", "logs", "job-done.jsonl"));
  });

  test("does not move while a job is running, and never merges two directories", async () => {
    const { root, env } = await dataCase("running");
    const old = path.join(root, "kimi-plugin-cc");
    await mkdir(old, { recursive: true });
    const seeded = resolvePluginPaths(env);
    await ensurePluginPaths(seeded);
    const store = new JobStore(seeded);
    seedJob(store, "job-live", "running", old);
    store.close();

    expect(await migrateLegacyDataDir(env)).toEqual({ status: "jobs-running", legacy: old, running: 1 });
    expect(existsSync(old)).toBe(true);

    await mkdir(path.join(root, "k3-plugin-cc"));
    expect((await migrateLegacyDataDir(env)).status).toBe("both-exist");
    expect(existsSync(old)).toBe(true);
  });
});
