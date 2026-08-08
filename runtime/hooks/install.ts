import { constants as fsConstants, existsSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { validateKimiHookSetForEnvironment } from "./config-safety.js";
import { evaluateInstalled, type HookCommandDrift } from "./managed-block.js";
import { resolveHostId, tryBuildExpectedHookCommand } from "./install-paths.js";
import { resolveKimiHome } from "../kimi-home.js";

/**
 * Verify that the kimi-plugin-cc PreToolUse hook is installed and
 * structurally valid in `~/.kimi-code/config.toml`, AND that its
 * `command = "..."` exactly matches the canonical shell command this
 * companion would write for the current env.
 *
 * PR 4 hardened the grammar (matcher rejection, duplicate detection,
 * etc.). The pre-tag audit (reports 27 + 28) found two further gaps,
 * both fixed here:
 *
 *   1. Optional `expectedHookPath` parameter → callers (rescue, ask,
 *      review, review-gate) all omitted it, so a managed block
 *      referencing a stale or missing hook script silently passed. The
 *      verifier now ALWAYS reconstructs the expected command from the
 *      current env (via `tryBuildExpectedHookCommand`) and equality-
 *      checks. There is no opt-out short of `KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1`.
 *
 *   2. The path check was substring (`commandPath.includes(hookPath)`),
 *      which a crafted command like `true # /path/to/approval-hook.js`
 *      passed: `/bin/sh -c "true # ..."` runs only `true` (exit 0),
 *      which kimi-code's hook runner treats as ALLOW. Equality on the
 *      full canonical shell command closes this.
 *
 *   3. A byte-exact `command` match does not prove the hook can actually
 *      run: if the versioned dist directory (or the whole plugin cache
 *      entry) is pruned after install, the managed block still matches
 *      while kimi-code's `/bin/sh -c '<node>' '<script>'` fails to spawn.
 *      kimi-code's hook runner only treats exit code 2 as a deny — any
 *      other exit (including a spawn/MODULE_NOT_FOUND failure) is ALLOW,
 *      so a missing script silently degrades every refusal gate to full
 *      auto-approve. The verifier now also confirms the hook script file
 *      exists and is readable before blessing a command match as installed.
 *
 * Tests / setup probes can opt out via
 * `KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1` — that bypass disables hook-install
 * refusal gates and the review gate's enforcement check, but cannot bypass the
 * independent experimental-v2 safety refusal in cli-client (documented in
 * `docs/safety.md`).
 */
export interface HookInstallStatus {
  installed: boolean;
  /** Human-readable reason (filled when `installed === false`). */
  reason?: string;
  /** Path examined. Useful for the warning message. */
  configPath: string;
  /**
   * Machine-readable drift classification (see `InstalledCheck.drift`).
   * Populated ONLY when the block is structurally sound but its command names
   * different paths — i.e. the recoverable "something moved" case, not
   * "something is wrong". Absent for every other refusal (unresolvable
   * command, unreadable config, invalid hook set, duplicate/orphan markers,
   * missing script): those are NOT re-pin-recoverable and a caller must not
   * treat them as such.
   *
   * Consumers: the refusal `RuntimeError.details` on every model-spawning
   * command, so the LLM caller can run /kimi:setup and retry ONCE instead of
   * dead-ending. The plugin itself never self-writes from this path — that
   * design was rejected by two adversarial reviews; see
   * `.claude/hook-pin-durability-spec-2026-07-25.md`.
   */
  drift?: HookCommandDrift;
  /**
   * Machine-readable refusal discriminator. Present only where `reason` alone
   * would be ambiguous to a non-human caller.
   *
   * `"node-bin-not-executable"` is the sole value today, and it marks the ONE
   * refusal whose remedy is NOT "run /kimi:setup": setup cannot repair a broken
   * Node install. Every other refusal emits an identical `{config_path}`
   * payload, so without this an agent caller cannot tell them apart and would
   * guess. See LLM-caller discipline in AGENTS.md.
   */
  refusalKind?: "node-bin-not-executable";
  /** The interpreter path that failed the probe (pairs with `refusalKind`). */
  nodeBin?: string;
}

export async function verifyHookInstalled(
  env: NodeJS.ProcessEnv,
): Promise<HookInstallStatus> {
  const configPath = resolveKimiCodeConfigPath(env);
  if (env.KIMI_PLUGIN_CC_SKIP_HOOK_CHECK === "1") {
    return { installed: true, configPath };
  }

  // Canonical expected shell command for the current env. If this
  // can't be resolved (KIMI_PLUGIN_CC_NODE_BIN not absolute,
  // install-paths module can't infer plugin root, etc.) treat the hook
  // as un-verifiable — installed=false with a structured reason. The
  // caller's stderr warning surfaces the underlying error code.
  const expected = tryBuildExpectedHookCommand(env);
  if ("error" in expected) {
    return {
      installed: false,
      reason: `unable to resolve canonical hook command for this companion: ${expected.error.message}`,
      configPath,
    };
  }

  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        installed: false,
        reason: "kimi-code config file does not exist",
        configPath,
      };
    }
    return {
      installed: false,
      reason: `failed to read kimi-code config: ${(err as Error).message}`,
      configPath,
    };
  }

  const hookSet = await validateKimiHookSetForEnvironment(raw, env);
  if (!hookSet.valid) {
    return {
      installed: false,
      reason: hookSet.reason ?? "configured hooks failed whole-array validation",
      configPath,
    };
  }

  // Pass `nodeExists` so a command MISMATCH is classified into an actionable
  // H4 diagnosis (Node upgrade / version-manager switch vs. plugin path drift)
  // instead of a raw expected-vs-got dump. Classification only refines the
  // reason; it never changes the installed=false decision.
  //
  // `hostId` selects THIS host's block in the shared config so Claude Code and
  // Codex verify their own managed block independently (v1.7.0 host scoping).
  const check = evaluateInstalled(raw, expected.command, {
    hostId: resolveHostId(env, expected.hookScriptPath),
    nodeExists: (binPath) => existsSync(binPath),
  });
  if (!check.installed) {
    return {
      installed: false,
      reason: check.reason,
      configPath,
      // Forwarded verbatim. Present only for a parseable path/binary mismatch;
      // the earlier short-circuits above (unresolvable command, unreadable
      // config, invalid hook set) return before this point and therefore never
      // carry drift — those are not re-pin-recoverable.
      ...(check.drift !== undefined ? { drift: check.drift } : {}),
    };
  }

  // The command matched byte-for-byte, but that alone doesn't prove the
  // hook can run — confirm the script it points at still exists and is
  // readable (see point 3 above). Fail closed on any stat/access error.
  try {
    await access(expected.hookScriptPath, fsConstants.R_OK);
  } catch {
    return {
      installed: false,
      reason: `hook script ${expected.hookScriptPath} is missing or unreadable — run /kimi:setup to reinstall`,
      configPath,
    };
  }

  // ...and confirm the pinned INTERPRETER is executable.
  //
  // SCOPE — read this before widening the claim. This is a NARROW BACKSTOP, not
  // the thing that catches a dead Node. Two adversarial reviews (2026-07-25)
  // rejected the original, wider rationale, and it was verified empirically:
  //
  //   - It does NOT catch a dangling Homebrew symlink. A dangling symlink cannot
  //     be exec'd at all, and `command -v node` skips it, so companion.sh (which
  //     `exec`s the binary it resolves, scripts/companion.sh:34,50) lands on a
  //     DIFFERENT node. The expected command is recomputed from the live process
  //     on every call, so it changes, and plain byte-exact equality above
  //     already refuses — with a RECOVERABLE `drift` that /kimi:setup converges.
  //   - It does NOT catch the 2026-07-25 dead-node zombie (a config pinning
  //     ~/.hermes/node). That is a byte mismatch, likewise caught above.
  //   - On the default path it is close to self-evident: `resolveNodeBinary`
  //     returns the path THIS process was launched through, which therefore
  //     existed and was executable moments ago.
  //
  // THE EXACT PREDICATE it covers: config and expected command still match
  // byte-for-byte, yet the Node token embedded in that command fails X_OK AT
  // VERIFICATION TIME. Three reachable ways to get there:
  //
  //   1. An absolute `KIMI_PLUGIN_CC_NODE_BIN` naming a binary that is NOT the
  //      running interpreter and is already dead — e.g. a pinned `nvm` version
  //      later `nvm uninstall`ed — reached by a direct `node dist/companion.js`
  //      that bypasses companion.sh's exec+version gate. The override is
  //      returned verbatim, so it is never proven by the running process.
  //   2. POST-LAUNCH MUTATION on the DEFAULT path (this one is easy to miss):
  //      the interpreter is valid at launch, so the process starts, and is then
  //      `chmod -x`'d. `realpathSync` still resolves it, so `preferStableNodePath`
  //      keeps argv0 and the bytes are unchanged — equality passes, X_OK fails.
  //   3. Same, but the pathname is REMOVED after launch. `realpathSync` throws
  //      and we fall back to `execPath`, which in argv0===execPath layouts
  //      (nvm/asdf) is the identical spelling — so equality still passes while
  //      the path is gone.
  //
  // In all three the old behavior was installed=true → `/bin/sh -c` exits 127 →
  // kimi-code reads any non-2 exit as ALLOW. Converting that to a refusal is
  // the whole value. Cases 2 and 3 are also why setup's stronger execution
  // probe is not a substitute: it runs at install/--check, whereas this reruns
  // before every model spawn and so catches degradation since the last probe.
  //
  // It proves the exec bit ONLY — not a working Node, not the right arch, not
  // >=22.5. The real proof is setup's shell probe, which EXECUTES the byte-
  // identical command (setup.ts::probeHook) and now fails install nonzero. The
  // verifier runs on every spawn and cannot afford a fork, so it approximates.
  //
  // Fail-closed on ANY errno, deliberately diverging from background-spawn.ts,
  // which ignores errnos outside ENOENT/EACCES/EPERM. Spawning can afford to try
  // and see; a security verifier cannot. Do not "harmonize" these.
  //
  // Not re-pin-recoverable: no `drift` is attached (drift only exists when the
  // equality check FAILS, so it can never displace a recoverable path), and
  // `hookRefusalDetails` therefore omits `retryable_after_setup`, which agent
  // callers map to "surface and stop." Setup cannot conjure a working Node.
  try {
    await access(expected.nodeBin, fsConstants.X_OK);
  } catch {
    return {
      installed: false,
      reason:
        `hook interpreter ${expected.nodeBin} is missing or not executable, so the PreToolUse hook ` +
        `cannot spawn (kimi-code reads a failed hook as ALLOW). Repair the Node install, or set ` +
        `KIMI_PLUGIN_CC_NODE_BIN to a valid Node >=22.5 executable and run /kimi:setup.`,
      configPath,
      // Machine-readable discriminator: this is the ONE refusal whose remedy is
      // NOT "run /kimi:setup" (LLM-caller discipline — an agent cannot read the
      // prose above, and every other refusal emits an identical `{config_path}`).
      refusalKind: "node-bin-not-executable",
      nodeBin: expected.nodeBin,
    };
  }

  return { installed: true, configPath };
}

