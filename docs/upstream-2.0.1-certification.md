# Kimi Code 2.0.1 certification — 2026-09-19

Plugin 2.0.3 certifies exact `@moonshot-ai/kimi-code@2.0.1` for all eight operations under `native-v2-no-plan/1`. This release declares compatibility; installed hosts must be upgraded separately. Plugin versions now advance independently of CLI versions.

## Exact source and safety basis

The released source is [`caf7d4e2fef06967280b325da06e44a4b0516eba`](https://github.com/MoonshotAI/kimi-code/tree/caf7d4e2fef06967280b325da06e44a4b0516eba), compared with certified 2.0.0 (`1b89e4b039f052d10f258464413b2047acca12ba`). Four independent source reviews covered hooks, restore and plan entry, CLI lifecycle, and adversarial tool/child-scope behavior.

The sole chain-breaking final allow is still the active-plan file guard. Plan registration still precedes external hooks. The plugin must continue to refuse default plan mode, deny plan-entry tools, scan every resumed agent journal and reject unsafe experimental selectors. The hook runner's fail-open error behavior remains an upstream residual risk.

The changed `readRestoreChains()` reads one stable `wire.jsonl` snapshot and returns a branch/undo-filtered restorable view plus the journal view. The dispatcher folds both by literal record type. No new persisted plan-state source or migration was found; the plugin's raw journal scan remains conservative. The tag scanner now proves both projections and pins the changed dispatcher and wire-service bytes.

Hook configuration and event names are unchanged. The exact 2.0.1 schema check accepts the plugin's existing version-sensitive PermissionRequest, PermissionResult and Interrupt events; later patches, prereleases and build-suffixed versions remain unreviewed. This does not claim support for every upstream hook event.

The removed outside-cwd prompt instruction does not replace or weaken the plugin's trusted-root policy. Watcher and session-index changes preserve dirty-marker consumption. Stream provenance, tool input fields and eager per-agent external hooks remain intact.

## Verification

| Gate | Result |
| --- | --- |
| Exact 2.0.1 tag scan | 15 passed, 89 assertions |
| Scanner regression on 2.0.0 | 15 passed, 83 assertions |
| Plan mode on, deny-all hook | Plan file written, hook did not receive the plan write; Glob and ExitPlanMode reached the hook |
| Plan mode off, separate prompts | Write and EnterPlanMode both reached the hook and were denied; no target or plan file |
| Exact 2.0.1 candidate smoke | 15 passed, 0 failed, 84 assertions, 429.79 seconds; no retries |
| Pursue completion and blocked status | Both live cases called GetGoal and UpdateGoal, exited 0/3 respectively, and returned the matching native summary without hook rejection |
| Independent implementation review | No actionable findings |
| Full repository check | 898 passed, 28 opt-in skips, 0 failed, 2,965 assertions; build, types, generated surfaces and drift checks passed |

The smoke exercised read-only denials, unsafe-selector/default-plan refusals, fresh and resumed provenance, plan-tainted resume refusal, multi-turn goal enforcement, read-swarm child denial, positive write-swarm patch capture and cleanup, and out-of-root child-write denial. The goal denial case ran ten turns before its expected wall-clock abort. The positive write-swarm captured a 278-byte patch while the test's real checkout stayed unchanged.

Controls and smoke ran sequentially with an explicitly authorized temporary copy of subscription authentication. Isolated homes were cleaned up. No installed host or operator binary was updated. Positive goal-status tests remove copied old managed hooks only inside their disposable homes so that they exercise this checkout's policy; other smoke cases retain coexisting copied hooks.

## Pursue allowlist correction and activation limit

Pursue previously reused rescue's policy without permission to finish its goal through UpdateGoal. This is shared plugin behavior, not a Claude-only or upstream defect. The child now receives trusted operation metadata from its execution plan, replacing inherited values. Only rescue-labeled pursue with a trusted workspace root permits exact `GetGoal {}` and `UpdateGoal {status:"complete"|"blocked"}`. Goal creation, reactivation, budget changes and extra fields remain denied. Workspace restrictions and hard wall-clock budgets are unchanged; `--turns` remains a soft instruction and no longer asks for the denied SetGoalBudget tool.

The terminal operations were also traced across all 67 available legacy release tags from 0.8.0 through 0.41.0 and the previously certified native versions. They only inspect or settle the current goal.

Kimi runs all matching hooks, and any denial wins. An older Claude or Codex hook can therefore still veto these goal tools. Each installation must be updated separately with authorization. A setup re-pin repairs a versioned path; it does not add permissions to old code. No hook should be skipped or removed to activate the change.

## Upstream failure-exit nuance

A deterministic probe using exact tagged functions and mocked services/events covered 16 scenarios. In 2.0.1, a failed or hook-blocked continuation that is already running when the background policy starts may produce process exit 1 rather than the older paused/blocked 6/3. Normal successful UpdateGoal transitions remain 0/3. The plugin correctly keeps exit 1 as failure: `goal.summary` is emitted in `finally` and can report complete even when a later execution error occurs. This is a source-grounded scheduling test, not a reproduction of actual engine scheduling.

Local audit artifacts are in `.claude/kimi-code-research/reports/2026-09-19-201-*`; they contain no retained credentials. The repository check passed after the production matrix and release metadata were updated; the candidate smoke ran before adding the production certification row.
