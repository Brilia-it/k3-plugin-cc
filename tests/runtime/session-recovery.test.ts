import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runAsk } from "../../runtime/commands/ask.js";
import { JobStore } from "../../runtime/job-store.js";
import {
  findUnverifiedSessionCandidate,
  normalizeWorkDir,
  snapshotSessionIndex,
} from "../../runtime/kimi-session-recovery.js";
import { resolvePluginPaths } from "../../runtime/paths.js";
import type { CommandContext } from "../../runtime/types.js";
import { cleanupTestPath, createGitRepoFixture, createTestPluginDataRoot } from "../helpers/test-env.js";

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

function indexLine(sessionId: string, workDir: string): string {
  return JSON.stringify({ sessionId, sessionDir: `/kimi/sessions/${sessionId}`, workDir, extra: "ignored" });
}

describe("session index candidate (unit, read-only, never adopted)", () => {
  test("normalizeWorkDir folds separators, trailing slash and Windows case", () => {
    expect(normalizeWorkDir("C:\\Users\\Me\\Repo\\")).toBe(normalizeWorkDir("c:/users/me/repo"));
    expect(normalizeWorkDir("C:\\Users\\Me\\Repo")).not.toBe(normalizeWorkDir("C:\\Users\\Me\\Other"));
  });

  test("exactly one new entry for the job cwd is offered as a candidate", async () => {
    const home = await createTestPluginDataRoot("candidate-one");
    try {
      await writeFile(path.join(home, "session_index.jsonl"), `${indexLine("old-1", "/w/a")}\n`, "utf8");
      const env = { KIMI_CODE_HOME: home };
      const before = await snapshotSessionIndex(env, "/w/a");
      expect(before.complete).toBe(true);
      await writeFile(
        path.join(home, "session_index.jsonl"),
        [indexLine("old-1", "/w/a"), indexLine("new-1", "/w/a"), indexLine("new-elsewhere", "/w/other")].join("\n") + "\n",
        "utf8",
      );
      expect(await findUnverifiedSessionCandidate(before, env, "/w/a")).toEqual({ candidate: "new-1" });
    } finally {
      await cleanupTestPath(home);
    }
  });

  test("two new entries (another plugin job or an interactive kimi) give no candidate", async () => {
    const home = await createTestPluginDataRoot("candidate-two");
    try {
      const env = { KIMI_CODE_HOME: home };
      const before = await snapshotSessionIndex(env, "/w/a");
      await writeFile(
        path.join(home, "session_index.jsonl"),
        [indexLine("new-1", "/w/a"), indexLine("new-2", "/w/a")].join("\n") + "\n",
        "utf8",
      );
      expect(await findUnverifiedSessionCandidate(before, env, "/w/a")).toEqual({
        candidate: null,
        reason: "ambiguous",
      });
    } finally {
      await cleanupTestPath(home);
    }
  });

  test("a malformed line in the baseline makes the baseline incomplete: no candidate (index rebuild)", async () => {
    const home = await createTestPluginDataRoot("candidate-partial");
    try {
      await writeFile(
        path.join(home, "session_index.jsonl"),
        [indexLine("old-1", "/w/a"), "{not json", indexLine("../evil", "/w/a")].join("\n") + "\n",
        "utf8",
      );
      const env = { KIMI_CODE_HOME: home };
      const before = await snapshotSessionIndex(env, "/w/a");
      expect(before.complete).toBe(false);
      await writeFile(
        path.join(home, "session_index.jsonl"),
        [indexLine("old-1", "/w/a"), indexLine("old-2-rebuilt", "/w/a")].join("\n") + "\n",
        "utf8",
      );
      expect(await findUnverifiedSessionCandidate(before, env, "/w/a")).toEqual({
        candidate: null,
        reason: "incomplete-index",
      });
    } finally {
      await cleanupTestPath(home);
    }
  });

  test("no baseline, or no new entry for the cwd: no candidate", async () => {
    const home = await createTestPluginDataRoot("candidate-none");
    try {
      const env = { KIMI_CODE_HOME: home };
      const before = await snapshotSessionIndex(env, "/w/a");
      await writeFile(path.join(home, "session_index.jsonl"), `${indexLine("elsewhere", "/w/other")}\n`, "utf8");
      expect(await findUnverifiedSessionCandidate(before, env, "/w/a")).toEqual({
        candidate: null,
        reason: "none-new",
      });
      expect(await findUnverifiedSessionCandidate(null, env, "/w/a")).toEqual({
        candidate: null,
        reason: "no-baseline",
      });
    } finally {
      await cleanupTestPath(home);
    }
  });
});

