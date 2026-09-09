// Mechanized native-v2 tag scan (audit routine, not CI-default).
//
// Native v2 is certified on a construction, not on an upstream ordering
// contract: the engine's ONLY chain-breaking final allow is the plan-file
// guard, it fires only while plan mode is active, and the plugin closes every
// route by which plan mode can arm in a `kimi -p` session. That construction is
// an enumeration over one exact source tree, so it must be re-established for
// every kimi-code version before that version is appended to
// `NATIVE_V2_CERTIFIED` (runtime/kimi-engine.ts). This file is that
// re-establishment, in symbol-level form. It cannot see semantic regressions
// (a new listener that performs a side effect and then vetoes; a tool whose
// `resolveExecution` has effects; a final allow reached via a destructured or
// bracket-notation reference such as `const {allow}=event; allow()` or
// `event['allow']()`, which the literal ".allow()" scan below does not match)
// — those remain the human checklist in docs/upstream-compat-audit.md. The
// sha256 pins below are the backstop: any byte change to a load-bearing file
// (the allow gate, the plan guard, or the restore-folding source the journal
// taint scan depends on) forces a human re-read even when a symbol scan is
// blind to the change.
//
// Run: KIMI_CODE_SOURCE_TAG_DIR=/path/to/kimi-code@<tag> bun test tests/audit/
// Skips (does not fail) when the env var is unset.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";

const SOURCE = process.env.KIMI_CODE_SOURCE_TAG_DIR;
const suite = SOURCE !== undefined && existsSync(SOURCE) ? describe : describe.skip;

const CORE = "packages/agent-core-v2/src";
const CLI = "apps/kimi-code/src";
const KAP = "packages/kap-server/src";

/**
 * Per-version pins for files whose exact bytes decide the construction. A new
 * version MUST add its own row after a human read of the diff; a missing row
 * fails the scan rather than silently accepting drift.
 */
const PINNED_HASHES: Record<string, Record<string, string>> = {
  "0.42.0": {
    [`${CORE}/agent/toolExecutor/beforeToolExecuteEvent.ts`]:
      "ef981d83e607f0427f77a0fc89e4c03d301116b01ac5f0c33bb68ea955749455",
    [`${CORE}/features/plan/planService.ts`]:
      "1d3526543839a78820e6a2e21f746c311e3034812f479233a4462a2a4fe5fc4d",
    // The resume-taint closure (vector C) rests on restore() folding ONLY the
    // agent wire journal — that is what scanSessionJournalsForPlan walks. Pin
    // the restore-folding source and the fork snapshot-exclusion so a future
    // patch that widens what restore() loads (a snapshot/checkpoint/compaction
    // path carrying plan state) fails THIS audit loudly instead of silently
    // narrowing what the journal scan actually verifies.
    [`${CORE}/state/eventDispatcherService.ts`]:
      "0f2f55a070a7a69ea9baac98c5fadb96c3ef47fb44596b044431fc768e7be264",
    [`${CORE}/state/state.ts`]:
      "b1b1de1d3060d29e998292e4a3047eedfbf05bf181c199d8800694e23a567fb5",
  },
};

/** Every production subscriber of the before-execute channel at the pinned tag. */
const EXPECTED_BEFORE_EXECUTE_SUBSCRIBERS = [
  `${CORE}/agent/permissionGate/permissionGateService.ts`,
  `${CORE}/agent/toolDedupe/toolDedupeService.ts`,
  `${CORE}/features/btw/btwService.ts`,
  `${CORE}/features/externalHooks/agent/agentExternalHooksService.ts`,
  `${CORE}/features/goal/goalService.ts`,
  `${CORE}/features/plan/planService.ts`,
  `${CORE}/features/swarm/agent/swarmService.ts`,
  `${CORE}/features/tower/towerService.ts`,
];

function abs(rel: string): string {
  return path.join(SOURCE ?? "", rel);
}

function read(rel: string): string {
  return readFileSync(abs(rel), "utf8");
}

function isProductionTs(rel: string): boolean {
  return rel.endsWith(".ts") && !rel.includes("/test/") && !rel.endsWith(".test.ts");
}

function* walk(rel: string): Generator<string> {
  const dir = abs(rel);
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const childRel = path.join(rel, entry);
    if (statSync(abs(childRel)).isDirectory()) {
      yield* walk(childRel);
    } else {
      yield childRel;
    }
  }
}

function filesContaining(roots: string[], needle: string | RegExp): string[] {
  const hits: string[] = [];
  for (const root of roots) {
    for (const rel of walk(root)) {
      if (!isProductionTs(rel)) continue;
      const contents = read(rel);
      const matched = typeof needle === "string" ? contents.includes(needle) : needle.test(contents);
      if (matched) hits.push(rel);
    }
  }
  return hits.sort();
}

function upstreamVersion(): string {
  const pkg = JSON.parse(read("apps/kimi-code/package.json")) as { version: string };
  return pkg.version;
}

