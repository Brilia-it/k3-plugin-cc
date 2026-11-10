// MODIFIED BY BRILIA (unofficial fork of linxule/kimi-plugin-cc, Apache-2.0).
// Changes are made for Windows: a shell probe that really runs through cmd.exe
// and names the cause of a failed exit, gated behind
// `process.platform === "win32"` (the hook path it probes is normalised in
// runtime/hooks/install-paths.ts). On every platform, setup also migrates what
// a pre-0.6 install left under upstream's names: it removes this fork's own
// hook blocks marked `kimi-plugin-cc-managed` (never another plugin's), moves
// the data directory to its new name, and reports KIMI_PLUGIN_CC_* variables it
// no longer reads. Also on every platform, `--check --probe-model [-m <model>]` sends
// one minimal prompt to the model, under the one-model-job admission, and reports
// the classified provider error. See NOTICE and README.md.
// Section 4(b) of the License requires this notice.

import { SETUP_SUPPORTED_FLAGS } from "../parsing.js";
// Managed-block installer for the load-bearing kimi-code PreToolUse hook.
// Without it, `kimi -p` auto-approves tool calls, including from read-only
// commands.
//
// Setup writes or refreshes a host-scoped BEGIN/END block containing the
// canonical `'<absolute-node>' '<absolute-hook-script>'` command from
// resolveNodeBinary/buildHookShellCommand. Both tokens are shell-quoted and the
// absolute Node path avoids PATH dependence under sanitized launches. Setup
// probes the hook directly with resolveNodeBinary and through `/bin/sh -c`
// using the exact installed command bytes. It also warns about broad permission
// denies, repairs orphan marker comments, and refuses remaining
// duplicate, orphaned, or malformed managed blocks.
//
// Subcommands: install (default), --check, --uninstall [--all], and
// --enable-review-gate/--disable-review-gate.
//
// Managed-block splicing is line-based and preserves user bytes outside owned
// edits; whole-file validation and inline-hook normalization use the TOML parser.

import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";

import { readPluginConfig, writePluginConfig } from "../config.js";
import { RuntimeError } from "../errors.js";
import {
  normalizeTopLevelInlineHooks,
  validateKimiHookSetForEnvironment,
  withKimiConfigLock,
} from "../hooks/config-safety.js";
import {
  buildHookShellCommand,
  hostIdFromHookCommand,
  resolveHookScriptPath,
  resolveHostId,
  resolveNodeBinary,
} from "../hooks/install-paths.js";
import {
  decodeManagedCommandLine,
  effectiveHost,
  evaluateInstalled,
  findUnmanagedApprovalHookBlocks,
  markerCommentLines,
  MARKERS,
  ORPHAN_MARKER_REMEDY,
  parseManagedBlock,
  type ManagedBlockEntry,
  type ManagedBlockState,
} from "../hooks/managed-block.js";
import { describeLegacyBrandBlocks, stripLegacyBrandBlocks } from "../hooks/legacy-brand.js";
import {
  collectLegacyEnvWarnings,
  describeDataDirMigration,
  describeLegacyDataDirInUse,
  migrateLegacyDataDir,
} from "../legacy-names.js";
import {
  formatVersionOutOfRangeWarning,
  probeKimiVersion,
} from "../kimi-version-probe.js";
import {
  isNativeV2CertifiedVersion,
  NATIVE_V2_CERTIFIED_VERSIONS,
  persistedExecutionPlanFields,
  prepareKimiExecutionPlan,
} from "../kimi-engine.js";
// BRILIA fork: what the opt-in model probe (setup --check --probe-model) needs.
import { createCliCancellationHandlers } from "../cli-cancellation.js";
import { runCliPromptWithBudget } from "../cli-client.js";
import { resolveRepoIdentity } from "../git.js";
import { JobStore } from "../job-store.js";
import { assertNoModelJobRunning, digestPrompt, normalizeJobError, sweepStaleJobs } from "../jobs.js";
import { classifySetupFailure } from "../kimi-errors.js";
import { KIMI_MODEL_PROBE_TIMEOUT_MS } from "../kimi-timeouts.js";
import { assertCliResultSuccess, reassembleProseFromRecords } from "./cli-helpers.js";
import { resolveKimiHome } from "../kimi-home.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import type { CommandContext } from "../types.js";
import { K3_PLUGIN_CC_VERSION } from "../version.js";
import { parse as parseToml } from "../vendor/smol-toml/parse.js";

const BEGIN_MARKER_PREFIX = "# === BEGIN k3-plugin-cc-managed";

const DEFAULT_HOOK_TIMEOUT_S = 15;

// Probe timing. The direct script probe is local and fast; allow 5s for
// node startup on cold CI runners. The shell probe adds /bin/sh fork
// overhead but should still complete well within the same budget.
const PROBE_TIMEOUT_MS = 5_000;

