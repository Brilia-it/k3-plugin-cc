import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runAsk } from "../../runtime/commands/ask.js";
import { renderSetupResult, runSetup } from "../../runtime/commands/setup.js";
import { JobStore } from "../../runtime/job-store.js";
import { resolvePluginPaths } from "../../runtime/paths.js";
import type { CommandContext } from "../../runtime/types.js";

const mockCliPath = path.join(process.cwd(), "tests/helpers/mock-kimi-cli-v1.ts");

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "k3-plugin-cc-model-probe-"));
});

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

async function makeCase(
  name: string,
  scenario: string,
): Promise<{ env: NodeJS.ProcessEnv; invocationPath: string }> {
  const kimiHome = path.join(scratch, name, "kimi-code-home");
  const pluginData = path.join(scratch, name, "plugin-data");
  await mkdir(kimiHome, { recursive: true });
  await mkdir(pluginData, { recursive: true });
  const invocationPath = path.join(scratch, name, "invocation.json");
  await writeFile(path.join(kimiHome, "config.toml"), "user_setting = true\n", "utf8");
  return {
    invocationPath,
    env: {
      ...process.env,
      KIMI_CODE_HOME: kimiHome,
      CLAUDE_PLUGIN_DATA: pluginData,
      K3_PLUGIN_CC_KIMI_BIN: "bun",
      K3_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
      K3_PLUGIN_CC_MOCK_SCENARIO: scenario,
      K3_PLUGIN_CC_MOCK_DELAY_MS: "0",
      K3_PLUGIN_CC_MOCK_INVOCATION_PATH: invocationPath,
      K3_PLUGIN_CC_SKIP_VERSION_PROBE: "1",
    },
  };
}

function makeContext(env: NodeJS.ProcessEnv): CommandContext {
  return { cwd: process.cwd(), env, stdout: process.stdout, stderr: process.stderr };
}