function resolveKimiCodeConfigPath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveKimiHome(env), "config.toml");
}

/**
 * Format a stderr-suitable warning message for the missing-hook case.
 * Single source of truth so review.ts / review-gate.ts / ask.ts emit
 * identical language.
 */
/**
 * Structured `details` payload for a hook-refusal `RuntimeError`. Single source
 * of truth so all five model-spawning commands emit the same machine-readable
 * shape — an LLM caller cannot see stderr, so anything it must act on has to
 * ride the error's structured context (LLM-caller discipline, v0.3.6+).
 *
 * `drift_axis === "hook-script"` is the ONLY value a caller may treat as
 * retryable (run /kimi:setup for this host, retry once). Its absence means the
 * refusal is not a moved-path problem and re-running setup will not fix it.
 */
/**
 * Caller-facing self-heal protocol, appended to every hook-refusal message.
 *
 * The slash-command wrappers are deliberately thin, so the retry protocol
 * rides the refusal itself — the LLM caller reads it on stdout at exactly the
 * moment it applies, and one source here serves both hosts and all surfaces
 * (commands, agents, Codex skills) without duplicating it in each file.
 * Mirrors the fuller contract in agents/*.md: re-pin via setup, retry ONCE,
 * only on `retryable_after_setup: true` AND a zero setup exit; never the
 * skip env. Embeds the resolved plugin root so the command is runnable as-is.
 */
