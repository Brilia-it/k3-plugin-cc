#!/usr/bin/env node
// BRILIA fork: coexistence smoke with the upstream plugin.
//
// WHY THIS EXISTS
//
// Since 0.6.0 this fork claims that it and the upstream kimi plugin can be
// installed side by side: separate hook-block markers, separate variables,
// each hook governing only its own sessions, and neither setup touching the
// other's block. Up to 0.5.x the two wrote the SAME block. A claim like that
// is proved by running both, not by reading either.
//
// WHAT IT DOES, all in a temporary HOME (the real ~/.kimi-code is never used,
// and its config.toml is hashed before and after to prove it):
//
//   1. installs upstream at <ref> and this working tree under the real install
//      layout (~/.claude/plugins/cache/<marketplace>/<plugin>/<version>), so
//      both derive the host id `claude-code`: the case that collided before;
//   2. runs the setups in turn (upstream, ours, upstream, ours) and requires,
//      after each, that the other plugin's block is byte for byte unchanged;
//   3. runs each plugin's hook with each plugin's label variable, with no shell
//      in between: each must deny a Bash call only under its own label;
//   4. uninstalls ours and requires upstream's block unchanged, then the reverse.
//
// It drives no model and makes no network call.
//
// Usage: node tests/manual/coexistence-smoke.mjs [upstream-ref] [--ours-ref <ref>]
//   upstream-ref defaults to v2.0.7. --ours-ref installs this fork from a ref
//   instead of the working tree: with a pre-0.6 ref (203199a, 0.5.1) the smoke
//   MUST fail, which is what proves it can.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const oursFlag = args.indexOf("--ours-ref");
const oursRef = oursFlag === -1 ? undefined : args[oursFlag + 1];
const upstreamRef = args.find((a, i) => !a.startsWith("--") && (oursFlag === -1 || i !== oursFlag + 1)) ?? "v2.0.7";
const home = mkdtempSync(path.join(os.tmpdir(), "k3-coexistence-"));
const kimiHome = path.join(home, ".kimi-code");
const configPath = path.join(kimiHome, "config.toml");
const realConfig = path.join(os.homedir(), ".kimi-code", "config.toml");
const hashOf = (file) => (existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : "absent");
const realBefore = hashOf(realConfig);

const PLUGINS = {
  upstream: {
    root: path.join(home, ".claude", "plugins", "cache", "kimi-marketplace", "kimi", "2.0.7"),
    data: path.join(home, ".claude", "plugins", "data", "kimi-kimi-marketplace"),
    prefix: "KIMI_PLUGIN_CC_",
    marker: "kimi-plugin-cc-managed:claude-code",
  },
  ours: {
    root: path.join(home, ".claude", "plugins", "cache", "brilia-k3-marketplace", "k3", "2.0.7-brilia.0.6.0"),
    data: path.join(home, ".claude", "plugins", "data", "k3-brilia-k3-marketplace"),
    prefix: "K3_PLUGIN_CC_",
    marker: "k3-plugin-cc-managed:claude-code",
  },
};

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

const PARTS = ["dist", "scripts", ".claude-plugin", "hooks", "package.json"];

// Extract PARTS of `ref` into `root`, straight from the object store (no tar:
// MSYS tar mangles Windows paths, and a checkout would touch the index).
function extract(ref, root) {
  const files = execFileSync("git", ["-C", repo, "ls-tree", "-r", "--name-only", ref, "--", ...PARTS], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  const batch = execFileSync("git", ["-C", repo, "cat-file", "--batch"], {
    input: files.map((f) => `${ref}:${f}`).join("\n") + "\n",
    maxBuffer: 256 * 1024 * 1024,
  });
  let offset = 0;
  for (const file of files) {
    const headerEnd = batch.indexOf(0x0a, offset);
    const [, type, size] = batch.subarray(offset, headerEnd).toString("utf8").split(" ");
    if (type !== "blob") throw new Error(`unexpected object for ${file}: ${type}`);
    const start = headerEnd + 1;
    const target = path.join(root, ...file.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, batch.subarray(start, start + Number(size)));
    offset = start + Number(size) + 1;
  }
}

function install() {
  // Upstream from its ref; ours from the working tree, or from `--ours-ref`
  // (the negative control: 0.5.1 still shares upstream's marker).
  extract(upstreamRef, PLUGINS.upstream.root);
  mkdirSync(PLUGINS.ours.root, { recursive: true });
  if (oursRef !== undefined) extract(oursRef, PLUGINS.ours.root);
  else for (const part of PARTS) cpSync(path.join(repo, part), path.join(PLUGINS.ours.root, part), { recursive: true });
  for (const p of Object.values(PLUGINS)) mkdirSync(p.data, { recursive: true });
}

function baseEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(KIMI_PLUGIN_CC_|K3_PLUGIN_CC_|CLAUDE_PLUGIN_|PLUGIN_ROOT$|PLUGIN_DATA$)/.test(name)) delete env[name];
  }
  return { ...env, HOME: home, USERPROFILE: home, KIMI_CODE_HOME: kimiHome };
}