// Reject the specific control characters, double quotes, and backslashes matched
// below, including newlines and tabs; this is not a general shell-metacharacter
// filter. Normal install paths do not contain them, so a match indicates an
// unsafe override or an unusual layout that needs an explicit path change.
const PATH_FORBIDDEN_RE = /[\x00-\x1f"\\\n\r\t]/;

export type SetupAction = "install" | "uninstall" | "check";

export interface SetupResult {
  /** What the command did. */
  action: SetupAction;
  summary: string;
  /** Path that was inspected / written. */
  configPath: string;
  /** Resolved absolute path to the hook script the block references. */
  hookScriptPath: string;
  /** True when the install path wrote (or replaced) the managed block. */
  blockWritten: boolean;
  /** True when the uninstall path removed a managed block (or orphan). */
  blockRemoved: boolean;
  /** Probe outcome. Always `"skipped"` for uninstall. */
  probe: "ok" | "failed" | "skipped";
  /** Failure detail when probe === "failed". */
  probeError?: string;
  /**
   * BRILIA fork (2026-10-15): outcome of the opt-in `--probe-model` call. `"skipped"`
   * (the default) means NO model call was made. The plain `probe` above tests the
   * hook, not model access, plan, or quota.
   */
  modelProbe?: "ok" | "failed" | "skipped";
  /** Why the model probe failed or was skipped (classified provider error when there is one). */
  modelProbeDetail?: string;
  /** Classified kind of a failed model probe (quota_exhausted, plan_unavailable, ...). */
  modelProbeKind?: string;
  /** Warnings about user-side config that may interfere. */
  warnings: string[];
  reviewGateEnabled: boolean;
  nextStep: string;
  details: string[];
}

interface ParsedArgs {
  mode: SetupAction;
  enableReviewGate: boolean;
  disableReviewGate: boolean;
  /** `--uninstall --all`: remove EVERY host's managed block + orphan cruft. */
  removeAllHosts: boolean;
  /** BRILIA fork: `--check --probe-model` also sends one tiny prompt to the model. */
  probeModel: boolean;
  /** BRILIA fork: `-m/--model <name>` for the model probe. */
  model?: string;
  /** BRILIA fork: `--allow-concurrent` (only with the model probe): skip the one-job refusal. */
  allowConcurrent: boolean;
}

export async function runSetup(argv: string[], context: CommandContext): Promise<SetupResult> {
  const parsed = parseArgs(argv);

  const paths = resolvePluginPaths(context.env);
  await ensurePluginPaths(paths);

  // Reconcile the review-gate flag first — it's independent of the
  // kimi-code hook and we want the answer reflected in the result even
  // if the rest of setup fails.
  const existingConfig = await readPluginConfig(paths);
  const reviewGateEnabled = parsed.enableReviewGate
    ? true
    : parsed.disableReviewGate
      ? false
      : existingConfig.reviewGateEnabled;
  if (reviewGateEnabled !== existingConfig.reviewGateEnabled) {
    await writePluginConfig(paths, { reviewGateEnabled });
  }

  const configPath = resolveKimiCodeConfigPath(context.env);
  const hookScriptPath = resolveHookScriptPath(context.env);
  assertHookPathTomlSafe(hookScriptPath);
  // Host id scopes each managed block so Claude Code and Codex can share one
  // ~/.kimi-code/config.toml without clobbering each other.
  const hostId = resolveHostId(context.env, hookScriptPath);

  const warnings: string[] = [];

  switch (parsed.mode) {
    case "uninstall":
      return withSkippedModelProbe(await runUninstall(
        configPath,
        hookScriptPath,
        hostId,
        parsed.removeAllHosts,
        reviewGateEnabled,
        warnings,
        context,
      ));
    case "check": {
      const checked = await runCheck(configPath, hookScriptPath, hostId, reviewGateEnabled, warnings, context);
      return parsed.probeModel
        ? await applyModelProbe(checked, { model: parsed.model, allowConcurrent: parsed.allowConcurrent }, context)
        : withSkippedModelProbe(checked);
    }
    case "install":
      return withSkippedModelProbe(await runInstall(configPath, hookScriptPath, hostId, reviewGateEnabled, warnings, context));
  }
}

function withSkippedModelProbe(result: SetupResult): SetupResult {
  return { ...result, modelProbe: "skipped" };
}

// BRILIA fork (2026-10-15 incident): `setup --check` printed "Probe: ok" minutes before
// three jobs were refused by the plan's usage limit, because that probe exercises the
// PreToolUse hook and never touches the model. This opt-in probe sends ONE short
// prompt through the same CLI path as `ask` (read-only label, hook enforced, thinking
// requested off) and reports the classified provider error. It costs a (very small)
// call against the quota, which is why it is opt-in and never part of the plain --check.
const MODEL_PROBE_PROMPT = "Reply with the single word READY.";
// The probe asks for thinking off (upstream 2.2.1 `--thinking`, passed to the child as
// KIMI_MODEL_THINKING_EFFORT): honoured by Kimi's own providers on models that can turn
// thinking off, ignored silently by the others; the plugin cannot observe it.
const MODEL_PROBE_THINKING_EFFORT = "off";

async function applyModelProbe(
  checked: SetupResult,
  options: { model?: string; allowConcurrent: boolean },
  context: CommandContext,
): Promise<SetupResult> {
  const { model, allowConcurrent } = options;
  if (checked.probe !== "ok") {
    return {
      ...checked,
      modelProbe: "skipped",
      modelProbeDetail: "the hook probe did not pass, so no model call was made",
    };
  }
  // The probe is a model call, so it goes through the same admission as
  // ask/review/rescue: it refuses while a job runs (unless --allow-concurrent), and
  // while it runs it holds a running row that other commands see; the row is
  // released on every terminal path (the finally below).
  const paths = resolvePluginPaths(context.env);
  const store = new JobStore(paths);
  let probeJobId: string | null = null;
  let probeError: unknown;
  // Cancellation reaches the kimi child: `/k3:cancel` SIGTERMs the companion; these
  // handlers abort the CLI client, whose teardown is a settlement barrier, and only
  // then (finally below) is the reservation row released.
  const handlers = createCliCancellationHandlers();
  try {
    await sweepStaleJobs(store, paths);
    assertNoModelJobRunning(store, "setup", allowConcurrent);
    const executionPlan = await prepareKimiExecutionPlan({
      operationKind: "ask",
      cwd: context.cwd,
      env: context.env,
    });
    const repoIdentity = await resolveRepoIdentity(context.cwd);
    const jobId = randomUUID();
    store.createJob(
      {
        job_id: jobId,
        repo_id: repoIdentity.repoId,
        command_type: "ask",
        cwd: context.cwd,
        model: model ?? null,
        thinking: null,
        thinking_effort: MODEL_PROBE_THINKING_EFFORT,
        background: false,
        budget_ms: KIMI_MODEL_PROBE_TIMEOUT_MS,
        budget_source: "default",
        pid: process.pid,
        kimi_pid: null,
        status: "running",
        kimi_session_id: null,
        ...persistedExecutionPlanFields(executionPlan),
        // Distinct identity: visible to admission, never picked as a user's latest ask.
        operation_kind: "model_probe",
        agent_profile: "<cli-client>",
        prompt_digest: digestPrompt(MODEL_PROBE_PROMPT),
        summary: "Model probe (setup --check --probe-model).",
        phase: "model-probe",
        final_output_path: null,
        stream_log_path: path.join(paths.logsDir, `setup-probe-${jobId}.jsonl`),
        error: null,
      },
      { commandType: "setup", allowConcurrent },
    );
    probeJobId = jobId;
    const result = await runCliPromptWithBudget(
      {
        cwd: context.cwd,
        env: context.env,
        command: executionPlan.command,
        prefixArgs: [...executionPlan.prefixArgs],
        executionPlan,
        prompt: MODEL_PROBE_PROMPT,
        commandLabel: "ask",
        model,
        thinkingEffort: MODEL_PROBE_THINKING_EFFORT,
        logPath: path.join(paths.logsDir, `setup-probe-${jobId}.jsonl`),
        onSpawn: (pid) => { store.updateRunningJob(jobId, { kimi_pid: pid }); },
        signal: handlers.signal,
      },
      KIMI_MODEL_PROBE_TIMEOUT_MS,
      "setup.model-probe",
    );
    assertCliResultSuccess(result, "setup.model-probe");
    if (reassembleProseFromRecords(result.records).trim().length === 0) {
      probeError = new RuntimeError("SETUP_MODEL_PROBE_EMPTY", "the model answered with an empty reply", "setup.model-probe");
      return {
        ...checked,
        modelProbe: "failed",
        modelProbeDetail: "the model answered with an empty reply",
        nextStep: "The model call returned nothing; retry, or pick another model with -m.",
      };
    }
    store.markCompleted(jobId, {
      summary: "Model probe answered.",
      phase: "done",
      final_output_path: null,
      error: null,
    });
    probeJobId = null;
    return {
      ...checked,
      modelProbe: "ok",
      modelProbeDetail: model
        ? `one prompt was answered by model ${model}`
        : "one prompt was answered by the default model",
    };
  } catch (error) {
    probeError = error;
    if (error instanceof RuntimeError && error.code.endsWith("_JOB_ALREADY_RUNNING")) {
      return {
        ...checked,
        modelProbe: "failed",
        modelProbeKind: "job_already_running",
        modelProbeDetail: error.message,
        nextStep: `Model probe refused: ${error.message}`,
      };
    }
    const classification = classifySetupFailure(error, { omitResumeHint: true });
    const detail = classification
      ? `${classification.summary} ${classification.nextStep}`
      : `the model call failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
    return {
      ...checked,
      modelProbe: "failed",
      modelProbeKind: classification?.kind,
      modelProbeDetail: detail,
      nextStep: `Model probe failed: ${detail}`,
    };
  } finally {
    try {
      if (probeJobId !== null) {
        // Every non-success terminal path (failure, timeout, exception, cancellation)
        // releases the row, after the child has been torn down.
        const patch = {
          summary: handlers.cancelling ? "Model probe cancelled." : "Model probe failed.",
          error: normalizeJobError(probeError ?? new Error("model probe ended without a result")),
          phase: handlers.cancelling ? "cancelled" : "failed",
        };
        if (handlers.cancelling) {
          store.markCancelled(probeJobId, patch);
        } else {
          store.markFailed(probeJobId, patch);
        }
      }
    } finally {
      handlers.dispose();
      store.close();
    }
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  let mode: SetupAction = "install";
  let enableReviewGate = false;
  let disableReviewGate = false;
  let removeAllHosts = false;
  let probeModel = false;
  let allowConcurrent = false;
  let model: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    switch (token) {
      // BRILIA fork: the opt-in model probe and its options.
      case "--probe-model":
        probeModel = true;
        break;
      case "--allow-concurrent":
        allowConcurrent = true;
        break;
      case "-m":
      case "--model": {
        const value = argv[index + 1];
        if (!value || value.startsWith("-")) {
          throw new RuntimeError("INVALID_ARGS", `${token} requires a model name.`, "setup.parse");
        }
        model = value;
        index += 1;
        break;
      }
      case "--check":
        if (mode === "uninstall") {
          throw new RuntimeError(
            "INVALID_ARGS",
            "setup accepts at most one of --check, --uninstall.",
            "setup.parse",
          );
        }
        mode = "check";
        break;
      case "--uninstall":
        if (mode === "check") {
          throw new RuntimeError(
            "INVALID_ARGS",
            "setup accepts at most one of --check, --uninstall.",
            "setup.parse",
          );
        }
        mode = "uninstall";
        break;
      case "--all":
        removeAllHosts = true;
        break;
      case "--enable-review-gate":
        enableReviewGate = true;
        break;
      case "--disable-review-gate":
        disableReviewGate = true;
        break;
      default:
        throw new RuntimeError(
          "INVALID_ARGS",
          `Unknown setup flag ${token}. Supported flags: ${SETUP_SUPPORTED_FLAGS}.`,
          "setup.parse",
        );
    }
  }

  if (enableReviewGate && disableReviewGate) {
    throw new RuntimeError(
      "INVALID_ARGS",
      "setup accepts either --enable-review-gate or --disable-review-gate, not both.",
      "setup.parse",
    );
  }

  if (removeAllHosts && mode !== "uninstall") {
    throw new RuntimeError(
      "INVALID_ARGS",
      "--all is only valid with --uninstall (it removes EVERY host's managed block).",
      "setup.parse",
    );
  }

  if (probeModel && mode !== "check") {
    throw new RuntimeError(
      "INVALID_ARGS",
      "--probe-model is only valid with --check (it sends one prompt to the model).",
      "setup.parse",
    );
  }

  if (allowConcurrent && !probeModel) {
    throw new RuntimeError(
      "INVALID_ARGS",
      "--allow-concurrent is only valid with --check --probe-model for setup.",
      "setup.parse",
    );
  }

  if (model !== undefined && !probeModel) {
    throw new RuntimeError(
      "INVALID_ARGS",
      "-m/--model is only valid with --check --probe-model for setup.",
      "setup.parse",
    );
  }

  return { mode, enableReviewGate, disableReviewGate, removeAllHosts, probeModel, model, allowConcurrent };
}

async function runInstall(
  configPath: string,
  hookScriptPath: string,
  hostId: string,
  reviewGateEnabled: boolean,
  warnings: string[],
  context: CommandContext,
): Promise<SetupResult> {
  await assertHookScriptExists(hookScriptPath);

  const mutation = await withKimiConfigLock(configPath, async () => {
    const original = await readConfigSafe(configPath);
    const lineEnding = detectLineEnding(original);
    try { parseToml(original); } catch { await assertKimiHookSetValid(original, configPath, "setup.install", context.env); }
    const repaired = removeOrphanMarkers(original);
    if (repaired.count > 0) {
      warnings.push(`Removed ${repaired.count} orphaned managed marker comment(s); surrounding config was preserved.`);
    }
    const inlineHooks = normalizeTopLevelInlineHooks(repaired.contents, lineEnding);
    if (inlineHooks.found) {
      // Validate before normalizing so an invalid inline entry is reported
      // against the user's original bytes and the config remains untouched.
      await assertKimiHookSetValid(original, configPath, "setup.install", context.env);
      if (!inlineHooks.converted) {
        throw new RuntimeError(
          "SETUP_INVALID_HOOKS_CONFIG",
          `Could not safely convert the top-level inline hooks assignment in ${configPath}; the existing config was left unchanged.`,
          "setup.install",
          { details: { configPath } },
        );
      }
      warnings.push(
        `Converted the top-level inline hooks array (${inlineHooks.entryCount} entr${inlineHooks.entryCount === 1 ? "y" : "ies"}) to canonical [[hooks]] tables before installing. Surrounding config bytes were preserved; formatting and comments inside that hooks assignment were normalized.`,
      );
    }

    // BRILIA fork (0.6.0): remove THIS HOST's pre-0.6 blocks, written by this
    // fork under upstream's marker, BEFORE the orphan prune below. The prune
    // would otherwise cut their [[hooks]] table (it is ours, and outside any
    // current-marker block) and leave the old marker lines dangling, where the
    // upstream plugin would read them as its own orphans. Blocks under the old
    // marker that are not ours are kept byte for byte.
    const expectedCommand = buildHookShellCommand(hookScriptPath, context.env);
    const legacyBrand = stripLegacyBrandBlocks(inlineHooks.contents, lineEnding, hostId, expectedCommand);
    if (legacyBrand.unconfirmed.length > 0) {
      // The TOML parser does not confirm that removing them changes only
      // those hooks. Stop before touching the file: the orphan prune below
      // would otherwise work on text this setup does not understand.
      throw new RuntimeError(
        "SETUP_LEGACY_BLOCK_UNCONFIRMED",
        describeLegacyBrandBlocks([], [], "found", [], legacyBrand.unconfirmed).join(" ") +
          ` ${configPath} was left unchanged; run /k3:setup again once they are gone.`,
        "setup.install",
        { details: { configPath, lines: legacyBrand.unconfirmed.map((b) => b.beginLine + 1) } },
      );
    }
    warnings.push(...describeLegacyBrandBlocks(legacyBrand.removed, legacyBrand.kept, "removed", legacyBrand.strayMarkers));

    // Prune only this host's orphaned marker-less entries before computing
    // splice line numbers. Another host's marker-less table may be its live hook
    // after a config rewrite strips comments, so it must remain untouched.
    const { pruned, count: prunedCount, commands: prunedCommands } =
      pruneOrphanApprovalHooks(legacyBrand.stripped, hostId, expectedCommand);
    const existing = pruned;
    if (prunedCount > 0) {
      const readorned = prunedCommands.includes(expectedCommand);
      warnings.push(
        readorned
          ? `Re-adorned this host's managed-block markers: kimi-code rewrites its config on login/settings changes and strips all comments (markers included), leaving the hook enforcing but unmarked. Replaced the bare hook table with a freshly marked block (${prunedCount} table(s) refreshed). Enforcement was never interrupted.`
          : `Pruned ${prunedCount} stale marker-less k3-plugin-cc hook block(s) left by this host's earlier installs. This is a cleanup — your active hook is unaffected.`,
      );
    }

    const { state, blocks } = parseManagedBlock(existing, hostId);

    if (state.kind === "orphan") {
      throw new RuntimeError(
        "SETUP_ORPHAN_MARKERS",
        [
          `kimi-code config at ${configPath} contains an orphaned ${state.detail} marker.`,
          "Inspect the managed marker comments and re-run setup.",
        ].join(" "),
        "setup.install",
        { details: { configPath, orphan: state.detail } },
      );
    }
    if (state.kind === "duplicate") {
      throw new RuntimeError(
        "SETUP_DUPLICATE_BLOCKS",
        [
          `kimi-code config at ${configPath} contains ${state.beginLines.length} k3-plugin-cc managed blocks for host ${hostId} (lines ${state.beginLines
            .map((line) => line + 1)
            .join(", ")}).`,
          "This usually means two /k3:setup runs raced. Run `/k3:setup --uninstall` to clear them, then `/k3:setup` again.",
        ].join(" "),
        "setup.install",
        { details: { configPath, beginLines: state.beginLines } },
      );
    }

    // Non-blocking note: other hosts (e.g. Codex) manage their own block in the
    // same shared config — surface so an operator understands the coexistence.
    const otherHosts = [
      ...new Set(blocks.map((b) => effectiveHost(b, hostId)).filter((h) => h !== hostId)),
    ];
    if (otherHosts.length > 0) {
      warnings.push(
        `Other host(s) also manage a block in this shared config: ${otherHosts.join(", ")}. ` +
          `They are left untouched — each host owns its own PreToolUse block.`,
      );
    }

    const block = buildManagedBlock(hookScriptPath, context.env, lineEnding, hostId);
    const next = state.kind === "found"
      ? spliceBlock(existing, state.beginLine, state.endLine, block, lineEnding)
      : insertBlockNearManagedBlocks(existing, blocks, block, lineEnding);
    await assertKimiHookSetValid(next, configPath, "setup.install", context.env);

    const blockWritten = next !== original;
    if (blockWritten) await writeConfigAtomic(configPath, next);
    return { blockWritten, next };
  });
  const { blockWritten, next } = mutation;

  // BRILIA fork (0.6.0): the rest of the pre-0.6 names. Neither step can fail
  // the install: the data directory in use stays usable whatever happens.
  const dataDirNote = describeDataDirMigration(await migrateLegacyDataDir(context.env));
  if (dataDirNote !== null) warnings.push(dataDirNote);
  collectLegacyEnvWarnings(context.env, warnings);

  collectPermissionRuleWarnings(next, warnings);
  await collectKimiVersionWarnings(context.env, warnings);
  await collectInstalledKimiPluginsNotice(context.env, warnings);

  const probe = await probeHook(hookScriptPath, context.env);

  const summary = probe.ok
    ? blockWritten
      ? `Installed k3-plugin-cc PreToolUse hook in ${configPath}.`
      : `k3-plugin-cc PreToolUse hook already up to date in ${configPath}.`
    : `Wrote managed block to ${configPath} but the hook script probe failed.`;
  return {
    action: "install",
    summary,
    configPath,
    hookScriptPath,
    blockWritten,
    blockRemoved: false,
    probe: probe.ok ? "ok" : "failed",
    probeError: probe.ok ? undefined : probe.reason,
    warnings,
    reviewGateEnabled,
    nextStep: probe.ok
      ? "Run /k3:review, /k3:challenge, /k3:ask, or /k3:rescue. Codex users can invoke the matching $k3-* skills."
      : "Re-run /k3:setup after installing kimi-code and Node. If the probe keeps failing, run /k3:setup --uninstall and inspect ~/.kimi-code/config.toml manually.",
    details: buildDetails({
      configPath,
      hookScriptPath,
      reviewGateEnabled,
      probe,
      warnings,
      hostId,
    }),
  };
}

