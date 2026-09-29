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
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runSetup } from "../../runtime/commands/setup.js";
import { buildHookShellCommand, resolveHookScriptPath } from "../../runtime/hooks/install-paths.js";
import {
  describeLegacyBrandBlocks,
  findLegacyBrandBlocks,
  scanLegacyBrand,
  stripLegacyBrandBlocks,
} from "../../runtime/hooks/legacy-brand.js";
import { evaluateInstalled } from "../../runtime/hooks/managed-block.js";
import { JobStore } from "../../runtime/job-store.js";
import {
  collectLegacyEnvWarnings,
  describeLegacyDataDirInUse,
  legacyPathMapper,
  legacyEnvNames,
  migrateLegacyDataDir,
} from "../../runtime/legacy-names.js";
import { ensurePluginPaths, resolvePluginPaths } from "../../runtime/paths.js";
import type { CommandContext } from "../../runtime/types.js";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const hookScriptPath = path.join(repoRoot, "dist", "hooks", "approval-hook.js");
const WRITE_LOCK_HOLDER = path.join(repoRoot, "tests", "helpers", "hold-write-lock.ts");

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
// The scan reads lines; TOML can hide a whole block-shaped text inside a
// multi-line string. The parser has the last word before anything goes.
const IN_A_STRING = ['note = """', ...legacyBlock("claude-code", OUR_OLD_SCRIPT), "[testo]", '"""', ""].join("\n");

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

  test("an unmatched old BEGIN is not a block, and is reported as a stray", () => {
    const contents = ["# === BEGIN kimi-plugin-cc-managed:claude-code ===", "[[hooks]]", ""].join("\n");
    expect(findLegacyBrandBlocks(contents)).toEqual([]);
    expect(scanLegacyBrand(contents).strayMarkers).toEqual(["# === BEGIN kimi-plugin-cc-managed:claude-code ==="]);
  });

  test("an END for another host does not close a BEGIN", () => {
    const lines = legacyBlock("claude-code", OUR_OLD_SCRIPT);
    lines[lines.length - 1] = "# === END kimi-plugin-cc-managed:codex ===";
    const contents = `${lines.join("\n")}\n`;
    const { blocks, strayMarkers } = scanLegacyBrand(contents);
    expect(blocks).toEqual([]);
    expect(strayMarkers).toHaveLength(2);
    const { stripped, removed } = stripLegacyBrandBlocks(contents, "\n", "claude-code");
    expect(removed).toEqual([]);
    expect(stripped).toBe(contents);
    expect(describeLegacyBrandBlocks([], [], "removed", strayMarkers).join("\n")).toContain("do not form a complete block");
  });

  test("keys after END still belong to the hook table: the block is not ours to remove", () => {
    // In TOML the END comment does not close [[hooks]]: `matcher` belongs to it.
    const contents = [...legacyBlock("claude-code", OUR_OLD_SCRIPT), 'matcher = "Bash"', "", "[other]", "x = 1", ""].join("\n");
    const [block] = findLegacyBrandBlocks(contents);
    expect(block!.ours).toBe(false);
    expect(stripLegacyBrandBlocks(contents, "\n", "claude-code").stripped).toBe(contents);
    // A table header right after END is fine.
    const clean = [...legacyBlock("claude-code", OUR_OLD_SCRIPT), "# note", "", "[other]", "x = 1", ""].join("\n");
    expect(findLegacyBrandBlocks(clean)[0]!.ours).toBe(true);
  });

  test("a key before [[hooks]] belongs to the table above: the block is not ours to remove", () => {
    const lines = legacyBlock("claude-code", OUR_OLD_SCRIPT);
    lines.splice(1, 0, 'extra = "belongs to the table above"');
    expect(findLegacyBrandBlocks(`${lines.join("\n")}\n`)[0]!.ours).toBe(false);
    // Even when it has the shape of a key this plugin writes inside [[hooks]]:
    // above the header it is still the table above's.
    for (const key of ["timeout = 30", 'event = "PreToolUse"']) {
      const shaped = legacyBlock("claude-code", OUR_OLD_SCRIPT);
      shaped.splice(2, 0, key);
      const contents = `${shaped.join("\n")}\n`;
      expect({ key, ours: findLegacyBrandBlocks(contents)[0]!.ours }).toEqual({ key, ours: false });
      expect(stripLegacyBrandBlocks(contents, "\n", "claude-code").stripped).toBe(contents);
    }
  });

  test("a block-shaped text inside a multi-line string is never removed", () => {
    const result = stripLegacyBrandBlocks(IN_A_STRING, "\n", "claude-code");
    expect(result.removed).toEqual([]);
    expect(result.unconfirmed).toHaveLength(1);
    expect(result.stripped).toBe(IN_A_STRING);
    expect(describeLegacyBrandBlocks([], [], "found", [], result.unconfirmed).join("\n")).toContain("remove them by hand");
  });

  test("a real block is still removed, and blank lines inside a string elsewhere stay as they are", () => {
    const poem = ['poem = """', "one", "", "", "", "two", '"""'];
    const contents = [...poem, "", ...legacyBlock("claude-code", OUR_OLD_SCRIPT), "", "", ""].join("\n");
    const result = stripLegacyBrandBlocks(contents, "\n", "claude-code");
    expect(result.removed).toHaveLength(1);
    expect(result.unconfirmed).toEqual([]);
    expect(result.stripped.startsWith(`${poem.join("\n")}\n`)).toBe(true);
    expect(result.stripped).not.toContain("kimi-plugin-cc-managed");
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

  test("our pre-0.6 hook table without any marker: not installed either", () => {
    // kimi-code rewrites config.toml dropping comments, so a 0.5.x block can
    // survive as a bare [[hooks]] table.
    const expected = buildHookShellCommand(hookScriptPath, process.env);
    const bare = legacyBlock("claude-code", OUR_OLD_SCRIPT).filter((line) => !line.startsWith("#"));
    expect(evaluateInstalled(`${bare.join("\n")}\n`, expected, { hostId: "claude-code" }).installed).toBe(false);
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

  test("install and uninstall stop, touching nothing, when the parser does not confirm the removal", async () => {
    const { context, configPath } = await makeCase("install-unconfirmed");
    await writeFile(configPath, IN_A_STRING, "utf8");
    await expect(runSetup([], context)).rejects.toThrow("left unchanged");
    expect(await readFile(configPath, "utf8")).toBe(IN_A_STRING);
    await expect(runSetup(["--uninstall"], context)).rejects.toThrow("left unchanged");
    expect(await readFile(configPath, "utf8")).toBe(IN_A_STRING);
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

  async function seedLegacy(root: string, env: NodeJS.ProcessEnv, jobs: Array<[string, "running" | "completed"]>) {
    const old = path.join(root, "kimi-plugin-cc");
    await mkdir(old, { recursive: true });
    const seeded = resolvePluginPaths(env);
    expect(seeded.pluginRoot).toBe(old);
    await ensurePluginPaths(seeded);
    const store = new JobStore(seeded);
    for (const [id, status] of jobs) seedJob(store, id, status, old);
    store.close();
    await writeFile(path.join(old, "config.json"), '{"reviewGateEnabled":true}');
    return old;
  }

  function readJob(env: NodeJS.ProcessEnv, jobId: string) {
    const store = new JobStore(resolvePluginPaths(env));
    try {
      return store.getJob(jobId)!;
    } finally {
      store.close();
    }
  }

  test("moves when no job runs, leaves an alias, and past jobs' paths follow", async () => {
    const { root, env } = await dataCase("migrate");
    const old = await seedLegacy(root, env, [["job-done", "completed"]]);
    const current = path.join(root, "k3-plugin-cc");

    const result = await migrateLegacyDataDir(env);
    expect(result).toEqual({ status: "migrated", from: old, to: current, rebased: 1, alias: "kept" });
    // The old name is now an alias to the new directory, not a directory.
    expect(lstatSync(old).isSymbolicLink()).toBe(true);
    expect(realpathSync(old)).toBe(realpathSync(current));
    const moved = resolvePluginPaths(env);
    expect(moved.pluginRoot).toBe(current);
    expect(moved.usingLegacyDataDir).toBe(false);
    expect(await readFile(moved.configPath, "utf8")).toContain("reviewGateEnabled");
    const job = readJob(env, "job-done");
    expect(job.final_output_path).toBe(path.join(current, "artifacts", "job-done.md"));
    expect(job.stream_log_path).toBe(path.join(current, "logs", "job-done.jsonl"));
  });

  test("the next setup removes the alias, never the data behind it", async () => {
    const { root, env } = await dataCase("alias-removal");
    const old = await seedLegacy(root, env, [["job-done", "completed"]]);
    const current = path.join(root, "k3-plugin-cc");
    await migrateLegacyDataDir(env);

    expect(await migrateLegacyDataDir(env)).toEqual({ status: "alias-removed", alias: old, rebased: 0 });
    expect(existsSync(old)).toBe(false);
    expect(await readFile(path.join(current, "config.json"), "utf8")).toContain("reviewGateEnabled");
    expect(existsSync(path.join(current, "state.db"))).toBe(true);
    expect(readJob(env, "job-done").summary).toBe("seeded");
  });

  test("the alias stays while a job runs, and a rewrite missed once is done on the next run", async () => {
    const { root, env } = await dataCase("alias-kept");
    const old = await seedLegacy(root, env, [["job-done", "completed"]]);
    const current = path.join(root, "k3-plugin-cc");
    await migrateLegacyDataDir(env);
    // A job started by a command that resolved the old path just before the
    // move: its row keeps the old paths, and it is still running.
    const store = new JobStore(resolvePluginPaths(env));
    seedJob(store, "job-late", "running", old);
    store.close();

    expect(await migrateLegacyDataDir(env)).toEqual({ status: "alias-kept", alias: old, running: 1, rebased: 1 });
    expect(lstatSync(old).isSymbolicLink()).toBe(true);
    expect(readJob(env, "job-late").stream_log_path).toBe(path.join(current, "logs", "job-late.jsonl"));
  });

  // Another process holding the job store's write lock, as a command does while
  // it records a job. Resolves once the lock is held.
  async function holdWriteLock(dbPath: string, holdMs: number, keepOpenMs = 0) {
    const marker = `${dbPath}.lock-held`;
    const holder = spawn(process.execPath, [WRITE_LOCK_HOLDER, dbPath, marker, String(holdMs), String(keepOpenMs)], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    holder.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exited = new Promise<number | null>((resolve) => holder.on("exit", resolve));
    const start = Date.now();
    while (!existsSync(marker)) {
      if (Date.now() - start > 10_000) throw new Error(`lock holder never started: ${stderr}`);
      await new Promise((r) => setTimeout(r, 10));
    }
    return { exited, kill: () => holder.kill(), releasedAt: () => Number(readFileSync(`${marker}.release`, "utf8")) };
  }

  // A writer that never lets go within setup's patience: setup must give up
  // with the store's own "locked" error and change nothing.
  test("the move takes the job store's write lock: while another process holds it, nothing moves", async () => {
    const { root, env } = await dataCase("locked-move");
    const old = await seedLegacy(root, env, [["job-done", "completed"]]);
    const holder = await holdWriteLock(path.join(old, "state.db"), 120_000);
    try {
      const result = await migrateLegacyDataDir(env);
      expect(result.status).toBe("failed");
      expect(result.status === "failed" ? result.reason : "").toContain("locked by another process");
    } finally {
      holder.kill();
      await holder.exited;
    }
    expect(lstatSync(old).isSymbolicLink()).toBe(false);
    expect(lstatSync(old).isDirectory()).toBe(true);
    expect(existsSync(path.join(root, "k3-plugin-cc"))).toBe(false);
    expect(readJob(env, "job-done").stream_log_path).toBe(path.join(old, "logs", "job-done.jsonl"));
  }, 120_000);

  test("so does the removal of the alias", async () => {
    const { root, env } = await dataCase("locked-alias");
    const old = await seedLegacy(root, env, [["job-done", "completed"]]);
    await migrateLegacyDataDir(env);
    const holder = await holdWriteLock(path.join(root, "k3-plugin-cc", "state.db"), 120_000);
    try {
      const result = await migrateLegacyDataDir(env);
      expect(result.status === "failed" ? result.reason : "").toContain("locked by another process");
    } finally {
      holder.kill();
      await holder.exited;
    }
    expect(lstatSync(old).isSymbolicLink()).toBe(true);
  }, 120_000);

  // A writer that lets go after a while: on macOS and Linux setup waits for it,
  // then moves.
  test.skipIf(process.platform === "win32")("setup waits for a writer to finish, then moves", async () => {
    const { root, env } = await dataCase("waits-then-moves");
    const old = await seedLegacy(root, env, [["job-done", "completed"]]);
    const holder = await holdWriteLock(path.join(old, "state.db"), 2000);
    const result = await migrateLegacyDataDir(env);
    const finished = Date.now();
    expect(await holder.exited).toBe(0);
    expect(result.status).toBe("migrated");
    expect(finished).toBeGreaterThanOrEqual(holder.releasedAt());
  }, 60_000);

  // On Windows the rename runs after the lock is released, and fails while
  // another process still has the store open: setup reports it, changes nothing.
  test.skipIf(process.platform !== "win32")("a store another process keeps open makes the rename fail", async () => {
    const { root, env } = await dataCase("open-store-blocks-rename");
    const old = await seedLegacy(root, env, [["job-done", "completed"]]);
    const holder = await holdWriteLock(path.join(old, "state.db"), 1000, 30_000);
    try {
      const result = await migrateLegacyDataDir(env);
      expect(result.status).toBe("failed");
    } finally {
      holder.kill();
      await holder.exited;
    }
    expect(lstatSync(old).isDirectory()).toBe(true);
    expect(existsSync(path.join(root, "k3-plugin-cc"))).toBe(false);
    expect(readJob(env, "job-done").stream_log_path).toBe(path.join(old, "logs", "job-done.jsonl"));
  }, 60_000);

  // Windows moves outside the lock (a rename with the store open fails there),
  // so the rollback exists only on macOS and Linux.
  test.skipIf(process.platform === "win32")(
    "a rename that fails rolls back the rewrite of the stored paths",
    async () => {
      const { root, env } = await dataCase("rename-fails");
      const old = await seedLegacy(root, env, [["job-done", "completed"]]);
      await chmod(root, 0o555); // the directory cannot be renamed inside it
      try {
        const result = await migrateLegacyDataDir(env);
        expect(result.status).toBe("failed");
      } finally {
        await chmod(root, 0o755);
      }
      expect(lstatSync(old).isDirectory()).toBe(true);
      expect(readJob(env, "job-done").stream_log_path).toBe(path.join(old, "logs", "job-done.jsonl"));
    },
    60_000,
  );

  test("paths stored under another spelling of the same root are rewritten too", async () => {
    // 0.5.x stored paths built from CLAUDE_PLUGIN_DATA as the host set it; the
    // root 0.6 resolves can be spelled differently (here: through an alias).
    const { root } = await dataCase("spelling");
    const spelled = path.join(scratch, "spelling-alias");
    await symlink(root, spelled, process.platform === "win32" ? "junction" : "dir");
    const env = { K3_PLUGIN_CC_DATA: root, CLAUDE_PLUGIN_DATA: spelled } as NodeJS.ProcessEnv;
    const old = await seedLegacy(root, { K3_PLUGIN_CC_DATA: root }, []);
    const store = new JobStore(resolvePluginPaths(env));
    seedJob(store, "job-spelled", "completed", path.join(spelled, "kimi-plugin-cc"));
    store.close();

    const result = await migrateLegacyDataDir(env);
    expect(result.status).toBe("migrated");
    expect(readJob(env, "job-spelled").final_output_path).toBe(
      path.join(root, "k3-plugin-cc", "artifacts", "job-spelled.md"),
    );
    expect(old).toBe(path.join(root, "kimi-plugin-cc"));
  });

  test.skipIf(process.platform !== "win32")("on Windows, case and separators do not hide a stored path", () => {
    const map = legacyPathMapper(["C:\\Data\\kimi-plugin-cc"], "C:\\Data\\k3-plugin-cc");
    expect(map("c:/data/KIMI-PLUGIN-CC/logs/a.jsonl")).toBe("C:\\Data\\k3-plugin-cc\\logs\\a.jsonl");
    expect(map("C:\\Data\\kimi-plugin-cc-other\\a")).toBeNull();
  });

  test("a sibling directory whose name only begins the same way is not rewritten", () => {
    const base = path.join(scratch, "sibling");
    const map = legacyPathMapper([path.join(base, "kimi-plugin-cc")], path.join(base, "k3-plugin-cc"));
    expect(map(path.join(base, "kimi-plugin-cc-backup", "logs", "a.jsonl"))).toBeNull();
    expect(map(path.join(base, "kimi-plugin-cc"))).toBeNull();
    expect(map(path.join(base, "kimi-plugin-cc", "logs", "a.jsonl"))).toBe(path.join(base, "k3-plugin-cc", "logs", "a.jsonl"));
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
    expect(lstatSync(old).isDirectory()).toBe(true);

    await mkdir(path.join(root, "k3-plugin-cc"));
    expect((await migrateLegacyDataDir(env)).status).toBe("both-exist");
    expect(lstatSync(old).isDirectory()).toBe(true);
    // --check says so, instead of the old state silently going invisible.
    expect(describeLegacyDataDirInUse(env)).toContain("still exists next to");
  });

  test("an old name that points somewhere else is never touched", async () => {
    const { root, env } = await dataCase("foreign-alias");
    const elsewhere = path.join(scratch, "foreign-target");
    await mkdir(elsewhere, { recursive: true });
    await writeFile(path.join(elsewhere, "keep.txt"), "keep");
    await mkdir(path.join(root, "k3-plugin-cc"));
    await symlink(elsewhere, path.join(root, "kimi-plugin-cc"), process.platform === "win32" ? "junction" : "dir");

    expect((await migrateLegacyDataDir(env)).status).toBe("alias-foreign");
    expect(lstatSync(path.join(root, "kimi-plugin-cc")).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(elsewhere, "keep.txt"), "utf8")).toBe("keep");
  });
});
