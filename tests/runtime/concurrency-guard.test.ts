import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { runAsk } from "../../runtime/commands/ask.js";
import { runPursue } from "../../runtime/commands/pursue.js";
import { runRescue } from "../../runtime/commands/rescue.js";
import { runReview } from "../../runtime/commands/review.js";
import { runSwarm } from "../../runtime/commands/swarm.js";
import { resolveRepoIdentity } from "../../runtime/git.js";
import { JobStore } from "../../runtime/job-store.js";
import { ensurePluginPaths, resolvePluginPaths } from "../../runtime/paths.js";
import { parseAskArgs, parsePursueArgs, parseRescueArgs, parseReviewArgs, parseSwarmArgs } from "../../runtime/parsing.js";
import type { CommandContext } from "../../runtime/types.js";
import { cleanupTestPath, createGitRepoFixture, createTestPluginDataRoot } from "../helpers/test-env.js";

const mockCliPath = path.join(process.cwd(), "tests/helpers/mock-kimi-cli-v1.ts");
const hookScriptPath = path.join(process.cwd(), "runtime/hooks/review-gate-stop.ts");

function makeContext(cwd: string, runEnv: NodeJS.ProcessEnv): CommandContext {
  return { cwd, env: runEnv, stdout: process.stdout, stderr: process.stderr };
}

function makeMockEnv(pluginDataRoot: string, scenario: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDE_PLUGIN_DATA: pluginDataRoot,
    K3_PLUGIN_CC_KIMI_BIN: "bun",
    K3_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
    K3_PLUGIN_CC_MOCK_SCENARIO: scenario,
    K3_PLUGIN_CC_MOCK_DELAY_MS: "0",
    K3_PLUGIN_CC_NODE_BIN: "node",
    K3_PLUGIN_CC_SKIP_HOOK_CHECK: "1",
  };
}

async function seedRunningJob(
  runEnv: NodeJS.ProcessEnv,
  repoRoot: string,
  options: { jobId: string; commandType?: "ask" | "review" | "rescue"; pid?: number | null; staleSince?: string },
): Promise<void> {
  const paths = resolvePluginPaths(runEnv);
  await ensurePluginPaths(paths);
  const repoIdentity = await resolveRepoIdentity(repoRoot);
  const store = new JobStore(paths);
  try {
    store.createJob({
      job_id: options.jobId,
      repo_id: repoIdentity.repoId,
      command_type: options.commandType ?? "ask",
      cwd: repoRoot,
      model: null,
      thinking: null,
      background: false,
      // This test process is alive, so the sweep leaves the job running.
      pid: options.pid === undefined ? process.pid : options.pid,
      kimi_pid: null,
      status: "running",
      kimi_session_id: null,
      agent_profile: "read-only",
      prompt_digest: "digest",
      summary: "Running.",
      phase: "turn-running",
      final_output_path: null,
      stream_log_path: path.join(paths.logsDir, `${options.jobId}.jsonl`),
      error: null,
    });
  } finally {
    store.close();
  }
  if (options.staleSince) {
    const db = new Database(paths.stateDbPath);
    try {
      db.query("UPDATE jobs SET updated_at = ? WHERE job_id = ?").run(options.staleSince, options.jobId);
    } finally {
      db.close();
    }
  }
}

function countJobs(runEnv: NodeJS.ProcessEnv): number {
  const store = new JobStore(resolvePluginPaths(runEnv));
  try {
    return store.listRunningJobs().length;
  } finally {
    store.close();
  }
}

function findDefinitelyDeadPid(): number {
  for (let pid = 999_999; pid > 900_000; pid -= 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return pid;
      }
    }
  }
  throw new Error("Unable to find an unused pid.");
}