async function runCheck(
  configPath: string,
  hookScriptPath: string,
  hostId: string,
  reviewGateEnabled: boolean,
  warnings: string[],
  context: CommandContext,
): Promise<SetupResult> {
  const existing = await readConfigSafe(configPath);
  const hookSet = await validateKimiHookSetForEnvironment(existing, context.env);
  if (!hookSet.valid) {
    const reason = hookSet.reason ?? "configured hooks failed validation";
    return {
      action: "check",
      summary: `kimi-code hook configuration is invalid; the configured hooks array will not load.`,
      configPath,
      hookScriptPath,
      blockWritten: false,
      blockRemoved: false,
      probe: "failed",
      probeError: reason,
      warnings,
      reviewGateEnabled,
      nextStep:
        "Repair or remove the invalid [[hooks]] entry named above, then run /k3:setup --check again. No model call is required.",
      details: buildDetails({
        configPath,
        hookScriptPath,
        reviewGateEnabled,
        probe: { ok: false, reason },
        warnings,
        hostId,
      }),
    };
  }
  const expectedCommand = buildHookShellCommand(hookScriptPath, context.env);
  // nodeExists refines mismatch prose into drift classification; hostId checks
  // only this host's block in the shared config.
  const installedCheck = evaluateInstalled(existing, expectedCommand, {
    hostId,
    nodeExists: (binPath) => existsSync(binPath),
  });

  // BRILIA fork (0.6.0): what a pre-0.6 install left under upstream's names.
  // Reported, never a failure of the check: those blocks no longer protect K3
  // sessions, and this host's block (checked above) is the one that does.
  const checkLineEnding = detectLineEnding(existing);
  const legacyBrand = stripLegacyBrandBlocks(existing, checkLineEnding, hostId, expectedCommand);
  warnings.push(
    ...describeLegacyBrandBlocks(legacyBrand.removed, legacyBrand.kept, "found", legacyBrand.strayMarkers, legacyBrand.unconfirmed),
  );
  const legacyDataNote = describeLegacyDataDirInUse(context.env);
  if (legacyDataNote !== null) warnings.push(legacyDataNote);
  collectLegacyEnvWarnings(context.env, warnings);

  // Non-blocking coexistence + cruft notices.
  const { blocks: allBlocks, foreignOrphans } = parseManagedBlock(existing, hostId);
  for (const orphan of foreignOrphans) {
    warnings.push(
      `Host "${orphan.hostId}" has an orphaned ${orphan.detail} managed marker at line ${orphan.line + 1}; that host's commands refuse until it is repaired. ${ORPHAN_MARKER_REMEDY}`,
    );
  }
  const otherHosts = [
    ...new Set(allBlocks.map((b) => effectiveHost(b, hostId)).filter((h) => h !== hostId)),
  ];
  if (otherHosts.length > 0) {
    warnings.push(
      `Other host(s) also manage a block in this shared config: ${otherHosts.join(", ")} (coexisting, untouched).`,
    );
  }
  // Config rewrites can strip markers while leaving each host's table enforcing.
  // Our exact-command table is live; our stale table is prunable; another host's
  // table is reported but left strictly alone.
  // BRILIA fork: our pre-0.6 blocks (any host) are reported above; their
  // [[hooks]] table would otherwise be counted again here as a marker-less
  // stale table.
  const bareTables = findUnmanagedApprovalHookBlocks(
    stripLegacyBrandBlocks(existing, checkLineEnding, undefined, expectedCommand).stripped,
  );
  const ownStale = bareTables.filter(
    (t) => hostIdFromHookCommand(t.command) === hostId && t.command !== expectedCommand,
  );
  const foreignHosts = [
    ...new Set(
      bareTables
        // Exact current command bytes identify this host even when a host-id
        // override disagrees with the path-derived host.
        .filter((t) => t.command !== expectedCommand)
        .map((t) => hostIdFromHookCommand(t.command))
        .filter((h): h is string => h !== null && h !== hostId),
    ),
  ];
  if (ownStale.length > 0) {
    warnings.push(
      `Found ${ownStale.length} stale marker-less k3-plugin-cc hook block(s) from this host's earlier installs. ` +
        `Run /k3:setup to refresh, or /k3:setup --uninstall --all to clear everything.`,
    );
  }
  for (const host of foreignHosts) {
    warnings.push(
      `Host "${host}" has a marker-less k3-plugin-cc hook block (kimi-code config rewrites strip comments). ` +
        `It still enforces and is left untouched; run that host's setup to re-adorn its markers.`,
    );
  }
  if (installedCheck.installed && installedCheck.note !== undefined) {
    warnings.push(`Note: ${installedCheck.note}`);
  }

  if (!installedCheck.installed) {
    return {
      action: "check",
      summary:
        installedCheck.state.kind === "absent"
          ? `k3-plugin-cc managed block is NOT installed in ${configPath}.`
          : `k3-plugin-cc managed block is present but invalid: ${installedCheck.reason}.`,
      configPath,
      hookScriptPath,
      blockWritten: false,
      blockRemoved: false,
      probe: "failed",
      probeError: installedCheck.reason ?? "managed block missing or invalid",
      warnings,
      reviewGateEnabled,
      nextStep:
        installedCheck.state.kind === "absent"
          ? "Run /k3:setup (without --check) to install the managed block."
          : installedCheck.state.kind === "orphan"
            ? ORPHAN_MARKER_REMEDY
            : "Run /k3:setup --uninstall, then /k3:setup to repair.",
      details: buildDetails({
        configPath,
        hookScriptPath,
        reviewGateEnabled,
        probe: { ok: false, reason: installedCheck.reason ?? "block missing/invalid" },
        warnings,
      }),
    };
  }

  collectPermissionRuleWarnings(existing, warnings);
  await collectKimiVersionWarnings(context.env, warnings);
  await collectInstalledKimiPluginsNotice(context.env, warnings);

  // Block is structurally valid AND points at the resolved hook
  // script — now confirm the script itself still loads and behaves.
  try {
    await assertHookScriptExists(hookScriptPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      action: "check",
      summary: `Managed block references ${hookScriptPath} but that path is unreadable.`,
      configPath,
      hookScriptPath,
      blockWritten: false,
      blockRemoved: false,
      probe: "failed",
      probeError: message,
      warnings,
      reviewGateEnabled,
      nextStep:
        "Reinstall the plugin so dist/hooks/approval-hook.js is present, or run /k3:setup to refresh the managed block.",
      details: buildDetails({
        configPath,
        hookScriptPath,
        reviewGateEnabled,
        probe: { ok: false, reason: message },
        warnings,
      }),
    };
  }

  const probe = await probeHook(hookScriptPath, context.env);

  return {
    action: "check",
    summary: probe.ok
      ? `k3-plugin-cc PreToolUse hook is installed and probe passed.`
      : `Managed block is installed but probe failed (${probe.reason}).`,
    configPath,
    hookScriptPath,
    blockWritten: false,
    blockRemoved: false,
    probe: probe.ok ? "ok" : "failed",
    probeError: probe.ok ? undefined : probe.reason,
    warnings,
    reviewGateEnabled,
    nextStep: !probe.ok
      ? "Run /k3:setup to repair the managed block, or /k3:setup --uninstall if you want to remove the integration."
      : installedCheck.via === "bare-table"
        // Enforcement remains active through the marker-less table, but recommend
        // re-adorning rather than claiming no action is needed.
        ? "Enforcement is active. Run /k3:setup to re-adorn this host's managed-block markers — kimi-code stripped them on its last config write (comments are not preserved). Your hook keeps working meanwhile."
        : "No action needed.",
    details: buildDetails({
      configPath,
      hookScriptPath,
      reviewGateEnabled,
      probe,
      warnings,
      hostId,
    }),
  };
}

