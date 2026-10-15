import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { renderSetupResult, runSetup } from "../../runtime/commands/setup.js";
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
});