describe("one model job at a time (2026-10-15 incident)", () => {
  test("every model command accepts --allow-concurrent in its parser", () => {
    expect(parseAskArgs(["--allow-concurrent", "q"]).allowConcurrent).toBe(true);
    expect(parseAskArgs(["q"]).allowConcurrent).toBe(false);
    expect(parseRescueArgs(["--allow-concurrent", "q"]).allowConcurrent).toBe(true);
    expect(parseReviewArgs(["--allow-concurrent"], "review").allowConcurrent).toBe(true);
    expect(parseReviewArgs(["--allow-concurrent"], "challenge").allowConcurrent).toBe(true);
    expect(parseReviewArgs([], "review").allowConcurrent).toBe(false);
    expect(parsePursueArgs(["--allow-concurrent", "goal"]).allowConcurrent).toBe(true);
    expect(parseSwarmArgs(["--allow-concurrent", "goal"]).allowConcurrent).toBe(true);
    expect(parseSwarmArgs(["--write", "--allow-concurrent", "goal"]).allowConcurrent).toBe(true);
  });

  test("ask refuses while another job runs: names it, says why, how to proceed, creates nothing", async () => {
    const root = await createTestPluginDataRoot("conc-ask-refuse");
    const repoRoot = await createGitRepoFixture("conc-ask-refuse-repo");
    const runEnv = makeMockEnv(root, "ask-success");
    try {
      await seedRunningJob(runEnv, repoRoot, { jobId: "job-already-running", commandType: "review" });
      let caught: unknown;
      try {
        await runAsk(["second question"], makeContext(repoRoot, runEnv));
      } catch (error) {
        caught = error;
      }
      const err = caught as Error & { code?: string; stage?: string; details?: Record<string, unknown> };
      expect(err.code).toBe("ASK_JOB_ALREADY_RUNNING");
      expect(err.stage).toBe("ask.concurrency");
      expect(err.message).toContain("job-already-running");
      expect(err.message).toContain("review");
      expect(err.message).toContain("rolling 5-hour window");
      expect(err.message).toContain("personal interactive use");
      expect(err.message).toContain("limiting concurrent access");
      expect(err.message).toContain("/k3:status");
      expect(err.message).toContain("--allow-concurrent");
      expect(err.message).toContain("refuses instead of queueing");
      expect(err.details?.running_job_ids).toEqual(["job-already-running"]);
      // Refused, not queued: no second job was created.
      expect(countJobs(runEnv)).toBe(1);
    } finally {
      await cleanupTestPath(root);
      await cleanupTestPath(repoRoot);
    }
  }, 30_000);

  test("review, challenge, rescue, pursue and swarm (read and write) refuse too, each with its own code", async () => {
    const root = await createTestPluginDataRoot("conc-all-refuse");
    const repoRoot = await createGitRepoFixture("conc-all-refuse-repo");
    const runEnv = makeMockEnv(root, "ask-success");
    const context = makeContext(repoRoot, runEnv);
    try {
      await seedRunningJob(runEnv, repoRoot, { jobId: "job-running-1" });
      await expect(runReview([], context, "review")).rejects.toMatchObject({ code: "REVIEW_JOB_ALREADY_RUNNING" });
      await expect(runReview([], context, "challenge")).rejects.toMatchObject({
        code: "CHALLENGE_JOB_ALREADY_RUNNING",
      });
      await expect(runRescue(["fix it"], context)).rejects.toMatchObject({ code: "RESCUE_JOB_ALREADY_RUNNING" });
      await expect(runPursue(["a goal"], context)).rejects.toMatchObject({ code: "PURSUE_JOB_ALREADY_RUNNING" });
      await expect(runSwarm(["a goal"], context)).rejects.toMatchObject({ code: "SWARM_JOB_ALREADY_RUNNING" });
      await expect(runSwarm(["--write", "a goal"], context)).rejects.toMatchObject({
        code: "SWARM_JOB_ALREADY_RUNNING",
      });
      expect(countJobs(runEnv)).toBe(1);
    } finally {
      await cleanupTestPath(root);
      await cleanupTestPath(repoRoot);
    }
  }, 60_000);

  test("--allow-concurrent lets the job through for that one call", async () => {
    const root = await createTestPluginDataRoot("conc-ask-allow");
    const repoRoot = await createGitRepoFixture("conc-ask-allow-repo");
    const runEnv = makeMockEnv(root, "ask-success");
    try {
      await seedRunningJob(runEnv, repoRoot, { jobId: "job-already-running" });
      const answer = await runAsk(["--allow-concurrent", "second question"], makeContext(repoRoot, runEnv));
      expect(answer).toBe("Ask answer from mock Kimi.");
    } finally {
      await cleanupTestPath(root);
      await cleanupTestPath(repoRoot);
    }
  }, 30_000);

  test("a job swept as dead does not block", async () => {
    const root = await createTestPluginDataRoot("conc-ask-stale");
    const repoRoot = await createGitRepoFixture("conc-ask-stale-repo");
    const runEnv = makeMockEnv(root, "ask-success");
    try {
      await seedRunningJob(runEnv, repoRoot, {
        jobId: "job-dead",
        pid: findDefinitelyDeadPid(),
        staleSince: "2026-04-14T10:00:00.000Z",
      });
      const answer = await runAsk(["a question"], makeContext(repoRoot, runEnv));
      expect(answer).toBe("Ask answer from mock Kimi.");
      const store = new JobStore(resolvePluginPaths(runEnv));
      try {
        expect(store.getJob("job-dead")?.status).toBe("failed");
      } finally {
        store.close();
      }
    } finally {
      await cleanupTestPath(root);
      await cleanupTestPath(repoRoot);
    }
  }, 30_000);

  test("the Stop-hook review gate is not affected by a running job", async () => {
    const root = await createTestPluginDataRoot("conc-gate");
    const repoRoot = await createGitRepoFixture("conc-gate-repo");
    const runEnv = {
      ...makeMockEnv(root, "review-gate-allow"),
      K3_PLUGIN_CC_REVIEW_GATE_MODEL: "",
    };
    try {
      await seedRunningJob(runEnv, repoRoot, { jobId: "job-already-running" });
      const paths = resolvePluginPaths(runEnv);
      await writeFile(paths.configPath, `${JSON.stringify({ reviewGateEnabled: true }, null, 2)}\n`, "utf8");
      const transcriptPath = path.join(root, "transcript.jsonl");
      await mkdir(root, { recursive: true });
      await writeFile(
        transcriptPath,
        [
          JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "Do the thing." }] } }),
          JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } }),
        ].join("\n") + "\n",
        "utf8",
      );
      const output = await invokeHook(runEnv, {
        cwd: repoRoot,
        hook_event_name: "Stop",
        stop_hook_active: false,
        transcript_path: transcriptPath,
      });
      expect(JSON.stringify(output)).not.toContain("ALREADY_RUNNING");
      expect(output.decision).not.toBe("block");
      const db = new Database(paths.stateDbPath, { readonly: true });
      try {
        // The gate ran: a review_gate job row exists next to the seeded one.
        const row = db.query("SELECT COUNT(*) AS n FROM jobs WHERE command_type = 'review_gate'").get() as { n: number };
        expect(row.n).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      await cleanupTestPath(root);
      await cleanupTestPath(repoRoot);
    }
  }, 60_000);
});

async function invokeHook(runEnv: NodeJS.ProcessEnv, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const child = spawn("node", ["--import", "tsx", hookScriptPath], {
    cwd: process.cwd(),
    env: runEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(`${JSON.stringify(payload)}\n`);
  const exitCode = await new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });
  if (exitCode !== 0) {
    throw new Error(stderr || `hook exited with code ${String(exitCode)}`);
  }
  return JSON.parse(stdout.trim() || "{}") as Record<string, unknown>;
}