async function runUninstall(
  configPath: string,
  hookScriptPath: string,
  hostId: string,
  removeAllHosts: boolean,
  reviewGateEnabled: boolean,
  warnings: string[],
  context: CommandContext,
): Promise<SetupResult> {
  return await withKimiConfigLock(configPath, () =>
    runUninstallLocked(
      configPath,
      hookScriptPath,
      hostId,
      removeAllHosts,
      reviewGateEnabled,
      warnings,
      context,
    )
  );
}

async function runUninstallLocked(
  configPath: string,
  hookScriptPath: string,
  hostId: string,
  removeAllHosts: boolean,
  reviewGateEnabled: boolean,
  warnings: string[],
  context: CommandContext,
): Promise<SetupResult> {
  const existing = await readConfigSafe(configPath);
  if (existing.length === 0) {
    return {
      action: "uninstall",
      summary: `Nothing to remove — ${configPath} does not exist or is empty.`,
      configPath,
      hookScriptPath,
      blockWritten: false,
      blockRemoved: false,
      probe: "skipped",
      warnings,
      reviewGateEnabled,
      nextStep: "Run /k3:setup to install the managed block again.",
      details: buildDetails({
        configPath,
        hookScriptPath,
        reviewGateEnabled,
        probe: { ok: true, reason: "no-op (config absent)" },
        warnings,
      }),
    };
  }

  // Scoped uninstall removes only this host's marked and marker-less blocks;
  // other hosts' blocks and live marker-less tables remain intact. `--all` is
  // the explicit every-host sweep for all of this plugin's hook tables.
  const { stripped: strippedCurrent, removedBlocks: currentRemoved, orphansLeft } = stripManagedBlocks(
    existing,
    hostId,
    removeAllHosts,
  );
  // Exact current command bytes also identify this host's table when a host-id
  // override disagrees with path derivation or a dev path is outside the strict
  // ownership pattern.
  const expectedCommand = buildHookShellCommand(hookScriptPath, context.env);
  // BRILIA fork (0.6.0): this fork's pre-0.6 blocks under upstream's marker go
  // too (this host's, or every host's with --all). Another plugin's are kept.
  // After the current-marker strip, so the orphan line numbers above refer to
  // the file as the user sees it.
  const legacyBrand = stripLegacyBrandBlocks(
    strippedCurrent,
    detectLineEnding(existing),
    removeAllHosts ? undefined : hostId,
    expectedCommand,
  );
  if (legacyBrand.unconfirmed.length > 0) {
    // As on install: stop before the orphan prune below works on text this
    // setup does not understand.
    throw new RuntimeError(
      "SETUP_LEGACY_BLOCK_UNCONFIRMED",
      describeLegacyBrandBlocks([], [], "found", [], legacyBrand.unconfirmed).join(" ") +
        ` ${configPath} was left unchanged; run /k3:setup --uninstall again once they are gone.`,
      "setup.uninstall",
      { details: { configPath, lines: legacyBrand.unconfirmed.map((b) => b.beginLine + 1) } },
    );
  }
  if (legacyBrand.removed.length > 0) {
    warnings.push(
      `Also removed ${legacyBrand.removed.length} block(s) written by k3-plugin-cc before 0.6.0 under the old marker \`kimi-plugin-cc-managed\`.`,
    );
  }
  // Blocks left in place and stray old-marker lines are reported as on install.
  warnings.push(
    ...describeLegacyBrandBlocks([], legacyBrand.kept, "removed", legacyBrand.strayMarkers, legacyBrand.unconfirmed),
  );
  const strippedMarkers = legacyBrand.stripped;
  const removedBlocks = currentRemoved + legacyBrand.removed.length;
  const { pruned: stripped, count: prunedCount } = pruneOrphanApprovalHooks(
    strippedMarkers,
    removeAllHosts ? undefined : hostId,
    expectedCommand,
  );
  const changed = stripped !== existing;
  if (changed) {
    await writeConfigAtomic(configPath, stripped);
  }

  if (orphansLeft.length > 0) {
    warnings.push(
      `Detected ${orphansLeft.length} orphan marker line(s) at ${orphansLeft
        .map((line) => `line ${line + 1}`)
        .join(", ")}. Removed the marker line(s) but preserved surrounding user content — verify the config visually.`,
    );
  }
  if (prunedCount > 0) {
    warnings.push(
      `Pruned ${prunedCount} orphaned k3-plugin-cc hook block(s) with no managed marker.`,
    );
  }
  const { blocks: remainingBlocks } = parseManagedBlock(stripped, hostId);
  const remainingHosts = [
    ...new Set(remainingBlocks.map((b) => effectiveHost(b, hostId))),
  ];
  if (!removeAllHosts && remainingHosts.length > 0) {
    warnings.push(
      `Left ${remainingHosts.length} other host block(s) in place: ${remainingHosts.join(", ")}. ` +
        `Use \`/k3:setup --uninstall --all\` to remove every host's block.`,
    );
  }

  return {
    action: "uninstall",
    summary: changed
      ? `Removed ${removedBlocks} managed block(s)${prunedCount > 0 ? ` + ${prunedCount} orphan hook block(s)` : ""} from ${configPath}.`
      : `No k3-plugin-cc managed block to remove from ${configPath}.`,
    configPath,
    hookScriptPath,
    blockWritten: false,
    blockRemoved: changed,
    probe: "skipped",
    warnings,
    reviewGateEnabled,
    nextStep: changed
      ? "Run /k3:setup again to reinstall the hook, or leave the plugin uninstalled."
      : "Run /k3:setup to install the hook.",
    details: buildDetails({
      configPath,
      hookScriptPath,
      reviewGateEnabled,
      probe: { ok: true, reason: changed ? `removed ${removedBlocks} block(s)` : "no-op (no markers)" },
      warnings,
    }),
  };
}