export function hookRefusalRetryProtocol(env: NodeJS.ProcessEnv): string {
  const root = env.CLAUDE_PLUGIN_ROOT ?? env.PLUGIN_ROOT ?? "${CLAUDE_PLUGIN_ROOT}";
  return (
    `If details shows retryable_after_setup:true (routine after a plugin update — the ` +
    `version-stamped hook path moved), run \`${root}/scripts/companion.sh setup\` and, only ` +
    `if it exits 0, retry the refused command once. Anything else — or a second refusal — ` +
    `surface the refusal instead of retrying.`
  );
}

export function hookRefusalDetails(status: HookInstallStatus): Record<string, unknown> {
  return {
    config_path: status.configPath,
    // Routes the caller to "tell the human to repair Node" instead of the
    // default "run /kimi:setup and retry" reflex. Never co-occurs with `drift`:
    // drift requires the equality check to FAIL, this requires it to PASS.
    ...(status.refusalKind !== undefined
      ? { refusal_kind: status.refusalKind, node_bin: status.nodeBin }
      : {}),
    ...(status.drift !== undefined
      ? {
          drift_axis: status.drift.axis,
          drift_installed_command: status.drift.installedCommand,
          drift_expected_command: status.drift.expectedCommand,
          // Retryable exactly when EVERY differing token is benign:
          //   - the hook script moved → the install path is version-stamped, so
          //     setup re-pins it to the running install.
          //   - the node token changed spelling but names the SAME file → not
          //     an interpreter move (this is the v1.9.0 re-pin, which also
          //     moves the script, hence axis "both").
          // A node token naming a DIFFERENT file is never retryable: the pinned
          // interpreter may be gone, and a hook that cannot spawn exits 127,
          // which kimi-code treats as ALLOW. Re-pinning would paper over a real
          // enforcement gap instead of surfacing it.
          retryable_after_setup:
            status.drift.axis === "hook-script" || status.drift.nodeInterpreterUnchanged === true,
        }
      : {}),
  };
}

