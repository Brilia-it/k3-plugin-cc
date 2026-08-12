#!/usr/bin/env node
// Enforcement matrix for the kimi-code PreToolUse hook.
//
// WHY THIS EXISTS
//
// The hook is the ONLY thing standing between a read-only kimi command and a
// write, because `kimi -p` hard-codes `permission: auto`. The hook contract is
// exit 2 = deny, and ANY OTHER exit code = allow. That means a hook which fails
// to launch does not fail safe: it fails open, silently, while
// `/kimi:setup --check` still reports "Probe: ok".
//
// That is not hypothetical. It is exactly what happened on Windows: the command
// was single-quoted (POSIX), cmd.exe could not launch it, exit was 255, and
// enforcement was inert while every diagnostic said it was fine.
//
// So this harness asserts the contract at the layer that actually decides:
// it spawns the hook THROUGH A SHELL, the same way kimi-code does, and checks
// the exit code per tool. It runs the whole matrix on every available shell,
// because a hook that denies under sh and fails open under cmd.exe is not a
// hook.
//
// WHY NOT DRIVE REAL `kimi -p` FOR EVERY VECTOR
//
// Each vector would be a paid model call, and the model might simply decline to
// attempt the write, which would produce a green result that proves nothing.
// Testing the hook directly removes the model's discretion from the experiment:
// the tool call is asserted, not hoped for. End-to-end coverage is a separate,
// much smaller sample.
//
// THE NEGATIVE CONTROL IS THE POINT
//
// A matrix that cannot fail proves nothing. C1 points the hook at a script that
// does not exist. If the harness still reports "denied", the harness is broken
// and every other row is worthless.
//
// Usage: node tests/manual/enforcement-matrix.mjs

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, readdirSync, statSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HOOK = resolve(process.cwd(), "dist/hooks/approval-hook.js");
const NODE = process.execPath;

if (!existsSync(HOOK)) {
  console.error(`hook not found at ${HOOK} - run \`bun run build\` first`);
  process.exit(1);
}

// ---------------------------------------------------------------- shells

/**
 * Shells to exercise.
 *
 * `shell: true` is not a convenience here, it is the whole point: kimi-code
 * spawns the hook with `spawn(command, { shell: true })`, so that is the code
 * path whose behaviour matters. Handing the command to `spawnSync` as an argv
 * element instead makes Node re-escape a string that is already quoted, which
 * produces `\"C:\Program Files\...\"` and a "not recognized as a command"
 * failure that belongs to the harness, not to the product. Ask the wrong
 * question and you get a red matrix and a bug that does not exist.
 */
function shells() {
  const out = [];
  if (process.platform === "win32") {
    // shell:true resolves to ComSpec (cmd.exe) on Windows.
    out.push({ name: "cmd.exe (shell:true, come kimi-code)", run: (cmd) => spawnSync(cmd, { shell: true, ...opts() }) });
  }
  const sh = process.platform === "win32" ? findGitBash() : "/bin/sh";
  if (sh && existsSync(sh)) {
    out.push({ name: `sh (${sh})`, run: (cmd) => spawnSync(cmd, { shell: sh, ...opts() }) });
  }
  return out;
}

function findGitBash() {
  for (const p of ["C:/Program Files/Git/usr/bin/sh.exe", "C:/Program Files/Git/bin/sh.exe"]) {
    if (existsSync(p)) return p;
  }
  return null;
}

let PAYLOAD = "";
let ENV_LABEL = "review";
let HOOK_PATH = HOOK;

function opts() {
  return {
    input: PAYLOAD,
    encoding: "utf8",
    env: { ...process.env, KIMI_PLUGIN_CC_CMD: ENV_LABEL },
  };
}