describe("a job stopped by a usage limit: announced sessions only", () => {
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

  async function failWith(runEnv: NodeJS.ProcessEnv, repoRoot: string) {
    let caught: unknown;
    try {
      await runAsk(["read the big document"], makeContext(repoRoot, runEnv));
    } catch (error) {
      caught = error;
    }
    return caught as Error & { code?: string };
  }

  test("announced id: stored on the failed job, the quota error gives the exact resume command, resume continues it", async () => {
    const root = await createTestPluginDataRoot("recovery-announced");
    const kimiHome = await createTestPluginDataRoot("recovery-announced-home");
    const repoRoot = await createGitRepoFixture("recovery-announced-repo");
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const invocationPath = path.join(root, "invocation.json");
    const failEnv = {
      ...makeMockEnv(root, kimiHome, "quota-fail"),
      K3_PLUGIN_CC_MOCK_ANNOUNCE_ON_FAIL: "1",
      K3_PLUGIN_CC_MOCK_SESSION_ID: sessionId,
    };
    try {
      const err = await failWith(failEnv, repoRoot);
      expect(err.code).toBe("ASK_KIMI_QUOTA_EXHAUSTED");
      const jobId = jobIdFromMessage(err.message);
      expect(err.message).toContain(`/k3:ask --resume ${jobId}`);
      expect(err.message).not.toContain("a retry starts from zero");
      const failed = await readStoredJob(failEnv, jobId);
      expect(failed?.status).toBe("failed");
      expect(failed?.kimi_session_id).toBe(sessionId);

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

  test("nothing announced, one new index entry (could be an interactive kimi): never adopted, only a human hint", async () => {
    const root = await createTestPluginDataRoot("recovery-hint");
    const kimiHome = await createTestPluginDataRoot("recovery-hint-home");
    const repoRoot = await createGitRepoFixture("recovery-hint-repo");
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const failEnv = {
      ...makeMockEnv(root, kimiHome, "quota-fail"),
      K3_PLUGIN_CC_MOCK_INDEX_ENTRY: "1",
      K3_PLUGIN_CC_MOCK_SESSION_ID: sessionId,
    };
    try {
      await mkdir(kimiHome, { recursive: true });
      await writeFile(path.join(kimiHome, "session_index.jsonl"), `${indexLine("older", "/somewhere/else")}\n`, "utf8");
      const err = await failWith(failEnv, repoRoot);
      expect(err.code).toBe("ASK_KIMI_QUOTA_EXHAUSTED");
      const jobId = jobIdFromMessage(err.message);
      expect((await readStoredJob(failEnv, jobId))?.kimi_session_id).toBeNull();
      expect(err.message).not.toContain("/k3:ask --resume");
      expect(err.message).toContain(`Kimi may have created session ${sessionId} (not verified as this job's)`);
      expect(err.message).toContain(`\`kimi -r ${sessionId}\` in a terminal resumes it interactively`);
      expect(err.message).toContain("a retry starts from zero");
      // And the job cannot be resumed through the plugin.
      const okEnv = makeMockEnv(root, kimiHome, "ask-success");
      await expect(runAsk(["--resume", jobId], makeContext(repoRoot, okEnv))).rejects.toMatchObject({
        code: "ASK_RESUME_NOT_FOUND",
      });
    } finally {
      await cleanupTestPath(root);
      await cleanupTestPath(kimiHome);
      await cleanupTestPath(repoRoot);
    }
  }, 60_000);

  test("two new entries for this cwd: no adoption and no hint", async () => {
    const root = await createTestPluginDataRoot("recovery-ambiguous");
    const kimiHome = await createTestPluginDataRoot("recovery-ambiguous-home");
    const repoRoot = await createGitRepoFixture("recovery-ambiguous-repo");
    const failEnv = {
      ...makeMockEnv(root, kimiHome, "quota-fail"),
      K3_PLUGIN_CC_MOCK_INDEX_ENTRY: "1",
      K3_PLUGIN_CC_MOCK_INDEX_EXTRA: "1",
    };
    try {
      const err = await failWith(failEnv, repoRoot);
      expect(err.code).toBe("ASK_KIMI_QUOTA_EXHAUSTED");
      expect(err.message).toContain("a retry starts from zero");
      expect(err.message).not.toContain("Kimi may have created session");
      expect((await readStoredJob(failEnv, jobIdFromMessage(err.message)))?.kimi_session_id).toBeNull();
    } finally {
      await cleanupTestPath(root);
      await cleanupTestPath(kimiHome);
      await cleanupTestPath(repoRoot);
    }
  }, 60_000);

  test("a baseline index with a malformed line (rebuilt index): no adoption and no hint", async () => {
    const root = await createTestPluginDataRoot("recovery-rebuilt");
    const kimiHome = await createTestPluginDataRoot("recovery-rebuilt-home");
    const repoRoot = await createGitRepoFixture("recovery-rebuilt-repo");
    const failEnv = { ...makeMockEnv(root, kimiHome, "quota-fail"), K3_PLUGIN_CC_MOCK_INDEX_ENTRY: "1" };
    try {
      await writeFile(path.join(kimiHome, "session_index.jsonl"), "{broken line\n", "utf8");
      const err = await failWith(failEnv, repoRoot);
      expect(err.message).not.toContain("Kimi may have created session");
      expect((await readStoredJob(failEnv, jobIdFromMessage(err.message)))?.kimi_session_id).toBeNull();
    } finally {
      await cleanupTestPath(root);
      await cleanupTestPath(kimiHome);
      await cleanupTestPath(repoRoot);
    }
  }, 60_000);
});