// ----- Config IO ---------------------------------------------------------

async function readConfigSafe(configPath: string): Promise<string> {
  try {
    return await readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw new RuntimeError(
      "SETUP_CONFIG_READ_FAILED",
      `Failed to read kimi-code config at ${configPath}: ${(err as Error).message}`,
      "setup.read-config",
      err instanceof Error ? { cause: err, details: { configPath } } : { details: { configPath } },
    );
  }
}

async function writeConfigAtomic(configPath: string, contents: string): Promise<void> {
  // Write a unique sibling temp file and atomically rename it. O_EXCL prevents
  // concurrent operations from sharing an intermediate path.
  //
  // Pass 0o600 at creation, not in a later chmod: the config can contain
  // credentials, so the temp file must never exist with a wider umask-derived
  // mode.
  await mkdir(path.dirname(configPath), { recursive: true });
  const suffix = randomBytes(8).toString("hex");
  const tmpPath = `${configPath}.k3-plugin-cc.${process.pid}.${suffix}.tmp`;
  const openFlags =
    fsConstants.O_WRONLY |
    fsConstants.O_CREAT |
    fsConstants.O_EXCL |
    (fsConstants.O_NOFOLLOW ?? 0);
  try {
    const handle = await open(tmpPath, openFlags, 0o600);
    try {
      if (process.platform !== "win32") {
        // Windows file modes are emulated; skip the chmod to avoid
        // platform-specific noise. The threat model excludes Windows.
        // Belt-and-suspenders alongside the create-time mode above,
        // matching createPrivateLockFile's pattern.
        await handle.chmod(0o600);
      }
      await handle.writeFile(contents, "utf8");
    } finally {
      await handle.close();
    }
    await rename(tmpPath, configPath);
  } catch (err) {
    // Best-effort cleanup so stale tmp files don't accumulate.
    try {
      await unlink(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}

async function assertKimiHookSetValid(
  contents: string,
  configPath: string,
  stage: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const validation = await validateKimiHookSetForEnvironment(contents, env);
  if (validation.valid) return;
  throw new RuntimeError(
    "SETUP_INVALID_HOOKS_CONFIG",
    `${validation.reason ?? "Configured hooks failed validation"} Repair or remove that [[hooks]] entry before rerunning /k3:setup; the existing config was left unchanged.`,
    stage,
    {
      details: {
        configPath,
        hookEntry: validation.entry,
        line: validation.line,
      },
    },
  );
}

// ----- Line endings -----------------------------------------------------

function detectLineEnding(contents: string): "\n" | "\r\n" {
  // Heuristic: if the file contains any `\r\n`, treat it as CRLF.
  // Otherwise use LF (also covers the empty-file case where we're
  // writing fresh content). This keeps the file's line-ending shape
  // stable across install/uninstall on Windows users' configs.
  return contents.includes("\r\n") ? "\r\n" : "\n";
}

function spliceBlock(
  contents: string,
  beginLine: number,
  endLine: number,
  replacement: string,
  lineEnding: "\n" | "\r\n",
): string {
  const lines = contents.split(/(?<=\n)/);
  const before = lines.slice(0, beginLine).join("");
  const after = lines.slice(endLine + 1).join("");
  const beforeWithSep = before.endsWith("\n") || before.length === 0 ? before : `${before}${lineEnding}`;
  const replacementWithEnding = replacement.endsWith(lineEnding) ? replacement : `${replacement}${lineEnding}`;
  return `${beforeWithSep}${replacementWithEnding}${after}`;
}

// Keep every host's block in one contiguous run. Magpie's table rewrite drops
// comments that follow a table it owns (yetone/magpie#5614): a block appended
// after such a table loses its BEGIN marker and header, leaving an orphan END.
// Insert after the last managed END only when nothing but blanks/comments
// precedes the next header AND the real parser proves the result equals the
// appended form apart from hook order, so no field can rebind and no value can
// be split; otherwise append.
function insertBlockNearManagedBlocks(
  contents: string,
  blocks: readonly ManagedBlockEntry[],
  block: string,
  lineEnding: "\n" | "\r\n",
): string {
  if (blocks.length === 0) return appendBlock(contents, block, lineEnding);
  const anchor = Math.max(...blocks.map((b) => b.endLine));
  const lines = splitPreservingEnding(contents);
  for (let i = anchor + 1; i < lines.length; i += 1) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith("[")) break;
    if (trimmed.length > 0 && !trimmed.startsWith("#")) return appendBlock(contents, block, lineEnding);
  }
  const rawLines = contents.split(/(?<=\n)/);
  const head = rawLines.slice(0, anchor + 1).join("");
  const tail = rawLines.slice(anchor + 1).join("");
  const appended = appendBlock(contents, block, lineEnding);
  if (tail.length === 0) return appended;
  const headWithEnding = head.endsWith("\n") ? head : `${head}${lineEnding}`;
  const body = block.endsWith(lineEnding) ? block : `${block}${lineEnding}`;
  const tailSeparator = /^\r?\n/.test(tail) ? "" : lineEnding;
  const inserted = `${headWithEnding}${lineEnding}${body}${tailSeparator}${tail}`;
  return sameTomlIgnoringHookOrder(inserted, appended) ? inserted : appended;
}

function sameTomlIgnoringHookOrder(a: string, b: string): boolean {
  const canonical = (text: string): string => {
    const parsed = parseToml(text) as Record<string, unknown>;
    const hooks = Array.isArray(parsed.hooks)
      ? parsed.hooks.map((entry) => JSON.stringify(entry)).sort()
      : parsed.hooks;
    return JSON.stringify({ ...parsed, hooks });
  };
  try {
    return canonical(a) === canonical(b);
  } catch {
    return false;
  }
}

function appendBlock(contents: string, block: string, lineEnding: "\n" | "\r\n"): string {
  const base = contents.length === 0 || contents.endsWith(lineEnding) ? contents : `${contents}${lineEnding}`;
  const separator = base.length === 0 ? "" : lineEnding;
  const body = block.endsWith(lineEnding) ? block : `${block}${lineEnding}`;
  return `${base}${separator}${body}`;
}

function splitPreservingEnding(contents: string): string[] {
  // We canonicalize to '\n' for the split, then strip any '\r' that
  // came from CRLF. Rejoining is the caller's responsibility (they
  // pass the desired line ending).
  return contents.split("\n").map((line) => line.replace(/\r$/, ""));
}

// A partial upstream hooks-array rewrite can leave one marker comment behind.
// Remove only unpaired marker comments, never the intervening content. The
// normal full-file validation still gates writes.
function removeOrphanMarkers(
  contents: string,
): { contents: string; count: number } {
  const lines = splitPreservingEnding(contents);
  const orphans: { index: number; host: string | null }[] = [];
  const comments = markerCommentLines(contents);
  let open: { index: number; host: string | null } | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (!comments.has(i)) continue;
    const line = lines[i]!.trim();
    const begin = MARKERS.BEGIN_LINE_RE.exec(line);
    if (begin !== null) {
      if (open !== null) orphans.push(open);
      open = { index: i, host: begin[1]?.toLowerCase() ?? null };
    } else {
      const end = MARKERS.END_LINE_RE.exec(line);
      if (end === null) continue;
      const endMarker = { index: i, host: end[1]?.toLowerCase() ?? null };
      if (open === null) orphans.push(endMarker);
      else {
        if (open.host !== endMarker.host) orphans.push(open, endMarker);
        open = null;
      }
    }
  }
  if (open !== null) orphans.push(open);
  const remove = new Set(orphans.map((marker) => marker.index));
  return remove.size === 0
    ? { contents, count: 0 }
    : { contents: contents.split(/(?<=\n)/).filter((_, index) => !remove.has(index)).join(""), count: remove.size };
}

