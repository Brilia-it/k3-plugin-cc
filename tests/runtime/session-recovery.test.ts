import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runAsk } from "../../runtime/commands/ask.js";
import { JobStore } from "../../runtime/job-store.js";
import {
  normalizeWorkDir,
  recoverSessionFromIndex,
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

describe("session index recovery (unit)", () => {
  test("normalizeWorkDir folds separators, trailing slash and Windows case", () => {
    expect(normalizeWorkDir("C:\\Users\\Me\\Repo\\")).toBe(normalizeWorkDir("c:/users/me/repo"));
    expect(normalizeWorkDir("C:\\Users\\Me\\Repo")).not.toBe(normalizeWorkDir("C:\\Users\\Me\\Other"));
  });

  test("accepts exactly one new entry whose workDir is the job cwd", async () => {
    const home = await createTestPluginDataRoot("recovery-one");
    try {
      await writeFile(path.join(home, "session_index.jsonl"), `${indexLine("old-1", "/w/a")}\n`, "utf8");
      const env = { KIMI_CODE_HOME: home };
      const before = await snapshotSessionIndex(env, "/w/a");
      await writeFile(
        path.join(home, "session_index.jsonl"),
        [indexLine("old-1", "/w/a"), indexLine("new-1", "/w/a"), indexLine("new-elsewhere", "/w/other")].join("\n") + "\n",
        "utf8",
      );
      const outcome = await recoverSessionFromIndex(before, env, "/w/a");
      expect(outcome).toEqual({ sessionId: "new-1", source: "index" });
    } finally {
      await cleanupTestPath(home);
    }
  });

  test("two new entries for the cwd are ambiguous: nothing is guessed", async () => {
    const home = await createTestPluginDataRoot("recovery-two");
    try {
      const env = { KIMI_CODE_HOME: home };
      const before = await snapshotSessionIndex(env, "/w/a");
      expect(before.readable).toBe(true);
      await writeFile(
        path.join(home, "session_index.jsonl"),
        [indexLine("new-1", "/w/a"), indexLine("new-2", "/w/a")].join("\n") + "\n",
        "utf8",
      );
      expect(await recoverSessionFromIndex(before, env, "/w/a")).toEqual({ sessionId: null, reason: "ambiguous" });
    } finally {
      await cleanupTestPath(home);
    }
  });

  test("no new entry for the cwd, or no baseline, or an unsafe id: null", async () => {
    const home = await createTestPluginDataRoot("recovery-none");
    try {
      const env = { KIMI_CODE_HOME: home };
      const before = await snapshotSessionIndex(env, "/w/a");
      await writeFile(
        path.join(home, "session_index.jsonl"),
        [indexLine("new-elsewhere", "/w/other"), indexLine("../evil", "/w/a"), "not json"].join("\n") + "\n",
        "utf8",
      );
      expect(await recoverSessionFromIndex(before, env, "/w/a")).toEqual({ sessionId: null, reason: "none-new" });
      expect(await recoverSessionFromIndex(null, env, "/w/a")).toEqual({ sessionId: null, reason: "no-baseline" });
    } finally {
      await cleanupTestPath(home);
    }
  });

  test("Windows paths match across separator and case differences", async () => {
    const home = await createTestPluginDataRoot("recovery-win");
    try {
      const env = { KIMI_CODE_HOME: home };
      const before = await snapshotSessionIndex(env, "C:\\Work\\Repo");
      await writeFile(path.join(home, "session_index.jsonl"), `${indexLine("w-1", "c:/work/repo")}\n`, "utf8");
      expect(await recoverSessionFromIndex(before, env, "C:\\Work\\Repo\\")).toEqual({
        sessionId: "w-1",
        source: "index",
      });
    } finally {
      await cleanupTestPath(home);
    }
  });
});

describe("a job stopped by a usage limit keeps its session and can be resumed", () => {
  async function readStoredSession(runEnv: NodeJS.ProcessEnv, jobId: string) {
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

  test("announced id: stored on the failed job, quota error gives the exact resume command, resume continues it", async () => {
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
      let caught: unknown;
      try {
        await runAsk(["read the big document"], makeContext(repoRoot, failEnv));
      } catch (error) {
        caught = error;
      }
      const err = caught as Error & { code?: string };
      expect(err.code).toBe("ASK_KIMI_QUOTA_EXHAUSTED");
      const jobId = jobIdFromMessage(err.message);
      expect(err.message).toContain(`/k3:ask --resume ${jobId}`);
      expect(err.message).not.toContain("a retry starts from zero");

      const failed = await readStoredSession(failEnv, jobId);
      expect(failed?.status).toBe("failed");
      expect(failed?.kimi_session_id).toBe(sessionId);

      // The window rolled over: resume the failed job's kimi session.
      const okEnv = {
        ...makeMockEnv(root, kimiHome, "ask-success"),
        K3_PLUGIN_CC_MOCK_INVOCATION_PATH: invocationPath,
      };
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

  test("nothing announced: the id is recovered from kimi's session index (one new entry for this cwd)", async () => {
    const root = await createTestPluginDataRoot("recovery-index");
    const kimiHome = await createTestPluginDataRoot("recovery-index-home");
    const repoRoot = await createGitRepoFixture("recovery-index-repo");
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const failEnv = {
      ...makeMockEnv(root, kimiHome, "quota-fail"),
      K3_PLUGIN_CC_MOCK_INDEX_ENTRY: "1",
      K3_PLUGIN_CC_MOCK_SESSION_ID: sessionId,
    };
    try {
      await mkdir(kimiHome, { recursive: true });
      await writeFile(path.join(kimiHome, "session_index.jsonl"), `${indexLine("older", "/somewhere/else")}\n`, "utf8");
      let caught: unknown;
      try {
        await runAsk(["read the big document"], makeContext(repoRoot, failEnv));
      } catch (error) {
        caught = error;
      }
      const err = caught as Error & { code?: string };
      expect(err.code).toBe("ASK_KIMI_QUOTA_EXHAUSTED");
      const jobId = jobIdFromMessage(err.message);
      expect(err.message).toContain(`/k3:ask --resume ${jobId}`);
      expect((await readStoredSession(failEnv, jobId))?.kimi_session_id).toBe(sessionId);
    } finally {
      await cleanupTestPath(root);
      await cleanupTestPath(kimiHome);
      await cleanupTestPath(repoRoot);
    }
  }, 60_000);

  test("two new entries for this cwd: the id stays null and the message says a retry starts from zero", async () => {
    const root = await createTestPluginDataRoot("recovery-ambiguous");
    const kimiHome = await createTestPluginDataRoot("recovery-ambiguous-home");
    const repoRoot = await createGitRepoFixture("recovery-ambiguous-repo");
    const failEnv = {
      ...makeMockEnv(root, kimiHome, "quota-fail"),
      K3_PLUGIN_CC_MOCK_INDEX_ENTRY: "1",
      K3_PLUGIN_CC_MOCK_INDEX_EXTRA: "1",
    };
    try {
      let caught: unknown;
      try {
        await runAsk(["read the big document"], makeContext(repoRoot, failEnv));
      } catch (error) {
        caught = error;
      }
      const err = caught as Error & { code?: string };
      expect(err.code).toBe("ASK_KIMI_QUOTA_EXHAUSTED");
      expect(err.message).toContain("a retry starts from zero");
      expect((await readStoredSession(failEnv, jobIdFromMessage(err.message)))?.kimi_session_id).toBeNull();
    } finally {
      await cleanupTestPath(root);
      await cleanupTestPath(kimiHome);
      await cleanupTestPath(repoRoot);
    }
  }, 60_000);
});