suite("native-v2 tag scan: the no-plan construction holds at this source tree", () => {
  test("the tag is pinned and its load-bearing files are byte-identical to the audited bytes", () => {
    const version = upstreamVersion();
    const pins = PINNED_HASHES[version];
    expect(pins, `no pinned hashes for kimi-code ${version}; audit the diff and add a row`).toBeDefined();
    for (const [rel, expected] of Object.entries(pins ?? {})) {
      const actual = createHash("sha256").update(readFileSync(abs(rel))).digest("hex");
      expect(actual, `${rel} changed since the audited ${version} bytes`).toBe(expected);
    }
  });

  test("the plan-file guard is the ONLY final allow in the engine and the CLI", () => {
    const sites = filesContaining([CORE, CLI], ".allow()");
    expect(sites).toEqual([`${CORE}/features/plan/planService.ts`]);
    const guard = read(`${CORE}/features/plan/planService.ts`);
    // The allow must stay gated on an active plan: `if (plan === null) return;`
    // precedes the allow inside guardToolExecution.
    const gateIndex = guard.indexOf("if (plan === null)");
    const allowIndex = guard.indexOf("event.allow()");
    expect(gateIndex).toBeGreaterThan(-1);
    expect(allowIndex).toBeGreaterThan(gateIndex);
  });

  test("plan mode can only be entered from the three audited call sites", () => {
    expect(filesContaining([CORE, CLI, KAP], "new PlanModeEnter(")).toEqual([
      `${CORE}/features/plan/planService.ts`,
    ]);
    const enterCallers = filesContaining([CORE, CLI, KAP], "IAgentPlanService").filter((rel) =>
      read(rel).includes(".enter("),
    );
    expect(enterCallers).toEqual([
      `${CORE}/features/plan/tools/enter-plan-mode/enterPlanModeTool.ts`,
      `${CORE}/workspace/sessionLifecycle/sessionLifecycleService.ts`,
      `${KAP}/routes/sessionAgentConfig.ts`,
    ]);
  });

  test("default_plan_mode is a plain optional boolean with default false and no env binding", () => {
    const section = read(`${CORE}/features/plan/configSection.ts`);
    expect(section).toContain("z.boolean().optional()");
    expect(section).toContain("defaultValue: false");
    expect(section).not.toMatch(/\benv\s*:/);
  });

  test("print mode still rejects --plan and intercepts only /goal", () => {
    expect(read(`${CLI}/cli/options.ts`)).toContain("Cannot combine --prompt with --plan.");
    const runner = read(`${CLI}/cli/v2/run-v2-print.ts`);
    expect(runner).toContain("parseHeadlessGoalCreate(");
    expect(runner).not.toContain("dispatchInput(");
    expect(runner).not.toContain("'/plan'");
  });

  test("every tool execution passes the single before-execute emitter", () => {
    const callers = filesContaining([CORE], "fireBeforeExecute(");
    expect(callers).toEqual([
      `${CORE}/agent/toolExecutor/beforeToolExecuteEvent.ts`,
      `${CORE}/agent/toolExecutor/toolExecutorService.ts`,
    ]);
  });

  test("the before-execute subscriber population is exactly the audited set", () => {
    expect(filesContaining([CORE], "onBeforeExecuteTool(")).toEqual(
      EXPECTED_BEFORE_EXECUTE_SUBSCRIBERS,
    );
  });

  test("the external-hooks agent service is eager (present in every agent scope)", () => {
    const feature = read(`${CORE}/features/externalHooks/externalHooksFeature.ts`);
    expect(feature).toContain("contributeAgentService(IAgentExternalHooksService, AgentExternalHooksService)");
    expect(feature).not.toContain("OnDemand");
  });

  test("hook aggregation stays first-block-wins", () => {
    const match = read(`${CORE}/features/externalHooks/internal/matchHooks.ts`);
    expect(match).toContain("results.find((result) => result.action === 'block')");
  });

  test("tool schemas the allowlist reads keep their field names", () => {
    expect(read(`${CORE}/agent/tools/os/write/write.ts`)).toMatch(/\bpath:\s*z\b/);
    expect(read(`${CORE}/agent/tools/edit/edit.ts`)).toMatch(/\bpath:\s*z\b/);
    const bash = read(`${CORE}/agent/tools/os/bash/bash.ts`);
    expect(bash).toMatch(/\bcommand:\s*z\b/);
    // If upstream ever removes Bash.cwd the plugin's cwd policy becomes dead
    // code rather than unsafe; flag it so the audit notices either way.
    expect(bash).toMatch(/\bcwd:\s*z\b/);
  });

  test("session restore folds only the wire journal (the journal taint scan's premise)", () => {
    // scanSessionJournalsForPlan walks agents/<id>/wire.jsonl only. Its
    // completeness depends on restore() having no OTHER source of durable plan
    // state. Assert the folding loop still reads the wire journal and that no
    // snapshot/checkpoint LOADER was introduced as a second restore source
    // ("checkpoints" as an in-memory undo structure is fine; a read of a
    // persisted snapshot/checkpoint blob would be a new taint source).
    const dispatcher = read(`${CORE}/state/eventDispatcherService.ts`);
    expect(dispatcher).toContain("this.wire.readJournal()");
    expect(dispatcher).not.toMatch(/\b(loadSnapshot|readSnapshot|readCheckpoint|restoreSnapshot)\s*\(/);
    // Fork must keep plan state out of the snapshot it copies to children.
    expect(read(`${CORE}/state/state.ts`)).toContain("snapshotExcluded");
  });

  test("the legacy engine selector is gone (v2-only print mode)", () => {
    expect(filesContaining([CLI, CORE], "KIMI_CODE_LEGACY_FLAG")).toEqual([]);
    expect(read(`${CLI}/cli/run-prompt.ts`)).toContain("runV2Print");
  });
});