/**
 * Remove managed blocks owned by `currentHost`, or every host with `removeAll`.
 * Ownership comes from the marker suffix or a legacy command's derived host.
 * Orphan markers are removed individually so surrounding user content survives.
 */
function stripManagedBlocks(
  contents: string,
  currentHost: string,
  removeAll: boolean,
): {
  stripped: string;
  removedBlocks: number;
  orphansLeft: number[];
} {
  const lines = splitPreservingEnding(contents);
  const rawLines = contents.split(/(?<=\n)/);
  const markerLines = markerCommentLines(contents);
  const result: string[] = [];
  const orphansLeft: number[] = [];
  let removedBlocks = 0;

  // Suffixed blocks belong only to the matching host. Complete legacy blocks
  // use their command-derived host; an unattributable non-canonical command is
  // ambiguous and only --all removes it. Orphan marker lines have no command
  // and can be swept individually by a scoped uninstall.
  const shouldRemove = (
    markerHost: string | null,
    commandPath: string | null,
    isOrphanMarker: boolean,
  ): boolean => {
    if (removeAll) return true;
    if (markerHost !== null) return markerHost === currentHost;
    if (isOrphanMarker) return true;
    const derived = commandPath !== null ? hostIdFromHookCommand(commandPath) : null;
    if (derived === null) return false;
    return derived === currentHost;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    const begin = markerLines.has(i) ? MARKERS.BEGIN_LINE_RE.exec(trimmed) : null;
    if (begin !== null) {
      const beginHost = begin[1]?.toLowerCase() ?? null;
      // Look ahead for the matching END, capturing the block's command en route.
      let endIdx = -1;
      let blockCommand: string | null = null;
      for (let j = i + 1; j < lines.length; j += 1) {
        const nextTrimmed = lines[j]!.trim();
        if (markerLines.has(j) && MARKERS.BEGIN_LINE_RE.test(nextTrimmed)) {
          // Two BEGINs in a row — the outer one is an orphan.
          break;
        }
        const end = markerLines.has(j) ? MARKERS.END_LINE_RE.exec(nextTrimmed) : null;
        if (end !== null) {
          if ((end[1]?.toLowerCase() ?? null) === beginHost) endIdx = j;
          break;
        }
        const decoded = decodeManagedCommandLine(nextTrimmed);
        if (decoded !== null) blockCommand = decoded;
      }
      if (endIdx === -1) {
        // Orphan BEGIN: drop only this line (if it's ours to remove).
        if (shouldRemove(beginHost, null, true)) {
          orphansLeft.push(i);
          i += 1;
          continue;
        }
        result.push(rawLines[i]!);
        i += 1;
        continue;
      }
      if (shouldRemove(beginHost, blockCommand, false)) {
        // Complete pair we're removing — drop BEGIN..END inclusive.
        removedBlocks += 1;
        i = endIdx + 1;
        continue;
      }
      // Another host's block — keep it verbatim.
      for (let k = i; k <= endIdx; k += 1) result.push(rawLines[k]!);
      i = endIdx + 1;
      continue;
    }
    const end = markerLines.has(i) ? MARKERS.END_LINE_RE.exec(trimmed) : null;
    if (end !== null) {
      const endHost = end[1]?.toLowerCase() ?? null;
      // Orphan END with no preceding BEGIN: drop only this line (if ours).
      if (shouldRemove(endHost, null, true)) {
        orphansLeft.push(i);
        i += 1;
        continue;
      }
      result.push(rawLines[i]!);
      i += 1;
      continue;
    }
    result.push(rawLines[i]!);
    i += 1;
  }

  return { stripped: result.join(""), removedBlocks, orphansLeft };
}

/**
 * Remove orphaned, marker-less `[[hooks]]` tables that are unambiguously this
 * plugin's approval hook (see `findUnmanagedApprovalHookBlocks`). Returns the
 * cleaned text, the count removed, and the decoded commands of the removed
 * tables (so install can distinguish "re-adorning this host's live hook after
 * a kimi-code comment strip" from "sweeping stale cruft"). A no-op (returns
 * the input unchanged) when there is nothing to prune, so callers can compare
 * identity cheaply.
 *
 * `ownedBy` restricts the prune to tables whose command path derives to that
 * host — REQUIRED for scoped install/uninstall so one host never disarms the
 * other's live (marker-stripped) hook. Omit only for `--uninstall --all`.
 */
function pruneOrphanApprovalHooks(
  contents: string,
  ownedBy?: string,
  alsoMatchCommand?: string,
): { pruned: string; count: number; commands: string[] } {
  const ranges = findUnmanagedApprovalHookBlocks(contents, ownedBy, alsoMatchCommand);
  if (ranges.length === 0) return { pruned: contents, count: 0, commands: [] };

  const remove = new Set<number>();
  for (const { start, end } of ranges) {
    for (let i = start; i < end; i += 1) remove.add(i);
  }
  const lines = contents.split(/(?<=\n)/);
  const kept = lines.filter((_, idx) => !remove.has(idx));
  return {
    pruned: kept.join(""),
    count: ranges.length,
    commands: ranges.map((range) => range.command),
  };
}

// ----- Block content -----------------------------------------------------

