import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import path from "node:path";

import { cleanupTestPath, createGitRepoFixture, createTestPluginDataRoot } from "../helpers/test-env.js";

// Review 0.7.0, finding 6: `--background --wait` on a job that ends failed or cancelled
// must keep printing the failure artifact on stdout but exit NON-ZERO, like the
// foreground path. Run against the BUILT JavaScript (dist/), as shipped.
const companion = path.join(process.cwd(), "dist", "companion.js");
const mockCliPath = path.join(process.cwd(), "tests/helpers/mock-kimi-cli-v1.ts");

function run(args: string[], runEnv: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [companion, ...args], { cwd, env: runEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function mockEnv(root: string, scenario: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDE_PLUGIN_DATA: root,
    KIMI_CODE_HOME: path.join(root, "kimi-home"),
    K3_PLUGIN_CC_KIMI_BIN: "bun",
    K3_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
    K3_PLUGIN_CC_MOCK_SCENARIO: scenario,
    K3_PLUGIN_CC_MOCK_DELAY_MS: "0",
    K3_PLUGIN_CC_NODE_BIN: "node",
    K3_PLUGIN_CC_SKIP_HOOK_CHECK: "1",
    K3_PLUGIN_CC_SKIP_VERSION_PROBE: "1",
  };
}

describe("--background --wait exit code (built companion)", () => {
  test("a quota failure prints the failure artifact on stdout and exits non-zero", async () => {
    const root = await createTestPluginDataRoot("wait-exit-fail");
    const repoRoot = await createGitRepoFixture("wait-exit-fail-repo");
    try {
      const result = await run(["ask", "--background", "--wait", "read the big document"], mockEnv(root, "quota-fail"), repoRoot);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toContain("ASK_KIMI_QUOTA_EXHAUSTED");
      expect(result.stdout).toContain("5-hour");
    } finally {
      await cleanupTestPath(root);
      await cleanupTestPath(repoRoot);
    }
  }, 90_000);

  test("a successful waited job still exits zero with the answer", async () => {
    const root = await createTestPluginDataRoot("wait-exit-ok");
    const repoRoot = await createGitRepoFixture("wait-exit-ok-repo");
    try {
      const result = await run(["ask", "--background", "--wait", "q"], mockEnv(root, "ask-success"), repoRoot);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Ask answer from mock Kimi.");
    } finally {
      await cleanupTestPath(root);
      await cleanupTestPath(repoRoot);
    }
  }, 90_000);
});