export function formatHookMissingWarning(
  status: HookInstallStatus,
  commandLabel: string,
): string {
  return [
    "",
    "WARNING: kimi-plugin-cc safety hook is NOT installed (or is invalid).",
    `  Command: ${commandLabel}`,
    `  Config:  ${status.configPath}`,
    `  Reason:  ${status.reason ?? "unknown"}`,
    "",
    "  Without a valid PreToolUse hook, kimi-code's `-p` mode auto-approves",
    "  every tool call — including Bash, Write, Edit — even from commands",
    "  documented as read-only.",
    "",
    "  This command will not start a Kimi model run until enforcement is",
    "  repaired (the review gate skips instead of blocking stop).",
    "",
    "  Fix: run Claude Code `/kimi:setup` or Codex `$kimi-setup` to install",
    "  or repair this host's managed block in",
    "  ~/.kimi-code/config.toml. If you use nvm, asdf, mise, or fnm, you",
    "  must re-run `/kimi:setup` after any Node version switch — the",
    "  verifier pins the absolute Node binary path and a switch invalidates",
    "  the previously-installed block by design. See docs/safety.md.",
    "",
    "  KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1 explicitly bypasses hook-verification",
    "  refusals and restores un-enforced `permission: auto` execution. It does",
    "  NOT bypass the experimental-v2 safety refusal. Reserve it for tests or",
    "  diagnostics where the hook risk is intentional.",
    "",
  ].join("\n");
}

/**
 * Process-lifetime latch so commands don't spam the warning on every
 * call inside a single test run.
 */
let warnedThisProcess = false;

/**
 * Emit the warning to stderr at most once per process.
 *
 * Why stderr rather than stdout: stdout is reserved for the command's
 * load-bearing output (artifact prose, JSON envelopes). LLM-caller
 * discipline says stderr is humans-only, and this warning is exactly
 * that — a developer-facing nudge to run /kimi:setup before tagging.
 */
export function maybeWarnHookMissing(
  status: HookInstallStatus,
  commandLabel: string,
  stderr: NodeJS.WritableStream = process.stderr,
): void {
  if (status.installed) return;
  if (warnedThisProcess) return;
  warnedThisProcess = true;
  stderr.write(formatHookMissingWarning(status, commandLabel));
}

/** Test hook — resets the once-per-process latch. */
export function __resetHookMissingWarning(): void {
  warnedThisProcess = false;
}