function buildManagedBlock(
  hookScriptPath: string,
  env: NodeJS.ProcessEnv,
  lineEnding: "\n" | "\r\n" = "\n",
  hostId = "",
): string {
  const shellCommand = buildHookShellCommand(hookScriptPath, env);
  const commandLine = `command = ${tomlBasicString(shellCommand)}`;
  const suffix = hostId.length > 0 ? `:${hostId}` : "";
  return [
    `${BEGIN_MARKER_PREFIX}${suffix} (v${K3_PLUGIN_CC_VERSION}) ===`,
    `# DO NOT EDIT — managed by /k3:setup. Run /k3:setup --uninstall to remove.`,
    `# Host: ${hostId.length > 0 ? hostId : "(legacy)"} — each host owns a separate block in this shared`,
    `#   ~/.kimi-code/config.toml. Scoped setup/uninstall preserves other hosts;`,
    `#   /k3:setup --uninstall --all removes every host's block.`,
    `# Purpose:`,
    `#   kimi-code's \`kimi -p\` mode hard-codes permission='auto' and`,
    `#   auto-approves every tool call. This hook enforces each managed command's`,
    `#   read-only or workspace-bound approval policy. Without this block,`,
    `#   the plugin's safety contract collapses.`,
    `# Matcher field is intentionally OMITTED — kimi-code compiles the`,
    `#   matcher with \`new RegExp(...)\`. An empty/missing matcher means`,
    `#   "fire for every tool". The string "*" would throw and silently`,
    `#   disable the hook. Do not "fix" this.`,
    `# The Node binary path is absolute so kimi-code's \`/bin/sh -c\``,
    `#   hook spawn doesn't need \`node\` on its PATH (GUI launches,`,
    `#   LaunchAgents, etc.).`,
    `[[hooks]]`,
    `event = "PreToolUse"`,
    commandLine,
    `timeout = ${DEFAULT_HOOK_TIMEOUT_S}`,
    `# === END k3-plugin-cc-managed${suffix} ===`,
  ].join(lineEnding);
}

/**
 * Encode a TOML basic string, including quotes, backslashes, and control
 * escapes. Raw shell output must not be interpolated directly: TOML reserves
 * `\'`, and a compliant parser rejects that escape.
 */
function tomlBasicString(value: string): string {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll("\b", "\\b")
    .replaceAll("\t", "\\t")
    .replaceAll("\n", "\\n")
    .replaceAll("\f", "\\f")
    .replaceAll("\r", "\\r");
  return `"${escaped}"`;
}

function assertHookPathTomlSafe(hookScriptPath: string): void {
  if (!PATH_FORBIDDEN_RE.test(hookScriptPath)) return;
  throw new RuntimeError(
    "SETUP_HOOK_PATH_UNSAFE",
    [
      `Hook script path ${JSON.stringify(hookScriptPath)} contains characters`,
      `(control chars, quotes, backslashes, or newlines) that cannot be safely`,
      `written into kimi-code's TOML config. Set K3_PLUGIN_CC_HOOK_SCRIPT`,
      `to an unambiguous absolute path or reinstall the plugin to a location`,
      `without these characters.`,
    ].join(" "),
    "setup.hook-path",
    { details: { hookScriptPath } },
  );
}

// ----- Path resolution ---------------------------------------------------

function resolveKimiCodeConfigPath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveKimiHome(env), "config.toml");
}

async function assertHookScriptExists(hookScriptPath: string): Promise<void> {
  try {
    await access(hookScriptPath, fsConstants.R_OK);
  } catch (err) {
    throw new RuntimeError(
      "SETUP_HOOK_SCRIPT_MISSING",
      `Hook script ${hookScriptPath} is missing or unreadable. Reinstall the plugin so dist/hooks/approval-hook.js is present.`,
      "setup.hook-script",
      err instanceof Error ? { cause: err, details: { hookScriptPath } } : { details: { hookScriptPath } },
    );
  }
}

// ----- Probe -------------------------------------------------------------

interface ProbeOutcome {
  ok: boolean;
  reason: string;
}

/**
 * Two-layer probe; both layers require exit 2 and a non-empty denial reason.
 *
 *   1. Directly spawn the hook with the absolute path from resolveNodeBinary,
 *      catching missing/broken scripts and incorrect hook exit behavior without
 *      relying on PATH.
 *   2. Execute the exact canonical command from buildHookShellCommand through
 *      `/bin/sh -c`: two shell-quoted absolute tokens for Node and the script.
 *      This catches pinned-interpreter execution and quoting failures. It does
 *      NOT test PATH discovery or compatibility of some other `node` on PATH.
 *
 * BRILIA fork: on Windows the shell layer runs the same command through
 * ComSpec (cmd.exe), which is how kimi-code spawns the hook there, instead of
 * being skipped and reported as passed.
 */
async function probeHook(
  hookScriptPath: string,
  env: NodeJS.ProcessEnv,
): Promise<ProbeOutcome> {
  const directResult = await probeHookDirect(hookScriptPath, env);
  if (!directResult.ok) return directResult;

  const shellResult = await probeHookViaShell(hookScriptPath, env);
  if (!shellResult.ok) return shellResult;

  return {
    ok: true,
    reason: `${directResult.reason}; shell probe also ok`,
  };
}

async function probeHookDirect(
  hookScriptPath: string,
  env: NodeJS.ProcessEnv,
): Promise<ProbeOutcome> {
  const nodeBin = resolveNodeBinary(env);
  return await spawnProbe(
    nodeBin,
    [hookScriptPath],
    env,
    `direct probe via ${nodeBin}`,
  );
}

async function probeHookViaShell(
  hookScriptPath: string,
  env: NodeJS.ProcessEnv,
): Promise<ProbeOutcome> {
  // Reuse the exact command string the managed block wrote into
  // kimi-code's config so probe and runtime cannot drift.
  const shellCommand = buildHookShellCommand(hookScriptPath, env);

  if (process.platform === "win32") {
    // BRILIA fork: this branch used to `return { ok: true, reason: "shell probe
    // skipped (Windows)" }`, on the stated assumption that kimi-code shells out
    // via `/bin/sh -c` and that "on Windows the entire kimi-code launcher is
    // unsupported". That assumption is stale, and returning `ok: true` for a
    // check that never ran is a false positive by construction: it reported
    // "Probe: ok" while enforcement was inert.
    //
    // Measured on kimi-code 0.30.0 / Windows 11 by instrumenting the hook and
    // walking the process tree during a REAL session:
    //
    //   parent_chain: node.exe <- cmd.exe <- kimi.exe
    //   ComSpec:      C:\WINDOWS\system32\cmd.exe
    //
    // kimi-code spawns the hook through ComSpec on Windows. `shell: true`
    // resolves to exactly that, so this reproduces the production path rather
    // than approximating it. Passing the pre-quoted command as an argv element
    // instead would make Node re-escape an already-quoted string and fail for a
    // reason that belongs to the probe, not to the install.
    return await spawnProbe(shellCommand, [], env, `shell probe via ComSpec (${env.ComSpec ?? "cmd.exe"})`, {
      shell: true,
    });
  }

  return await spawnProbe(
    "/bin/sh",
    ["-c", shellCommand],
    env,
    `shell probe via /bin/sh -c`,
  );
}

