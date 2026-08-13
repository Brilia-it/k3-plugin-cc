#!/usr/bin/env node
// Does the Windows shell probe actually discriminate a quoting fault?
//
// A probe that passes on a healthy install proves nothing on its own. The whole
// reason the shell probe exists is to catch the failure mode the direct probe
// cannot see: a managed command string that the hook runner's shell cannot
// launch. On Windows that is exactly what happened with POSIX single quotes.
//
// So this asserts the DISCRIMINATION, not just the happy path:
//
//   healthy (double-quoted)  -> shell probe exit 2   (deny observed)
//   faulty  (single-quoted)  -> shell probe exit != 2 (fault detected)
//   direct probe             -> exit 2 in BOTH cases
//
// The last line is the point Codex made: injecting a fault by breaking the hook
// FILE would fail the direct probe too and prove nothing about the shell layer.
// The fault must live only in the command string.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const HOOK = resolve(process.cwd(), "dist/hooks/approval-hook.js");
const NODE = process.execPath;

if (!existsSync(HOOK)) {
  console.error(`hook not found at ${HOOK} - run \`bun run build\` first`);
  process.exit(1);
}

const PAYLOAD = JSON.stringify({
  hook_event_name: "PreToolUse",
  session_id: "shell-probe-discrimination",
  cwd: process.cwd(),
  tool_name: "Bash",
  tool_input: { command: "echo probe" },
  tool_call_id: "probe-1",
});

const env = { ...process.env, KIMI_PLUGIN_CC_CMD: "review", KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "1" };
const opts = { input: PAYLOAD, encoding: "utf8", env, timeout: 20000 };

const sq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const dq = (s) => `"${s}"`;

const HEALTHY = `${dq(NODE)} ${dq(HOOK)}`;
const FAULTY = `${sq(NODE)} ${sq(HOOK)}`; // the exact shape of the original bug

let failures = 0;
const check = (label, actual, want, explain) => {
  const ok = want(actual);
  if (!ok) failures++;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${label.padEnd(46)} exit=${String(actual).padEnd(5)} ${explain}`);
};

console.log(`hook: ${HOOK}\n`);

// --- shell layer (how kimi-code invokes the hook on Windows: through ComSpec)
console.log("=== PROBE SHELL (via ComSpec, come kimi-code) ===");
const healthyShell = spawnSync(HEALTHY, { shell: true, ...opts }).status;
check("comando SANO (doppi apici)", healthyShell, (c) => c === 2, "deve NEGARE -> probe PASS");

const faultyShell = spawnSync(FAULTY, { shell: true, ...opts }).status;
check("comando GUASTO (apici singoli POSIX)", faultyShell, (c) => c !== 2, "deve FALLIRE -> probe FAIL");

// --- direct layer (no shell involved; must be blind to the quoting fault)
console.log("\n=== PROBE DIRETTO (nessuna shell) ===");
const direct = spawnSync(NODE, [HOOK], opts).status;
check("hook file valido", direct, (c) => c === 2, "deve NEGARE in ENTRAMBI i casi");

console.log(
  [
    "",
    "=== DISCRIMINAZIONE ===",
    `  probe shell:   sano=${healthyShell}  guasto=${faultyShell}  ${healthyShell === 2 && faultyShell !== 2 ? "DISCRIMINA" : "NON DISCRIMINA"}`,
    `  probe diretto: ${direct} in entrambi i casi (cieco al quoting, come deve essere)`,
    "",
    `=== ESITO: ${failures === 0 ? "PASS" : `FAIL (${failures})`} ===`,
  ].join("\n"),
);

process.exit(failures === 0 ? 0 : 1);
