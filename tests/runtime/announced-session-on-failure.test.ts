import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { runAsk } from "../../runtime/commands/ask.js";
import { runRescue } from "../../runtime/commands/rescue.js";
import { JobStore } from "../../runtime/job-store.js";
import { resolvePluginPaths } from "../../runtime/paths.js";
import type { CommandContext } from "../../runtime/types.js";
import { cleanupTestPath, createGitRepoFixture, createTestPluginDataRoot } from "../helpers/test-env.js";

// BRILIA fork (T02 row 19; the 2026-10-15 incident). A job stopped by a usage limit ends
// with a NON-ZERO exit, not a budget timeout, so upstream's timeout-only capture never
// kept its session. Carried from 0.7.0's tests/runtime/session-recovery.test.ts, renamed:
// upstream 2.5.6 has its own file of that name, about runtime/session-recovery.ts.
// 0.7.0's unverified session_index.jsonl hint is not carried (see
// runtime/failed-job-session.ts); its cases are replaced by upstream's prompt-digest
// recovery on the same failure branch.
const mockCliPath = path.join(process.cwd(), "tests/helpers/mock-kimi-cli-v1.ts");

function makeContext(cwd: string, runEnv: NodeJS.ProcessEnv): CommandContext {
  return { cwd, env: runEnv, stdout: process.stdout, stderr: process.stderr };
}

function makeMockEnv(pluginDataRoot: string, kimiHome: string, scenario: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDE_PLUGIN_DATA: pluginDataRoot,
    KIMI_CODE_HOME: kimiHome,
    K3_PLUGIN_CC_KIMI_BIN: "bun",
    K3_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
    K3_PLUGIN_CC_MOCK_SCENARIO: scenario,
    K3_PLUGIN_CC_MOCK_DELAY_MS: "0",
    K3_PLUGIN_CC_NODE_BIN: "node",
    K3_PLUGIN_CC_SKIP_HOOK_CHECK: "1",
  };
}

async function readStoredJob(runEnv: NodeJS.ProcessEnv, jobId: string) {
  const store = new JobStore(resolvePluginPaths(runEnv));
  try {
    return store.getJob(jobId);
  } finally {
    store.close();
  }
}

function jobIdFromMessage(message: string): string {
  const match = /Job ([0-9a-f-]{36}) was persisted as failed/.exec(message);
  expect(match).not.toBeNull();
  return match![1]!;
}