function setup(which, args = []) {
  const p = PLUGINS[which];
  const env = {
    ...baseEnv(),
    CLAUDE_PLUGIN_ROOT: p.root,
    CLAUDE_PLUGIN_DATA: p.data,
    [`${p.prefix}SKIP_VERSION_PROBE`]: "1",
  };
  // Upstream derives a backslashed hook path on Windows and its own TOML check
  // rejects it: the documented workaround is this override. (It is the first of
  // the Windows problems this fork fixes; here it only lets upstream install.)
  if (which === "upstream" && process.platform === "win32") {
    env[`${p.prefix}HOOK_SCRIPT`] = path.join(p.root, "dist", "hooks", "approval-hook.js").replace(/\\/g, "/");
  }
  const run = spawnSync(process.execPath, [path.join(p.root, "dist", "companion.js"), "setup", ...args], {
    cwd: p.root,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: run.status, out: `${run.stdout}\n${run.stderr}` };
}

// The block of `marker`: from its BEGIN line to its END line, inclusive.
function blockOf(marker) {
  if (!existsSync(configPath)) return null;
  const lines = readFileSync(configPath, "utf8").split("\n");
  const begin = lines.findIndex((l) => l.trim().startsWith(`# === BEGIN ${marker}`));
  const end = lines.findIndex((l) => l.trim().startsWith(`# === END ${marker}`));
  if (begin === -1 || end === -1 || end < begin) return null;
  return lines.slice(begin, end + 1).join("\n");
}

function count(marker) {
  if (!existsSync(configPath)) return 0;
  return readFileSync(configPath, "utf8").split("\n").filter((l) => l.trim().startsWith(`# === BEGIN ${marker}`)).length;
}

function hook(which, labelPrefix) {
  const p = PLUGINS[which];
  const env = { ...baseEnv(), [`${labelPrefix}CMD`]: "review" };
  const run = spawnSync(process.execPath, [path.join(p.root, "dist", "hooks", "approval-hook.js")], {
    env,
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo x > f" } }),
    encoding: "utf8",
    timeout: 30_000,
  });
  return run.status;
}

try {
  install();

  let r = setup("upstream");
  check("upstream setup installs its block", r.status === 0 && count(PLUGINS.upstream.marker) === 1, `exit ${r.status}`);
  const upstreamBlock = blockOf(PLUGINS.upstream.marker);

  r = setup("ours");
  check("our setup installs its block", r.status === 0 && count(PLUGINS.ours.marker) === 1, `exit ${r.status}`);
  check("our setup leaves upstream's block byte for byte", blockOf(PLUGINS.upstream.marker) === upstreamBlock);
  check("our setup does not call upstream's block ours", !/Migrated/.test(r.out));
  const ourBlock = blockOf(PLUGINS.ours.marker);

  r = setup("upstream");
  check("upstream setup again: one block of its own", r.status === 0 && count(PLUGINS.upstream.marker) === 1, `exit ${r.status}`);
  check("upstream setup leaves our block byte for byte", blockOf(PLUGINS.ours.marker) === ourBlock);

  r = setup("ours");
  check("our setup again: one block of its own", r.status === 0 && count(PLUGINS.ours.marker) === 1, `exit ${r.status}`);
  check("still exactly one upstream block", count(PLUGINS.upstream.marker) === 1 && blockOf(PLUGINS.upstream.marker) === upstreamBlock);

  r = setup("ours", ["--check"]);
  check("our --check passes with upstream installed", r.status === 0, `exit ${r.status}`);

  check("our hook denies under our label", hook("ours", "K3_PLUGIN_CC_") === 2);
  check("our hook leaves upstream's sessions alone", hook("ours", "KIMI_PLUGIN_CC_") === 0);
  check("upstream's hook denies under its label", hook("upstream", "KIMI_PLUGIN_CC_") === 2);
  check("upstream's hook leaves our sessions alone", hook("upstream", "K3_PLUGIN_CC_") === 0);

  r = setup("ours", ["--uninstall"]);
  check("our uninstall removes only ours", count(PLUGINS.ours.marker) === 0 && blockOf(PLUGINS.upstream.marker) === upstreamBlock, `exit ${r.status}`);
  setup("ours");
  const ourAgain = blockOf(PLUGINS.ours.marker);
  r = setup("upstream", ["--uninstall"]);
  check("upstream's uninstall removes only its own", count(PLUGINS.upstream.marker) === 0 && blockOf(PLUGINS.ours.marker) === ourAgain, `exit ${r.status}`);
} finally {
  const realAfter = hashOf(realConfig);
  check("the real ~/.kimi-code/config.toml was not touched", realAfter === realBefore);
  rmSync(home, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