function spawnProbe(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  label: string,
  /**
   * Extra spawn options. Used by the Windows shell probe to run the command
   * string through ComSpec, which is how kimi-code invokes the hook there.
   */
  spawnOptions: { shell?: boolean } = {},
): Promise<ProbeOutcome> {
  const payload = JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "k3-plugin-cc-setup-probe",
    cwd: process.cwd(),
    tool_name: "Bash",
    tool_input: { command: "echo probe" },
    tool_call_id: "probe-1",
  });

  return new Promise<ProbeOutcome>((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        env: {
          ...env,
          K3_PLUGIN_CC_CMD: "review",
          K3_PLUGIN_CC_SKIP_HOOK_CHECK: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
        ...spawnOptions,
      });
    } catch (err) {
      resolve({ ok: false, reason: `${label}: spawn failed: ${(err as Error).message}` });
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
      }
      resolve({
        ok: false,
        reason: `${label}: timed out after ${PROBE_TIMEOUT_MS}ms (no exit). stderr: ${truncate(stderr, 200)}`,
      });
    }, PROBE_TIMEOUT_MS);
    timer.unref();

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: `${label}: process error: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stderrTrimmed = stderr.trim();
      if (code === 2 && stderrTrimmed.length > 0) {
        resolve({ ok: true, reason: `${label}: deny reason captured (${stderrTrimmed.slice(0, 80)}…)` });
      } else {
        resolve({
          ok: false,
          reason:
            `${label}: expected exit 2 with deny reason, got exit ${code ?? "<null>"}` +
            ` [${classifyProbeExit(code)}].` +
            ` stdout=${truncate(stdout, 120)} stderr=${truncate(stderrTrimmed, 200)}`,
        });
      }
    });

    try {
      child.stdin?.write(payload);
      child.stdin?.end();
    } catch (err) {
      clearTimeout(timer);
      resolve({ ok: false, reason: `${label}: failed to write probe stdin: ${(err as Error).message}` });
    }
  });
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

/**
 * Name the likely cause behind a non-2 probe exit.
 *
 * Every non-2 exit already fails the probe, and that stays true: the hook
 * contract treats anything other than 2 as ALLOW, so a probe that cannot prove
 * a deny must never report success. What was missing is WHY. An operator (or an
 * external tester filing an issue) staring at `exit 9009` has nothing to act on;
 * "the shell could not find the interpreter" is actionable.
 *
 * The codes are the ones that actually occur in this path:
 *   127   POSIX "command not found"
 *   9009  the cmd.exe equivalent
 *   1     the hook ran but errored, or the shell rejected the command shape
 *         (the single-quote bug measured 1 in a re-test on 2026-09-28)
 *   255   command malformed for the shell - the single-quote bug as first
 *         measured on 2026-08-12. The number moved; either way it is not 2.
 *   null  no exit code: killed by the timeout, i.e. a hang
 */
export function classifyProbeExit(code: number | null): string {
  if (code === null) return "hang: no exit code, killed by the probe timeout";
  if (code === 127 || code === 9009) {
    return "environment: the shell could not resolve the interpreter or the hook path";
  }
  if (code === 255) return "command shape: the shell could not parse the managed command (quoting)";
  if (code === 0) return "no deny: the hook allowed a tool that the read-only policy must refuse";
  return "unclassified: read stderr below";
}

// ----- Permission rules scan --------------------------------------------

/**
 * Warn only when the installed kimi is demonstrably outside the certified
 * range. Probe failure records nothing here because the hook probe reports the
 * more direct problem; setup may finish, but model spawn still refuses an
 * uncertified binary. K3_PLUGIN_CC_SKIP_VERSION_PROBE is a test/CI bypass,
 * not a production compatibility override.
 */
async function collectKimiVersionWarnings(
  env: NodeJS.ProcessEnv,
  warnings: string[],
): Promise<void> {
  if (env.K3_PLUGIN_CC_SKIP_VERSION_PROBE === "1") return;
  const probe = await probeKimiVersion({
    kimiBin: env.K3_PLUGIN_CC_KIMI_BIN || undefined,
    env,
  });
  if (probe.kind === "failed") {
    // Don't warn about probe failure here — if kimi is genuinely
    // missing/broken, the hook probe path will catch it with a much
    // clearer message. Avoid double-noise.
    return;
  }
  // Certified for EITHER engine is "in range": the legacy tested minors, or an
  // exact native-v2 certified version (which is deliberately outside
  // KIMI_TESTED_MINORS — that table never gains 0.42). Without this, setup on a
  // v2-certified binary would wrongly warn "not certified, commands will refuse".
  if (probe.inTestedRange || isNativeV2CertifiedVersion(probe.version)) return;
  warnings.push(formatVersionOutOfRangeWarning(probe, K3_PLUGIN_CC_VERSION, NATIVE_V2_CERTIFIED_VERSIONS));
}

/**
 * Non-blocking notice for kimi-code's own enabled plugins from
 * ~/.kimi-code/plugins/installed.json. Their tools can register on every
 * session, but read-only commands deny everything outside READ_ONLY_TOOLS
 * (Read, Grep, Glob, ReadMediaFile, TaskList, TaskOutput), which can waste model
 * turns. Missing, unreadable, or malformed manifests produce no notice; setup
 * never blocks on or mutates the plugin list.
 */
async function collectInstalledKimiPluginsNotice(
  env: NodeJS.ProcessEnv,
  warnings: string[],
): Promise<void> {
  const home = resolveKimiHome(env);
  const installedPath = path.join(home, "plugins", "installed.json");
  let raw: string;
  try {
    raw = await readFile(installedPath, "utf8");
  } catch {
    return; // ENOENT / unreadable — kimi-code's plugin system isn't in use here.
  }
  let enabledIds: string[];
  try {
    const parsed = JSON.parse(raw) as { plugins?: unknown };
    if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.plugins)) {
      return;
    }
    enabledIds = parsed.plugins
      .filter(
        (entry): entry is { id?: unknown; enabled?: unknown } =>
          entry !== null && typeof entry === "object",
      )
      // `enabled !== false` so an explicitly-disabled plugin is hidden while an
      // enabled or format-ambiguous one is surfaced (it can still register tools).
      .filter((entry) => entry.enabled !== false)
      .map((entry) => (typeof entry.id === "string" ? entry.id : ""))
      .filter((id) => id.length > 0);
  } catch {
    return; // Malformed JSON — don't guess.
  }
  if (enabledIds.length === 0) return;
  warnings.push(
    [
      `NOTE: ${enabledIds.length} kimi-code plugin(s) installed and enabled: ${enabledIds.join(", ")}.`,
      "  kimi-code registers their tools (including MCP) on every session. Under k3-plugin-cc's",
      "  read-only commands (/k3:review, /k3:challenge, /k3:ask, and the review gate) the",
      "  PreToolUse hook denies any tool outside Read/Grep/Glob, so calls to these plugins' tools",
      "  are blocked — safe, but they can waste model turns. This is expected; no action needed.",
      "  (/k3:rescue and /k3:swarm apply their own allowlists.) To avoid the turn-waste, disable",
      "  kimi-code plugins you don't need for delegated work in your kimi-code config.",
    ].join("\n"),
  );
}

/**
 * Best-effort line scan for permission rules that deny common read tools. This
 * is not a TOML parse: it recognizes basic and literal quoted strings but misses
 * inline-table and multiline forms.
 */
function collectPermissionRuleWarnings(contents: string, warnings: string[]): void {
  const lines = contents.split("\n").map((line) => line.replace(/\r$/, ""));
  let inRule = false;
  let ruleStartLine = -1;
  let ruleDecision = "";
  let rulePattern = "";

  const flushRule = () => {
    if (!inRule) return;
    if (ruleDecision === "deny" && rulePattern.length > 0) {
      if (
        rulePattern === "*" ||
        /^\s*Read\b/.test(rulePattern) ||
        /^\s*Grep\b/.test(rulePattern) ||
        /^\s*Glob\b/.test(rulePattern)
      ) {
        warnings.push(
          `permission.rules at line ${ruleStartLine + 1}: deny pattern "${rulePattern}" may block read-only commands; consider scoping the deny narrower.`,
        );
      }
    }
    inRule = false;
    ruleStartLine = -1;
    ruleDecision = "";
    rulePattern = "";
  };

  // Accept either double-quoted basic strings or single-quoted literal
  // strings for `decision` and `pattern`.
  const decisionRE = /^\s*decision\s*=\s*(?:"([^"]*)"|'([^']*)')/;
  const patternRE = /^\s*pattern\s*=\s*(?:"([^"]*)"|'([^']*)')/;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === "[[permission.rules]]") {
      flushRule();
      inRule = true;
      ruleStartLine = i;
      continue;
    }
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      flushRule();
      continue;
    }
    if (!inRule) continue;
    const decisionMatch = decisionRE.exec(line);
    if (decisionMatch) {
      ruleDecision = decisionMatch[1] ?? decisionMatch[2] ?? "";
      continue;
    }
    const patternMatch = patternRE.exec(line);
    if (patternMatch) {
      rulePattern = patternMatch[1] ?? patternMatch[2] ?? "";
      continue;
    }
  }
  flushRule();
}

// ----- Detail rendering --------------------------------------------------

function buildDetails(args: {
  configPath: string;
  hookScriptPath: string;
  reviewGateEnabled: boolean;
  probe: ProbeOutcome;
  warnings: string[];
  hostId?: string;
}): string[] {
  const details = [
    `Companion runtime: Node ${process.version}`,
    `Plugin version:   ${K3_PLUGIN_CC_VERSION}`,
    ...(args.hostId ? [`Host id:          ${args.hostId}`] : []),
    `Config file:      ${args.configPath}`,
    `Hook script:      ${args.hookScriptPath}`,
    `Review gate:      ${args.reviewGateEnabled ? "enabled" : "disabled"}`,
    `Probe:            ${args.probe.ok ? "ok" : "failed"} — ${args.probe.reason}`,
  ];
  if (args.warnings.length > 0) {
    details.push("Warnings:");
    for (const warning of args.warnings) {
      details.push(`  - ${warning}`);
    }
  }
  return details;
}

export function renderSetupResult(result: SetupResult): string {
  return [
    result.summary,
    "",
    `Action:      ${result.action}`,
    `Block written:  ${result.blockWritten ? "yes" : "no"}`,
    `Block removed:  ${result.blockRemoved ? "yes" : "no"}`,
    `Probe:          ${result.probe}${result.probeError ? ` (${result.probeError})` : ""}`,
    `Model probe:    ${result.modelProbe ?? "skipped"}${result.modelProbeDetail ? ` (${result.modelProbeDetail})` : ""}`,
    ...(result.action === "check" && (result.modelProbe ?? "skipped") === "skipped"
      ? [
          "Note: the Probe line tests the hook, not model access, your plan, or your quota. " +
            "Run `setup --check --probe-model [-m <model>]` to send one prompt (120 s budget) to the model; the provider may count more than one request for it.",
        ]
      : []),
    `Review gate:    ${result.reviewGateEnabled ? "enabled" : "disabled"}`,
    "",
    "Details:",
    ...result.details.map((detail) => `- ${detail}`),
    "",
    `Next step: ${result.nextStep}`,
    "Models: run setup --models to list configured aliases and provider setup guidance without making a model call.",
  ].join("\n");
}

export type { ManagedBlockState };