async function failAsk(runEnv: NodeJS.ProcessEnv, repoRoot: string) {
  let caught: unknown;
  try {
    await runAsk(["read the big document"], makeContext(repoRoot, runEnv));
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  return caught as Error & { code?: string };
}

describe("a job stopped by a usage limit keeps its session", () => {
  test("legacy engine, announced id: stored as 'announced', the quota error names the exact resume command, resume continues it", async () => {
    const root = await createTestPluginDataRoot("failed-session-announced");
    const kimiHome = await createTestPluginDataRoot("failed-session-announced-home");
    const repoRoot = await createGitRepoFixture("failed-session-announced-repo");
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const invocationPath = path.join(root, "invocation.json");
    const failEnv = {
      ...makeMockEnv(root, kimiHome, "quota-fail"),
      K3_PLUGIN_CC_MOCK_ANNOUNCE_ON_FAIL: "1",
      K3_PLUGIN_CC_MOCK_SESSION_ID: sessionId,
    };
    try {
      const err = await failAsk(failEnv, repoRoot);
      expect(err.code).toBe("ASK_KIMI_QUOTA_EXHAUSTED");
      const jobId = jobIdFromMessage(err.message);
      expect(err.message).toContain(`/k3:ask --resume ${jobId}`);
      expect(err.message).not.toContain("a retry starts from zero");
      const failed = await readStoredJob(failEnv, jobId);
      expect(failed?.status).toBe("failed");
      expect(failed?.kimi_session_id).toBe(sessionId);
      expect(failed?.kimi_session_id_source).toBe("announced");

      const okEnv = { ...makeMockEnv(root, kimiHome, "ask-success"), K3_PLUGIN_CC_MOCK_INVOCATION_PATH: invocationPath };
      const answer = await runAsk(["--resume", jobId], makeContext(repoRoot, okEnv));
      expect(answer).toBe("Ask answer from mock Kimi.");
      const invocation = JSON.parse(await readFile(invocationPath, "utf8")) as { argv: string[] };
      expect(invocation.argv[invocation.argv.indexOf("-r") + 1]).toBe(sessionId);
    } finally {
      await cleanupTestPath(root);
      await cleanupTestPath(kimiHome);
      await cleanupTestPath(repoRoot);
    }
  }, 60_000);

  test("nothing announced on the legacy engine: no session is kept, a retry starts from zero, resume is refused", async () => {
    const root = await createTestPluginDataRoot("failed-session-none");
    const kimiHome = await createTestPluginDataRoot("failed-session-none-home");
    const repoRoot = await createGitRepoFixture("failed-session-none-repo");
    const failEnv = makeMockEnv(root, kimiHome, "quota-fail");
    try {
      const err = await failAsk(failEnv, repoRoot);
      expect(err.code).toBe("ASK_KIMI_QUOTA_EXHAUSTED");
      const jobId = jobIdFromMessage(err.message);
      expect(err.message).toContain("a retry starts from zero");
      expect(err.message).not.toContain("/k3:ask --resume");
      expect((await readStoredJob(failEnv, jobId))?.kimi_session_id).toBeNull();
      await expect(
        runAsk(["--resume", jobId], makeContext(repoRoot, makeMockEnv(root, kimiHome, "ask-success"))),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^ASK_RESUME_/) });
    } finally {
      await cleanupTestPath(root);
      await cleanupTestPath(kimiHome);
      await cleanupTestPath(repoRoot);
    }
  }, 60_000);

  test("native v2, nothing announced: the session proven by upstream's prompt-digest recovery is kept as 'recovered_session_dir'", async () => {
    const root = await createTestPluginDataRoot("failed-session-v2");
    const kimiHome = await createTestPluginDataRoot("failed-session-v2-home");
    const repoRoot = await createGitRepoFixture("failed-session-v2-repo");
    const sessionId = "session_26242650-d95f-4805-80d9-c947d309b2c8";
    const failEnv = {
      ...makeMockEnv(root, kimiHome, "quota-fail"),
      K3_PLUGIN_CC_MOCK_VERSION: "2.2.0",
      K3_PLUGIN_CC_MOCK_RECOVERABLE_V2: "1",
      K3_PLUGIN_CC_MOCK_SESSION_ID: sessionId,
    };
    try {
      const err = await failAsk(failEnv, repoRoot);
      expect(err.code).toBe("ASK_KIMI_QUOTA_EXHAUSTED");
      const jobId = jobIdFromMessage(err.message);
      expect(err.message).toContain(`/k3:ask --resume ${jobId}`);
      const failed = await readStoredJob(failEnv, jobId);
      expect(failed?.observed_engine).toBe("native-v2");
      expect(failed?.kimi_session_id).toBe(sessionId);
      expect(failed?.kimi_session_id_source).toBe("recovered_session_dir");
    } finally {
      await cleanupTestPath(root);
      await cleanupTestPath(kimiHome);
      await cleanupTestPath(repoRoot);
    }
  }, 60_000);

  test("native v2, a same-window session whose journal opens with another prompt is never kept", async () => {
    const root = await createTestPluginDataRoot("failed-session-v2-digest");
    const kimiHome = await createTestPluginDataRoot("failed-session-v2-digest-home");
    const repoRoot = await createGitRepoFixture("failed-session-v2-digest-repo");
    const failEnv = {
      ...makeMockEnv(root, kimiHome, "quota-fail"),
      K3_PLUGIN_CC_MOCK_VERSION: "2.2.0",
      K3_PLUGIN_CC_MOCK_RECOVERABLE_V2: "1",
      K3_PLUGIN_CC_MOCK_SESSION_ID: "session_26242650-d95f-4805-80d9-c947d309b2c9",
      K3_PLUGIN_CC_MOCK_JOURNAL_PROMPT_OVERRIDE: "a prompt this job never sent",
    };
    try {
      const err = await failAsk(failEnv, repoRoot);
      expect(err.code).toBe("ASK_KIMI_QUOTA_EXHAUSTED");
      expect(err.message).toContain("a retry starts from zero");
      expect((await readStoredJob(failEnv, jobIdFromMessage(err.message)))?.kimi_session_id).toBeNull();
    } finally {
      await cleanupTestPath(root);
      await cleanupTestPath(kimiHome);
      await cleanupTestPath(repoRoot);
    }
  }, 60_000);

  test("rescue: an announced id on a quota failure is kept and the message names /k3:rescue --resume", async () => {
    const root = await createTestPluginDataRoot("failed-session-rescue");
    const kimiHome = await createTestPluginDataRoot("failed-session-rescue-home");
    const repoRoot = await createGitRepoFixture("failed-session-rescue-repo");
    const sessionId = "33333333-3333-4333-8333-333333333334";
    const failEnv = {
      ...makeMockEnv(root, kimiHome, "quota-fail"),
      K3_PLUGIN_CC_MOCK_ANNOUNCE_ON_FAIL: "1",
      K3_PLUGIN_CC_MOCK_SESSION_ID: sessionId,
    };
    try {
      const output = await runRescue(["fix the thing"], makeContext(repoRoot, failEnv));
      expect(output).toContain("RESCUE_KIMI_QUOTA_EXHAUSTED");
      const jobId = jobIdFromMessage(output);
      expect(output).toContain(`/k3:rescue --resume ${jobId}`);
      const failed = await readStoredJob(failEnv, jobId);
      expect(failed?.status).toBe("failed");
      expect(failed?.kimi_session_id).toBe(sessionId);
      expect(failed?.kimi_session_id_source).toBe("announced");
    } finally {
      await cleanupTestPath(root);
      await cleanupTestPath(kimiHome);
      await cleanupTestPath(repoRoot);
    }
  }, 60_000);
});