describe("setup --check --probe-model", () => {
  test("rejects --probe-model without --check, and -m without --probe-model", async () => {
    const { env } = await makeCase("parse", "ask-success");
    await expect(runSetup(["--probe-model"], makeContext(env))).rejects.toMatchObject({
      code: "INVALID_ARGS",
      stage: "setup.parse",
    });
    await expect(runSetup(["--check", "-m", "x"], makeContext(env))).rejects.toMatchObject({
      code: "INVALID_ARGS",
      stage: "setup.parse",
    });
    await expect(runSetup(["--uninstall", "--probe-model"], makeContext(env))).rejects.toMatchObject({
      code: "INVALID_ARGS",
    });
  });

  test("the plain --check makes no model call and the output says the probe tests the hook, not the model", async () => {
    const { env, invocationPath } = await makeCase("plain", "ask-success");
    await runSetup([], makeContext(env));
    // The install above probes the hook, not the model: the mock must never have run.
    expect(existsSync(invocationPath)).toBe(false);
    const result = await runSetup(["--check"], makeContext(env));
    expect(result.probe).toBe("ok");
    expect(result.modelProbe).toBe("skipped");
    expect(existsSync(invocationPath)).toBe(false);
    const text = renderSetupResult(result);
    expect(text).toContain("Model probe:    skipped");
    expect(text).toContain("tests the hook, not model access, your plan, or your quota");
    expect(text).toContain("--probe-model");
  }, 60_000);

  test("--probe-model sends one minimal prompt through the ask path and reports ok", async () => {
    const { env, invocationPath } = await makeCase("ok", "ask-success");
    await runSetup([], makeContext(env));
    const result = await runSetup(["--check", "--probe-model", "-m", "kimi-code/k3-256k"], makeContext(env));
    expect(result.probe).toBe("ok");
    expect(result.modelProbe).toBe("ok");
    expect(result.modelProbeDetail).toContain("kimi-code/k3-256k");
    const invocation = JSON.parse(await readFile(invocationPath, "utf8")) as {
      argv: string[];
      env: { K3_PLUGIN_CC_CMD: string | null };
    };
    expect(invocation.env.K3_PLUGIN_CC_CMD).toBe("ask");
    expect(invocation.argv).toContain("Reply with the single word READY.");
    expect(invocation.argv[invocation.argv.indexOf("-m") + 1]).toBe("kimi-code/k3-256k");
    expect(renderSetupResult(result)).toContain("Model probe:    ok");
  }, 60_000);

  test("a usage limit is reported as a failed model probe with the classified cause, while the hook probe is still ok", async () => {
    const { env } = await makeCase("quota", "quota-fail");
    await runSetup([], makeContext(env));
    const result = await runSetup(["--check", "--probe-model"], makeContext(env));
    expect(result.probe).toBe("ok");
    expect(result.modelProbe).toBe("failed");
    expect(result.modelProbeKind).toBe("quota_exhausted");
    expect(result.modelProbeDetail).toContain("5-hour rolling window");
    expect(result.modelProbeDetail).toContain("NOT the context window");
    // A probe is not a resumable job: no resume sentence.
    expect(result.modelProbeDetail).not.toContain("retry starts from zero");
    expect(renderSetupResult(result)).toContain("Model probe:    failed");
  }, 60_000);

  test("an unrelated failure of the model call is failed, not silently ok", async () => {
    const { env } = await makeCase("unknown", "no-such-scenario");
    await runSetup([], makeContext(env));
    const result = await runSetup(["--check", "--probe-model"], makeContext(env));
    expect(result.modelProbe).toBe("failed");
    expect(result.modelProbeKind).toBe("startup_failed");
  }, 60_000);

  test("when the hook probe fails the model probe is skipped and nothing is sent", async () => {
    const { env, invocationPath } = await makeCase("hookless", "ask-success");
    const result = await runSetup(["--check", "--probe-model"], makeContext(env));
    expect(result.probe).toBe("failed");
    expect(result.modelProbe).toBe("skipped");
    expect(result.modelProbeDetail).toContain("hook probe did not pass");
    expect(existsSync(invocationPath)).toBe(false);
  }, 60_000);

  // Review 0.7.0, finding 5: the probe goes through the same admission as every model job.
  function seedRunning(env: NodeJS.ProcessEnv, jobId: string): void {
    const store = new JobStore(resolvePluginPaths(env));
    try {
      store.createJob({
        job_id: jobId,
        repo_id: "repo-x",
        command_type: "ask",
        cwd: process.cwd(),
        model: null,
        thinking: null,
        background: false,
        pid: process.pid,
        kimi_pid: null,
        status: "running",
        kimi_session_id: null,
        agent_profile: "read-only",
        prompt_digest: "digest",
        summary: "Running.",
        phase: "turn-running",
        final_output_path: null,
        stream_log_path: path.join(scratch, `${jobId}.jsonl`),
        error: null,
      });
    } finally {
      store.close();
    }
  }

  function runningIds(env: NodeJS.ProcessEnv): string[] {
    const store = new JobStore(resolvePluginPaths(env));
    try {
      return store.listRunningJobs().map((job) => job.job_id);
    } finally {
      store.close();
    }
  }

  test("refuses while a job is running (nonzero outcome), sends nothing, and --allow-concurrent overrides", async () => {
    const { env, invocationPath } = await makeCase("adm-refuse", "ask-success");
    await runSetup([], makeContext(env));
    seedRunning(env, "job-long-running");
    const refused = await runSetup(["--check", "--probe-model"], makeContext(env));
    expect(refused.modelProbe).toBe("failed");
    expect(refused.modelProbeKind).toBe("job_already_running");
    expect(refused.modelProbeDetail).toContain("job-long-running");
    expect(existsSync(invocationPath)).toBe(false);
    expect(runningIds(env)).toEqual(["job-long-running"]);

    const allowed = await runSetup(["--check", "--probe-model", "--allow-concurrent"], makeContext(env));
    expect(allowed.modelProbe).toBe("ok");
    expect(runningIds(env)).toEqual(["job-long-running"]);
  }, 60_000);

  test("plain setup and setup --check are untouched by a running job", async () => {
    const { env } = await makeCase("adm-plain", "ask-success");
    await runSetup([], makeContext(env));
    seedRunning(env, "job-long-running");
    const check = await runSetup(["--check"], makeContext(env));
    expect(check.probe).toBe("ok");
    expect(check.modelProbe).toBe("skipped");
  }, 60_000);

  // Round 3, item B.
  test("cancelling a slow probe tears the kimi child down BEFORE the row is released", async () => {
    const slow = await makeCase("probe-cancel", "ask-success");
    slow.env.K3_PLUGIN_CC_MOCK_DELAY_MS = "20000";
    await runSetup([], makeContext(slow.env));
    const pending = runSetup(["--check", "--probe-model"], makeContext(slow.env));
    let childPid = 0;
    for (let i = 0; i < 100 && childPid === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (existsSync(slow.invocationPath) && runningIds(slow.env).length === 1) {
        try {
          childPid = (JSON.parse(await readFile(slow.invocationPath, "utf8")) as { pid: number }).pid;
        } catch {
          childPid = 0;
        }
      }
    }
    expect(childPid).toBeGreaterThan(0);
    // The cancellation handlers listen on SIGTERM; emit it in-process (a real signal kills the
    // process outright on Windows, which would test nothing).
    process.emit("SIGTERM");
    const result = await pending;
    expect(result.modelProbe).toBe("failed");
    // Teardown is a settlement barrier: when the probe has returned, the child is gone.
    let alive = true;
    try {
      process.kill(childPid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
    expect(runningIds(slow.env)).toEqual([]);
    const db = new Database(resolvePluginPaths(slow.env).stateDbPath, { readonly: true });
    try {
      const row = db.query("SELECT status, operation_kind FROM jobs").get() as { status: string; operation_kind: string };
      expect(row.status).toBe("cancelled");
      expect(row.operation_kind).toBe("model_probe");
    } finally {
      db.close();
    }
  }, 90_000);

  test("a probe does not replace the latest ask for bare --resume", async () => {
    const { env } = await makeCase("probe-resume", "ask-success");
    env.K3_PLUGIN_CC_SKIP_HOOK_CHECK = "1";
    const sessionId = "33333333-3333-4333-8333-333333333333";
    env.K3_PLUGIN_CC_MOCK_SESSION_ID = sessionId;
    await runSetup([], makeContext(env));
    await runAsk(["Seed", "question?"], makeContext(env));
    const probed = await runSetup(["--check", "--probe-model"], makeContext(env));
    expect(probed.modelProbe).toBe("ok");
    const invocation = path.join(scratch, "probe-resume", "resume-invocation.json");
    const answer = await runAsk(["-r", "continue"], makeContext({ ...env, K3_PLUGIN_CC_MOCK_INVOCATION_PATH: invocation }));
    expect(answer).toBe("Ask answer from mock Kimi.");
    const argv = (JSON.parse(await readFile(invocation, "utf8")) as { argv: string[] }).argv;
    expect(argv[argv.indexOf("-r") + 1]).toBe(sessionId);
  }, 90_000);

  test("while the probe runs it holds a running row; the row is released on success and on failure", async () => {
    const slow = await makeCase("adm-hold", "ask-success");
    slow.env.K3_PLUGIN_CC_MOCK_DELAY_MS = "4000";
    await runSetup([], makeContext(slow.env));
    const pending = runSetup(["--check", "--probe-model"], makeContext(slow.env));
    let seen: string[] = [];
    for (let i = 0; i < 80 && seen.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      seen = runningIds(slow.env);
    }
    expect(seen.length).toBe(1);
    const result = await pending;
    expect(result.modelProbe).toBe("ok");
    expect(runningIds(slow.env)).toEqual([]);

    const failing = await makeCase("adm-release-fail", "quota-fail");
    await runSetup([], makeContext(failing.env));
    const failed = await runSetup(["--check", "--probe-model"], makeContext(failing.env));
    expect(failed.modelProbe).toBe("failed");
    expect(runningIds(failing.env)).toEqual([]);
  }, 90_000);
});
