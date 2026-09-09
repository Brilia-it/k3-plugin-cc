# Native v2 status — 2026-09-09

kimi-code **0.42.0** (commit `6954d2c8bf94a5c7fc29cc6ae35b15d042cc4dcb`) removed the
legacy agent-core-v1 package and `KIMI_CODE_LEGACY_FLAG` (#3542, not mentioned in
its changelog). `kimi -p` is native v2 unconditionally. The plugin's forced-v1 pin
is therefore inert on 0.42.0, and the plan-before-external-hooks ordering the
plugin refused since v1.9.4 is still present — now confirmed in the shipped
bundle, not only in source (`registerFeature(PlanFeature)` precedes
`registerFeature(ExternalHooksFeature)` in `dist/main.mjs`).

kimi-plugin-cc **1.10.0** migrates every operation to native v2 under the
[amended entry gate](native-v2-certification-provenance.md#2-native-v2-entry-gate):
the engine's only chain-breaking final allow is provably never armed in a
plugin-managed session, and every executed tool call passes the managed hook.

## The construction, at exact 0.42.0

- The sole `event.allow()` in `agent-core-v2/src` + `apps/kimi-code/src` is the plan-file
  guard, `features/plan/planService.ts:110`, gated by `if (plan === null) return;` (`:104`).
  It fires only while plan mode is ACTIVE, and only for a Write/Edit whose every write access
  string-equals the plan path under `<KIMI_CODE_HOME>/sessions/…/plans/<id>.md` (`:238-240`,
  `:259-270`; `..` collapsed by `pathe.normalize`, no realpath).
- Plan mode arms from a `kimi -p` session in exactly three ways:
  1. `default_plan_mode = true` in the single user `config.toml`, read once inside
     `sessions.create()` (`sessionLifecycleService.ts:221-227`; no env, argv or project overlay;
     `printDefaults.ts` leaves it alone). **Closed pre-spawn** by
     `runtime/native-v2-preflight.ts::inspectPlanModeConfig` (`CLI_V2_PLAN_MODE_CONFIGURED`).
  2. The `EnterPlanMode` tool (`enterPlanModeTool.ts:38`), an ordinary tool: nothing
     final-allows it and the auto-approve policy uses non-terminal `pass()`. **Closed** by the
     managed hook (`approval-policy.ts` denies `EnterPlanMode`/`ExitPlanMode` for every label).
     Confirmed live on 0.42.0: the hook saw the call and denied it; no plan file.
  3. Resume of a session whose agent journal holds a durable `plan_mode.enter` record
     (`planOps.ts:20`, replayed active `:84-93`; `doResume` never exits plan). `restore()` folds
     ONLY `agents/<agentId>/wire.jsonl` (`eventDispatcherService.ts:776-826`; `rehydrateStates`
     reloads blobs only; fork excludes plan state, `state.ts:72`). **Closed** by resuming only
     proven native-v2 plugin lineage after a raw journal scan
     (`scanSessionJournalsForPlan` → `KIMI_SESSION_PLAN_TAINTED`).
- Not reachable from `-p`: kap-server `sessionAgentConfig` (`kimi web/server` only), the TUI
  `/plan` command (`-p` intercepts only `/goal`), `--plan` (rejected with `-p`), agent profiles
  (no plan field; builtin `plan` profile excludes `EnterPlanMode`), subagents/AgentSwarm/`Agent`/
  fork/tower (fresh scope, empty journal), undo (kap only).
- Every execution passes `prepareToolCall` → `fireBeforeExecute` (`toolExecutorService.ts:415`);
  MCP tools share the registry; each subagent gets its own eager external-hooks service. A hook
  veto beats the auto-approve gate. Hook contract unchanged: strict
  `{event, matcher?, command, timeout?}`, exit 2 = deny, first block wins, fail-open on runner
  errors.

Live evidence (2026-09-09, isolated seeded home, deny-all hook, plan mode off): an ordinary
`Write` and an `EnterPlanMode` attempt both reached the hook and were denied. With plan mode
ON (monitor control), the plan-file `Write` bypasses the hook in both unflagged and
`KIMI_CODE_LEGACY_FLAG=1` runs — the refusal is load-bearing and the flag is inert.

## Other 0.42.0 facts the plugin now depends on

- `Bash` accepts `cwd`; `effectiveCwd = view.resolve(args.cwd ?? view.workDir)` (`bashTool.ts:191`)
  asserts no workspace membership, and the hook payload's top-level `cwd` is the process cwd —
  the rescue allowlist reads `tool_input.cwd` and confines it to the trusted root.
- `-r` refuses when the session's recorded cwd differs from the current cwd
  (`run-v2-print.ts:426-432`).
- `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY` is still a hard cap, but **unset = no cap**; the
  plugin always exports it (4 read / 1 write).
- The update preflight runs on the `-p` path; every spawn exports `KIMI_CODE_NO_AUTO_UPDATE=1`.
- `[experimental]` config alone can enable `tower`/`subagent_fork`; the preflight refuses them
  (`CLI_V2_EXPERIMENTAL_UNSAFE`) alongside the master `KIMI_CODE_EXPERIMENTAL_FLAG`.
- `system.version` is always the first stream-json line; a native-v2 plan REQUIRES it and it
  must equal the probed version (`CLI_ENGINE_PROVENANCE_MISMATCH` otherwise).
- Write/Edit still use `path`; a new singular `Agent` tool exists and stays denied.

## What this does not claim

- Not "the hook precedes every final allow". Upstream documents no ordering contract; the
  construction is re-proven per certified tag by `tests/audit/v2-tag-scan.test.ts` plus the
  plan-ON live control, and certification is exact-version (`0.42.0`), per operation. The scan
  sha256-pins not only the allow gate and plan guard but the restore-folding source
  (`state/eventDispatcherService.ts`, `state/state.ts`), so a future patch that widens what
  `restore()` loads — the one closure the journal taint scan depends on — fails the audit
  loudly instead of silently outflanking `scanSessionJournalsForPlan`.
- The upstream hook runner still fails open on its own internal errors; allowed repo test/build
  commands still execute repo code. Unchanged from v1.
- Native plan mode, tower, subagent fork, Remote Control, `--add-dir` are out of scope and
  refused or never passed.

## Upstream follow-up

[#3431](https://github.com/MoonshotAI/kimi-code/issues/3431) stays open as the preferred end
state (a released external-hook-before-every-final-allow guarantee would let the gate return to
its original form and permit native plan mode). The reference fix needs a rebase onto 0.42.0.