function quote(p) {
  return process.platform === "win32" ? `"${p}"` : `'${p.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------- vectors

const WORKSPACE = mkdtempSync(join(tmpdir(), "kimi-enforce-"));
const CANARY = join(WORKSPACE, "canary.txt");
writeFileSync(CANARY, "ORIGINAL");
const OUTSIDE = join(mkdtempSync(join(tmpdir(), "kimi-outside-")), "target.txt");

const cwd = WORKSPACE.replace(/\\/g, "/");

// Each vector names the tool kimi-code would report and the input it would carry.
// `expect: "deny"` means the hook MUST exit 2.
const VECTORS = [
  { id: "P1", label: "control POSITIVO: lettura consentita", tool: "Read", input: { file_path: `${cwd}/canary.txt` }, expect: "allow" },
  { id: "N1", label: "scrittura via tool file", tool: "Write", input: { file_path: `${cwd}/n1.txt`, content: "x" }, expect: "deny" },
  { id: "N2", label: "scrittura via Bash", tool: "Bash", input: { command: `echo x > ${cwd}/n2.txt` }, expect: "deny" },
  { id: "N3", label: "scrittura via PowerShell", tool: "Bash", input: { command: `powershell -c "Set-Content ${cwd}/n3.txt x"` }, expect: "deny" },
  { id: "N4", label: "redirezione shell", tool: "Bash", input: { command: `printf x >> ${cwd}/n4.txt` }, expect: "deny" },
  { id: "N5", label: "processo figlio", tool: "Bash", input: { command: `sh -c "echo x > ${cwd}/n5.txt"` }, expect: "deny" },
  { id: "N6", label: "modifica di file preesistente", tool: "Edit", input: { file_path: `${cwd}/canary.txt`, old_string: "ORIGINAL", new_string: "TAMPERED" }, expect: "deny" },
  { id: "N7", label: "rename di file preesistente", tool: "Bash", input: { command: `mv ${cwd}/canary.txt ${cwd}/renamed.txt` }, expect: "deny" },
  { id: "N8", label: "cancellazione di file preesistente", tool: "Bash", input: { command: `rm -f ${cwd}/canary.txt` }, expect: "deny" },
  { id: "N9", label: "path assoluto FUORI dalla cwd", tool: "Write", input: { file_path: OUTSIDE.replace(/\\/g, "/"), content: "x" }, expect: "deny" },
];

// ---------------------------------------------------------------- manifest

function manifest(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { out[p] = "DIR"; walk(p); }
      else {
        const s = statSync(p);
        out[p] = `${s.size}:${createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16)}`;
      }
    }
  };
  walk(dir);
  return out;
}

function diffManifest(a, b) {
  const changes = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[k] !== b[k]) changes.push(`${a[k] === undefined ? "CREATO" : b[k] === undefined ? "RIMOSSO" : "MODIFICATO"} ${k}`);
  }
  return changes;
}

// ---------------------------------------------------------------- run

function runVector(shell, v) {
  PAYLOAD = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: v.tool, tool_input: v.input, cwd });
  const r = shell.run(`${quote(NODE)} ${quote(HOOK_PATH)}`);
  const code = r.status;
  const denied = code === 2;
  const ok = v.expect === "deny" ? denied : code === 0;
  return { ok, code, stderr: (r.stderr || "").trim().slice(0, 90) };
}

const before = manifest(WORKSPACE);
let failures = 0;

console.log(`hook:      ${HOOK}`);
console.log(`workspace: ${WORKSPACE}\n`);

for (const shell of shells()) {
  console.log(`=== SHELL: ${shell.name} ===`);
  for (const v of VECTORS) {
    const r = runVector(shell, v);
    if (!r.ok) failures++;
    const verdict = r.ok ? "OK  " : "FAIL";
    const got = r.code === 2 ? "deny(2)" : r.code === 0 ? "allow(0)" : `allow(${r.code})`;
    console.log(`  ${verdict} ${v.id.padEnd(3)} atteso=${v.expect.padEnd(5)} ottenuto=${got.padEnd(10)} ${v.label}`);
  }

  // C1 - negative control. Point the hook at a file that does not exist. If the
  // harness still reports a denial, the harness cannot detect an inert hook and
  // every row above is meaningless.
  const realHook = HOOK_PATH;
  HOOK_PATH = join(WORKSPACE, "does-not-exist.js");
  const c1 = runVector(shell, VECTORS[1]);
  HOOK_PATH = realHook;
  const c1Detected = c1.code !== 2;
  if (!c1Detected) failures++;
  console.log(`  ${c1Detected ? "OK  " : "FAIL"} C1  controllo NEGATIVO: hook inesistente -> exit ${c1.code} (deve essere != 2)`);
  console.log("");
}

const after = manifest(WORKSPACE);
const changed = diffManifest(before, after);
console.log("=== FILESYSTEM ===");
if (changed.length === 0) console.log("  OK   nessuna modifica al workspace");
else { failures++; changed.forEach((c) => console.log(`  FAIL ${c}`)); }

console.log(`\n=== ESITO: ${failures === 0 ? "PASS" : `FAIL (${failures})`} ===`);
process.exit(failures === 0 ? 0 : 1);
