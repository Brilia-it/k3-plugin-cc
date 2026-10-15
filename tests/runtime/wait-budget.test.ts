import { describe, expect, test } from "bun:test";
import path from "node:path";

import { runAsk } from "../../runtime/commands/ask.js";
import {
  BACKGROUND_WAIT_GRACE_MS,
  resolveBackgroundWaitTimeoutMs,
} from "../../runtime/background-spawn.js";
import { JobStore } from "../../runtime/job-store.js";
import { waitForTerminalJob } from "../../runtime/jobs.js";
import { KIMI_ASK_PROMPT_TIMEOUT_MS, KIMI_RESCUE_PROMPT_TIMEOUT_MS } from "../../runtime/kimi-timeouts.js";
import { resolvePluginPaths } from "../../runtime/paths.js";
import type { CommandContext } from "../../runtime/types.js";
import { cleanupTestPath, createGitRepoFixture, createTestPluginDataRoot } from "../helpers/test-env.js";

const mockCliPath = path.join(process.cwd(), "tests/helpers/mock-kimi-cli-v1.ts");

function makeContext(cwd: string, runEnv: NodeJS.ProcessEnv): CommandContext {
  return { cwd, env: runEnv, stdout: process.stdout, stderr: process.stderr };
}

function makeMockEnv(pluginDataRoot: string, scenario: string, delayMs: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDE_PLUGIN_DATA: pluginDataRoot,
    K3_PLUGIN_CC_KIMI_BIN: "bun",
    K3_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
    K3_PLUGIN_CC_MOCK_SCENARIO: scenario,
    K3_PLUGIN_CC_MOCK_DELAY_MS: String(delayMs),
    K3_PLUGIN_CC_NODE_BIN: "node",
    K3_PLUGIN_CC_SKIP_HOOK_CHECK: "1",
  };
}

describe("--wait waits for the job (2026-10-15 incident)", () => {
  test("the wait is the command's own budget plus a grace period, not a fixed 60 s", () => {
    expect(resolveBackgroundWaitTimeoutMs(KIMI_ASK_PROMPT_TIMEOUT_MS, {})).toBe(
      KIMI_ASK_PROMPT_TIMEOUT_MS + BACKGROUND_WAIT_GRACE_MS,
    );
    expect(resolveBackgroundWaitTimeoutMs(KIMI_RESCUE_PROMPT_TIMEOUT_MS, {})).toBe(
      KIMI_RESCUE_PROMPT_TIMEOUT_MS + BACKGROUND_WAIT_GRACE_MS,
    );
    expect(KIMI_ASK_PROMPT_TIMEOUT_MS + BACKGROUND_WAIT_GRACE_MS).toBeGreaterThan(60_000);
  });

  test("the test-only override replaces the total; junk values are ignored", () => {
    expect(resolveBackgroundWaitTimeoutMs(900_000, { K3_PLUGIN_CC_WAIT_TIMEOUT_MS: "1500" })).toBe(1500);
    expect(resolveBackgroundWaitTimeoutMs(900_000, { K3_PLUGIN_CC_WAIT_TIMEOUT_MS: "abc" })).toBe(
      900_000 + BACKGROUND_WAIT_GRACE_MS,
    );
    expect(resolveBackgroundWaitTimeoutMs(900_000, { K3_PLUGIN_CC_WAIT_TIMEOUT_MS: "0" })).toBe(
      900_000 + BACKGROUND_WAIT_GRACE_MS,
    );
  });

  test("a job that outlives the wait yields JOB_WAIT_TIMEOUT saying it is STILL RUNNING", async () => {
    const root = await createTestPluginDataRoot("wait-budget-timeout");
    const repoRoot = await createGitRepoFixture("wait-budget-timeout-repo");
    const runEnv = { ...makeMockEnv(root, "ask-success", 4000), K3_PLUGIN_CC_WAIT_TIMEOUT_MS: "800" };
    try {
      let caught: unknown;
      try {
        await runAsk(["--background", "--wait", "slow question"], makeContext(repoRoot, runEnv));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const err = caught as Error & { code?: string };
      expect(err.code).toBe("JOB_WAIT_TIMEOUT");
      expect(err.message).toContain("STILL RUNNING");
      expect(err.message).toContain("Do not start another model job");
      expect(err.message).toContain("/k3:status");
      expect(err.message).toContain("/k3:result");

      // Let the worker finish so the fixture can be removed.
      const paths = resolvePluginPaths(runEnv);
      const store = new JobStore(paths);
      const ids = store.listRunningJobs().map((job) => job.job_id);
      store.close();
      for (const id of ids) {
        await waitForTerminalJob(() => new JobStore(paths), id, 20_000);
      }
    } finally {
      await cleanupTestPath(root);
      await cleanupTestPath(repoRoot);
    }
  }, 40_000);
});
