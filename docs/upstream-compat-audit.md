# Upstream compatibility audit playbook

How to verify a new kimi-code release against kimi-plugin-cc without breaking the safety guarantees we ship.

This document captures the routine that ran on 2026-05-27 for `@moonshot-ai/kimi-code@0.4.0` (reports 31-35 in `.claude/kimi-code-research/reports/`, commit `b67263c`, tag `compat-verified-kimi-code-0.4.0`). Repeat it whenever a new kimi-code minor or major lands. The most recent minor worked example is the 2026-09-06 0.41.0 certification (reports 121-125: hook, stream/bootstrap, CLI, adversarial, synthesis; same-day monitor smoke reused for a boundary-only release); the 2026-08-29 exact-0.39.1 patch check is the most recent patch-checkup example.

## Current certified boundary (2026-09-09)

The plugin certifies **native agent-core-v2 at exact `@moonshot-ai/kimi-code@0.42.0`**
(release commit `6954d2c8bf94a5c7fc29cc6ae35b15d042cc4dcb`) for all eight
operations, and legacy-v1 through 0.41.x for an explicitly pinned binary.
0.42.0 removed `packages/agent-core` and `KIMI_CODE_LEGACY_FLAG` (#3542; not in
its changelog): `kimi -p` is v2 unconditionally, so the v1 pin is inert there.

The certification basis is the **no-plan construction** (see
[`native-v2-certification-provenance.md` §2](native-v2-certification-provenance.md#2-native-v2-entry-gate)),
not an upstream ordering guarantee — plan still registers before external
hooks at 0.42.0 (confirmed in `dist/main.mjs`). Certification is per EXACT
version and per operation; a patch release is NOT certified until the three
gates below pass and its version is appended to `NATIVE_V2_CERTIFIED`.

**Re-verify each release (all three, in this order):**

1. **Mechanized tag scan.** Clone the exact tag and run
   `KIMI_CODE_SOURCE_TAG_DIR=<clone> bun test tests/audit/v2-tag-scan.test.ts`.
   It fails on a missing per-version hash row — read the diff of
   `beforeToolExecuteEvent.ts` and `planService.ts`, then add the row. Any
   other red (a second `.allow()`, a new before-execute subscriber, a new
   `enter()` caller, a changed config section, a new executor entry point,
   changed tool field names) is a human re-audit, not a pin update. The scan
   cannot see semantic regressions: also read every NEW subscriber's
   statements, check for tools with side effects in `resolveExecution`, and
   grep `os/backends/` for a non-local runtime selector.
2. **Live control on the exact binary** (`repro-0391/repro.ts` style, isolated
   seeded home, deny-all hook): with `default_plan_mode = true` the plan-file
   `Write` must STILL bypass the hook (if it stops bypassing, upstream may have
   shipped the ordering fix — re-read #3431 and re-decide the basis); with plan
   mode off, an ordinary `Write` and an `EnterPlanMode` attempt must both reach
   the hook and be denied. Count payloads for the specific tool, not all calls.
3. **Real-binary smoke** (Phase 1b) with the v2 lanes green for every operation.

Do not extend `KIMI_TESTED_MINORS` (legacy table) past 0.41. Do not write a
"plan-file write denied under plan mode" smoke — under the construction that
path is never armed and a green result is the vacuous-precondition failure.

## When to run

- A new `@moonshot-ai/kimi-code` minor (e.g., 0.5.0) or major (1.0.0) ships
- An adversarial finding in a different audit suggests a contract we depend on may have moved
- The `/kimi:setup` version probe starts firing "outside tested range" warnings for a version users are actually running
- Quarterly even if none of the above triggered, just to catch silent drift

> **kimi-code self-upgrades by default since 0.8.0** (PR #334, `autoInstall: true`). The installed binary is now *fluid* — a user's interactive TUI can silently move ahead of the verified range out-of-band (the plugin's own `-p` spawns never swap the binary, but they then run against whatever the TUI upgraded to). Expect this trigger to fire more often than the old "user manually updated" cadence. Don't assume `kimi --version` today is the same as last week. (Worked example of a 3-minor catch-up: the 2026-06-03 0.7→0.9 audit, reports 52-60.)

### Daily monitor reports

A Codex daily cron monitors `@moonshot-ai/kimi-code` upstream drift for this
repo and writes local continuity reports under
`.claude/kimi-code-research/daily-monitor/`. The whole `.claude/` tree is
gitignored, so these reports are not release artifacts and should not be staged.

Before starting a new upstream audit or release catch-up:

1. Read `.claude/kimi-code-research/daily-monitor/LATEST.md` if present.
2. Read the most recent 3-5 dated reports matching
   `.claude/kimi-code-research/daily-monitor/YYYY-MM-DD-*.md`.
3. Carry forward unresolved blockers, follow-up checks, and prior uncertainty.
4. If today's evidence contradicts an earlier monitor judgement, state the
   correction explicitly in the new report or release handoff.

Monitor statuses are operational signals, not certifications:

- `NO ACTION` means latest is already inside the tested minor and no action is
  currently warranted.
- `PATCH CHECKUP` means a newer patch landed inside an already-tested minor; use
  the scoped diffs to decide whether a smoke or docs-only marker is worthwhile.
- `CERTIFICATION NEEDED` means upstream crossed into an untested minor/major;
  run this playbook before touching `KIMI_TESTED_MINORS`.
- `BLOCKER` means operator state, dirty repo state, missing tags/binary, or a
  possible safety break prevented a clean judgement.

Do not extend `KIMI_TESTED_MINORS`, tag, or release from a monitor report alone.
The release-quality gate remains: scoped source audit, real-binary smoke against
the exact target release, post-edit review, `bun run check`, and clean diff
checks.

**Skip** for patch releases unless the changelog explicitly touches (paths under `packages/agent-core-v2/src` unless noted):
- `apps/kimi-code/src/cli/run-prompt.ts`, `cli/v2/`, `prompt-render.ts`, `goal-prompt.ts` (print-mode bootstrap, stream-json output, `system.version` marker, goal summary, session pinning)
- `features/externalHooks/` (the hook engine: config schema, runner, matcher, aggregation)
- `agent/toolExecutor/` or `agent/permissionGate/` (the before-execute channel and the auto-approve gate — the sole `.allow()` invariant)
- `features/plan/`, `state/`, `workspace/sessionLifecycle/` (plan-mode arming vectors and the restore-folding source the journal taint scan depends on)
- `apps/kimi-code/src/cli/commands.ts` / `options.ts` (argv surface)

**Never skip** the mechanized gate: even a patch release is uncertified until `tests/audit/v2-tag-scan.test.ts` passes against its tree and its exact version is appended to `NATIVE_V2_CERTIFIED` (see "Current certified boundary" above).

### Forward-scan mode (no release, but `origin/main` moved)

When the routine fires but **nothing new has shipped** — npm `latest`, GitHub `Latest`, and the local binary are all still the version we already verified — do **not** run the full Phase 1 four-agent audit, extend `KIMI_TESTED_MINORS`, or cut a tag. There's no release to certify. Instead run the *forward-scan*: a free look at what the next release will contain.

1. Generate the four scoped diffs exactly as in Phase 0, but with `NEW='origin/main'` (after `git fetch`) and `PREV` = the last verified tag's referent.
2. Read them yourself in the main thread (no agent dispatch). The same 0-byte signal applies: **0-byte `02-permission.diff` + 0-byte `03-hooks.diff` means the two surfaces the safety model rests on are untouched** — that alone covers most of the risk.
3. Triage the non-empty diffs against the surface table below. Anything internal-only (record types not emitted to `-p` stdout, provider/model plumbing, internal abort-reason propagation) is benign for us; flag only changes to the stream-json **output shape**, argv, or the deny chain.
4. Log a one-bullet entry in `ROADMAP-TO-GA.md`'s Post-GA audit log dated and explicitly marked **"forward-scan, not a triggered audit"**, with the scanned `main` SHA, the per-surface result, a provisional verdict, and the specific items to re-confirm with `bun run smoke:real` when the release actually lands.
5. **No commit beyond the log bullet, no tag, no version bump** — the scanned code is unreleased and will change before shipping. (The 2026-06-01 entry is the worked example.)

The forward-scan is the lightweight discharge of the "quarterly drift" trigger above: it catches a contract moving *before* the release forces a turnaround, without spending the full ceremony on code that isn't final.

## What we depend on (the surfaces to audit)

These are the kimi-code surfaces kimi-plugin-cc consumes. If any one breaks, our safety guarantees break.

| Surface | Where in kimi-code (0.42.0, all paths under `packages/agent-core-v2/src` unless noted) | What we depend on | Where in kimi-plugin-cc |
|---|---|---|---|
| `kimi -p` print mode + permission mode | `apps/kimi-code/src/cli/v2/run-v2-print.ts` (entry via `apps/kimi-code/src/cli/run-prompt.ts` → `runV2Print`), `apps/kimi-code/src/cli/options.ts` | v2-only since 0.42.0 (the v1 engine and `KIMI_CODE_LEGACY_FLAG` are gone — the tag scan asserts the selector is absent). `auto` permission mode forced fresh and resumed, `nonInteractive:true`; `--auto/--yolo/--plan` rejected with `-p`; `-r` refuses when the session's recorded cwd ≠ current cwd (`:426`). **Load-bearing audit lesson from 0.33.0:** the selector file changed semantics while `run-prompt.ts` changed only comments — never omit the print-mode entry from the CLI diff. | `runtime/kimi-engine.ts::selectIntendedEngine` (exact-version `NATIVE_V2_CERTIFIED`), `runtime/cli-client.ts` invokes `-p` and requires the `system.version` marker first; safety relies on the hook firing under the no-plan construction |
| Before-execute channel (the ONE place every tool call is gated) | `agent/toolExecutor/beforeToolExecuteEvent.ts`, `agent/toolExecutor/toolExecutorService.ts` (`prepareToolCall` → `fireBeforeExecute`) | listeners run sequentially in registration order; `veto` wins; `pass` is non-terminal; `event.allow()` is chain-breaking. **Invariant:** the sole `.allow()` in the engine + CLI is the plan-file guard (`features/plan/planService.ts`), gated on ACTIVE plan mode, and the subscriber set is exactly permissionGate, toolDedupe, btw, externalHooks, goal, plan, swarm, tower | `tests/audit/v2-tag-scan.test.ts` (allow count, subscriber set, sha256 pins); the no-plan construction in `runtime/native-v2-preflight.ts` + `runtime/hooks/approval-policy.ts` |
| Plan mode arming vectors | `features/plan/planService.ts`, `features/plan/planOps.ts` (durable `plan_mode.enter|cancel|exit`, `plan.revision`), `features/plan/configSection.ts` (`default_plan_mode`), `features/plan/tools/enter-plan-mode/enterPlanModeTool.ts`, `workspace/sessionLifecycle/sessionLifecycleService.ts` (reads the default once in `sessions.create()`), `state/eventDispatcherService.ts` + `state/state.ts` (`restore()` folds ONLY `agents/<id>/wire.jsonl`, by literal `record.type`; fork `snapshotExcluded`) | exactly three arming routes from `-p`: `default_plan_mode` (single user file, no env/argv/project overlay), the `EnterPlanMode` tool, and journal replay on resume. Anything that adds a fourth (a new plan event type, a second restore source, an env binding for the default, a plan field on agent profiles) breaks the construction | `inspectPlanModeConfig` (`CLI_V2_PLAN_MODE_CONFIGURED`), hook denial of `EnterPlanMode`/`ExitPlanMode`, `scanSessionJournalsForPlan` (`KIMI_SESSION_PLAN_TAINTED`) + proven-lineage resume; all pinned/asserted by the tag scan and proven live by smoke lanes 3/3b |
| PreToolUse hook engine | `features/externalHooks/configSection.ts` (strict `{event, matcher?, command, timeout?}`), `features/externalHooks/internal/runHook.ts`, `features/externalHooks/internal/matchHooks.ts`, `features/externalHooks/agent/agentExternalHooksService.ts` (eager, one per agent scope incl. swarm children) | stdin JSON `{hook_event_name, session_id, cwd (process cwd), client_type, session_title, tool_name, tool_input, tool_call_id}`; exit 2 = deny with stderr reason, exit 0 + JSON `permissionDecision:"deny"` = deny, anything else allow; fail-OPEN on spawn error/timeout/abort/bad JSON; 30 s default; empty matcher = all tools; throwing regex matches nothing | `runtime/hooks/approval-hook.ts`, `runtime/hooks/approval-policy.ts`, `runtime/commands/setup.ts` (strict schema validation of every configured hook) |
| Hook **aggregation** across multiple hooks (incl. plugin-contributed) | `features/externalHooks/internal/matchHooks.ts` (`Promise.all`, first block in match order), `features/externalHooks/app/externalHooksRunnerService.ts` (plugin hooks appended and deduped on `cwd\0command`) | **any-block-wins**: an allow never pre-empts a block, so a kimi-code plugin's hook can neither override nor disable ours | implicit — guarantees the managed PreToolUse deny is terminal under coexistence (Claude + Codex host blocks, upstream plugins) |
| Auto-approve policy vs. hook | `agent/permissionGate/permissionGateService.ts` (→ `AutoModeApprovePermissionPolicyService`) | the auto-mode approval uses non-terminal `pass()`, never `allow()`, so it cannot pre-empt the external-hooks listener that runs after it | implicit — the entire safety model assumes a hook veto beats auto-approve; the tag scan's allow-count invariant covers it |
| Plugin slash commands / command activation | `agent/pluginCommand/`, `agent/plugin/`, `app/plugin/` | activation stays RPC/host-initiated and absent from `-p`; `-p` intercepts exactly one prefix, `/goal` (`apps/kimi-code/src/cli/goal-prompt.ts:43`); a plugin command must never become a model-reachable tool or a permission bypass | read-only commands hard-prefix an instruction line so their prompt never starts with `/goal`; `runtime/commands/pursue.ts` is the only `/goal` producer |
| Tool input schemas the allowlist reads | `agent/tools/os/write/writeTool.ts`, `agent/tools/edit/editTool.ts` (`path`; Write also `mode`), `agent/tools/os/bash/bashTool.ts` (`command`, **`cwd`**, `timeout`, `run_in_background`; `effectiveCwd` asserts NO workspace membership, `:191`) | field names, and the fact that `Bash.cwd` is honoured without an upstream membership check while the hook payload's top-level `cwd` is the process cwd | `runtime/rescue-approval.ts` (`checkApprovedPath`, `checkApprovedDirectory` confines `tool_input.cwd` to the trusted root before the command string); tag scan asserts the field names |
| AgentSwarm / subagents | `features/swarm/tools/agent-swarm/agentSwarmTool.ts` (`'AgentSwarm'`, strict schema), `features/swarm/agent/swarmService.ts`; `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY` (unset = no cap) | children run in-process in a child DI scope sharing the session workspace with their OWN eager external-hooks service — every child tool call fires the hook; no deny-all path on the swarm route; `fork` gated by `subagent_fork` | `runtime/commands/swarm.ts` always exports the concurrency cap (4 read / 1 write); the `swarm`/`swarm-write` hook labels; worktree confinement via `KIMI_PLUGIN_CC_WORKSPACE_ROOT` |
| Experimental features | `apps/kimi-code/src/utils/experimental-features.ts` (`[experimental]` config table, per-flag `KIMI_CODE_EXPERIMENTAL_*` env, master `KIMI_CODE_EXPERIMENTAL_FLAG`; precedence env → config → master → default) | `tower` and `subagent_fork` are v2-only features outside the certified profile; the master flag enables all of them | `inspectExperimentalSelectors` (`CLI_V2_EXPERIMENTAL_UNSAFE`) + `assertNoUnsafeExperimentalSelector` (`CLI_V2_HOOK_ORDER_UNSAFE`) refuse before spawn |
| Stream-json output | `apps/kimi-code/src/cli/prompt-render.ts` (`system.version` FIRST line, `session.resume_hint`, `turn.step.retrying`), `apps/kimi-code/src/cli/goal-prompt.ts` (`goal.summary`) | NDJSON record shapes for assistant/tool/tool_result; `role:"meta", type:"system.version"` is the provenance marker a v2 plan requires first and must equal the probed version; `session.resume_hint` carries the `session_<uuid>` token that round-trips via `-r` | `runtime/stream-json.ts` parser; `runtime/cli-client.ts` provenance gate (`CLI_ENGINE_PROVENANCE_MISMATCH`) and session pinning |
| CLI argv | `apps/kimi-code/src/cli/options.ts` | `-p` (prompt as VALUE), `-r`/`-S`/`--session`, `--output-format stream-json`, `-m`, `--skills-dir` accepted with current semantics; `--agent`/`--agent-file`/`--add-dir` exist and are NEVER passed | `runtime/cli-client.ts::buildArgs`; `runtime/kimi-command.ts::assertPrefixArgsSafe` refuses reserved flags in the launcher prefix |
| Session store layout | `<KIMI_CODE_HOME>/sessions/<workspaceId>/<sessionId>/agents/<agentId>/wire.jsonl` (+ `state.json`, `logs/`) | the journal the preflight scans lives exactly there; a layout change fails closed as `KIMI_SESSION_JOURNAL_UNAVAILABLE` (every v2 resume would refuse) | `scanSessionJournalsForPlan`; smoke lane 3b asserts the real layout |
| Auto-update preflight | update check on the `-p` path | a background upgrade must never swap the certified binary under an execution plan | every spawn exports `KIMI_CODE_NO_AUTO_UPDATE=1` and an absolute `KIMI_CODE_HOME` (`runtime/cli-client.ts::buildEnv`) |
| Process / exit / lifecycle | `apps/kimi-code/src/cli/v2/run-v2-print.ts` and OS-level | stdout = stream-json only; stderr = humans-only; goal exits 0/3/6; SIGTERM lands; process group enumerable | `runtime/cli-client.ts` cancellation; `runtime/background-spawn.ts` |

## The routine

### Phase 0 — Setup (5 min)

The upstream clone lives at `.claude/kimi-code-research/kimi-code-repo/`. It's gitignored.

```bash
cd .claude/kimi-code-research/kimi-code-repo
git fetch --tags origin
git checkout '@moonshot-ai/kimi-code@<NEW_VERSION>'
git describe --tags --always  # confirm
```

Generate scoped diffs against the previous audited version (typically the last tag's referent — check `tags/compat-verified-kimi-code-*` to find it):

```bash
mkdir -p /tmp/kimi-<NEW>-diff
PREV='@moonshot-ai/kimi-code@<PREV_VERSION>'
NEW='@moonshot-ai/kimi-code@<NEW_VERSION>'

git diff "$PREV".."$NEW" -- \
  apps/kimi-code/src/cli/run-prompt.ts \
  apps/kimi-code/src/cli/v2/ \
  apps/kimi-code/src/cli/prompt-render.ts \
  apps/kimi-code/src/cli/goal-prompt.ts \
  apps/kimi-code/src/cli/options.ts \
  apps/kimi-code/src/cli/commands.ts \
  apps/kimi-code/src/utils/experimental-features.ts \
  apps/kimi-code/test/cli/ \
  > /tmp/kimi-<NEW>-diff/01-cli-print-mode.diff

# The before-execute channel is the ONE place every tool call is gated, and
# the permission gate is the auto-approve policy that must stay non-terminal
# (`pass()`, never `allow()`). Also scopes the permission mode/rules/approval
# services that decide what the gate does.
git diff "$PREV".."$NEW" -- \
  packages/agent-core-v2/src/agent/toolExecutor/ \
  packages/agent-core-v2/src/agent/permissionGate/ \
  packages/agent-core-v2/src/agent/permissionPolicy/ \
  packages/agent-core-v2/src/agent/permissionMode/ \
  packages/agent-core-v2/src/agent/permissionRules/ \
  packages/agent-core-v2/src/agent/toolApproval/ \
  > /tmp/kimi-<NEW>-diff/02-before-execute-and-gates.diff

git diff "$PREV".."$NEW" -- \
  packages/agent-core-v2/src/features/externalHooks/ \
  > /tmp/kimi-<NEW>-diff/03-hooks.diff

# Plan-mode arming vectors + the restore-folding source. A change here is a
# change to the no-plan construction itself: the plan guard's final allow, the
# durable plan event types (`planOps.ts` — the journal scan keys on their
# prefixes), `default_plan_mode` (`configSection.ts`, read once in
# `sessions.create()` in sessionLifecycle), and what `restore()` folds.
git diff "$PREV".."$NEW" -- \
  packages/agent-core-v2/src/features/plan/ \
  packages/agent-core-v2/src/state/ \
  packages/agent-core-v2/src/workspace/sessionLifecycle/ \
  > /tmp/kimi-<NEW>-diff/04-plan-and-restore.diff

# Session/feature BOOTSTRAP: feature registration order (`index.ts`), the
# config loader (`app/bootstrap/`, `app/config/`), and every feature's
# `configSection.ts`. A non-empty 05 means session construction or on-disk
# config-load behaviour moved — exactly the surface that decides what state a
# session starts with before any listener runs (the 0.19.1 lesson: an
# unconditional project-local config read was wired into BOTH create and
# resume bootstraps and only the adversarial pass caught it).
git diff "$PREV".."$NEW" -- \
  packages/agent-core-v2/src/index.ts \
  packages/agent-core-v2/src/app/bootstrap/ \
  packages/agent-core-v2/src/app/config/ \
  packages/agent-core-v2/src/workspace/ \
  ':(exclude)packages/agent-core-v2/src/workspace/sessionLifecycle' \
  ':(glob)packages/agent-core-v2/src/features/*/configSection.ts' \
  > /tmp/kimi-<NEW>-diff/05-session-bootstrap.diff

# The TOOL LAYER (input schemas whose field names the hook allowlist reads:
# Write/Edit `path`, Bash `command` + `cwd`), the fan-out / delegation
# features (swarm, goal, tower, btw, plugin commands, agent profiles) that
# spawn or steer additional tool callers, and the SDK/kaos packages under the
# -p path (a 0-byte agent-core-v2 diff does NOT cover them).
git diff "$PREV".."$NEW" -- \
  packages/agent-core-v2/src/agent/tools/ \
  packages/agent-core-v2/src/features/swarm/ \
  packages/agent-core-v2/src/features/goal/ \
  packages/agent-core-v2/src/features/tower/ \
  packages/agent-core-v2/src/features/btw/ \
  packages/agent-core-v2/src/agent/plugin/ \
  packages/agent-core-v2/src/agent/pluginCommand/ \
  packages/agent-core-v2/src/app/plugin/ \
  packages/agent-core-v2/src/app/agentProfileCatalog/ \
  packages/node-sdk/src \
  packages/kaos/src \
  > /tmp/kimi-<NEW>-diff/06-tools-fanout-sdk.diff
```

A 0-byte `03-hooks.diff` is the canonical "hook engine unchanged" signal, and a 0-byte `02` + `04` together mean the before-execute channel and the plan-mode arming vectors — the two surfaces the no-plan construction rests on — are untouched. The other diffs need real reading. `05` is the bootstrap/config surface: non-empty means session construction or on-disk config-load behaviour moved, which decides what state a session starts with before any listener runs — read it even when `01`–`04` are clean. `06` is the tool layer, the fan-out features and the SDK: read it for schema-field renames (the allowlist reads `path`/`command`/`cwd` by name), new tool callers that might not get an eager external-hooks service, and harness-level session/engine changes. Whatever the diffs say, the release is uncertified until the tag scan (`tests/audit/v2-tag-scan.test.ts`) is green against the tree with a fresh per-version hash row, the plan-mode-ON live control still shows the bypass, and the per-operation smoke (incl. lane 3b, native-v2 resume) passes.

### Phase 1 — Multi-agent compat review (4 parallel agents)

Dispatch four reviewers in parallel via the Agent tool with `run_in_background: true`. Each gets one surface and produces one report under `.claude/kimi-code-research/reports/NN-upstream-<scope>.md`.

Reviewer 1 — **PreToolUse hook contract** (`general-purpose` agent)
- Question: did the JSON-in / exit-code-out contract change? Did matcher semantics change? After any permission-system refactor, does our hook still fire first in `-p` mode?
- For v2, trace production service-registration order and every listener that can call final `event.allow()`. "External hooks are awaited before execution" is insufficient. Prove both fresh `default_plan_mode=true` and restored plan state cannot skip the managed hook; otherwise the fail-closed v2 refusal stays.
- Output: `reports/NN-upstream-<ver>-hook-contract.md`

Reviewer 2 — **Stream-json output** (`general-purpose` agent)
- Question: did NDJSON record shapes change? Is `session.resume_hint` still emitted with the same field name and position in stream? Any new top-level role or meta-type our parser would warn-on?
- Output: `reports/NN-upstream-<ver>-stream-json.md`

Reviewer 3 — **CLI surface** (`general-purpose` agent)
- Question: did our flags survive byte-identical? Any new flags affecting prompt mode? Is auto-approve still hard-coded?
- Output: `reports/NN-upstream-<ver>-cli-surface.md`

Reviewer 4 — **Adversarial** (`general-purpose` agent — the `kimi:kimi-challenge` subagent is risky for this because its foreground job can disappear)
- Brief: "Three other reviewers say COMPAT-PRESERVED. Attack the claim. Find the cases where it breaks. If you can't, earn the conclusion adversarially."
- Output: `reports/NN-upstream-<ver>-adversarial.md`

All four agents must save a structured report to disk and reply with a verdict + short summary. The full report is the deliverable; the chat reply is just a teaser.

Verdicts to use (consistent across reports):
- `COMPAT-PRESERVED` — no action needed
- `COMPAT-AT-RISK` — narrow specific concern flagged, may or may not require code
- `COMPAT-BROKEN` — actual breakage, runtime change required

### Phase 1b — Assertion check: real-binary smoke (10 min)

Source-reading proves the *contract* looks unchanged; the smoke proves it *behaves* unchanged. Run it against the actual new release:

```bash
# Install / activate the new kimi-code release so `kimi` on PATH is <NEW_VERSION>
kimi --version                  # confirm it reports <NEW_VERSION>
bun run smoke:real              # KIMI_PLUGIN_CC_SMOKE=1 bun test tests/runtime/real-binary-smoke.test.ts
```

It spawns the real `kimi -p` in an isolated `KIMI_CODE_HOME` (seeded from your authenticated home — never mutates the real config or session store) and asserts, for review / challenge / ask / review_gate, that a forced write attempt is denied by the hook and no file lands. A green run is direct evidence that the policy-queue-index-0 / hook-deny chain still holds end-to-end on the new release — the single highest-signal check in this whole routine. If it goes red, the source-reading verdict is *probably* wrong somewhere — but first rule out the operator-auth false alarm below; once that's excluded, treat as `COMPAT-BROKEN` until reconciled.

Prereqs: a kimi binary + an authenticated `~/.kimi-code` (config + `credentials/` + `oauth/`). Skipped automatically without them, so note in the synthesis whether the smoke actually ran or was skipped — a skipped smoke is not a passed smoke.

**Smoking a release without touching the operator's install (the temp-binary technique).** `kimi upgrade` is unreliable on some installs (e.g., the 2026-06-03 run reported a bogus "native (windows)" source on macOS and refused to update, leaving the binary at 0.8.0 while certifying through 0.9.0). The smoke resolves its binary from `KIMI_PLUGIN_CC_KIMI_BIN` (falling back to `kimi` on PATH — see `runtime/kimi-command.ts::resolveKimiCliCommand`), so you can certify the exact target release without mutating `~/.kimi-code/bin`:

```bash
D=/tmp/kimi-<NEW>; rm -rf "$D"; mkdir -p "$D"; cd "$D"
echo '{"name":"smoke","private":true}' > package.json
bun add @moonshot-ai/kimi-code@<NEW>
"$D/node_modules/.bin/kimi" --version    # confirm <NEW>
cd -  # back to the plugin repo
KIMI_PLUGIN_CC_SMOKE=1 \
  KIMI_PLUGIN_CC_KIMI_BIN="$D/node_modules/.bin/kimi" \
  bun test tests/runtime/real-binary-smoke.test.ts
```

Auth still seeds from the real `~/.kimi-code` (`KIMI_PLUGIN_CC_SMOKE_HOME`) into an isolated `KIMI_CODE_HOME`, so a previously-green smoke proves the token is valid. This is how the 0.9.0 cert earned "tested end-to-end" without altering the operator's 0.8.0 install.

**Current v2 rule (v1.10.0).** The smoke is engine-aware: for a binary whose
exact version is in `NATIVE_V2_CERTIFIED` it asserts the `system.version`
marker is the FIRST stream-json line and equals the probed version, then runs
every operation lane under the v2 plan; for a pinned ≤ 0.41 binary it runs the
legacy lanes and asserts the marker is absent. Truthy `KIMI_CODE_EXPERIMENTAL_FLAG`
and `[experimental] tower`/`subagent_fork` must still fail before spawn; a
`default_plan_mode = true` home must fail before spawn with
`CLI_V2_PLAN_MODE_CONFIGURED` and the test must assert the input was effective
and no process was created; a seeded `plan_mode.enter` journal must make
resume refuse with `KIMI_SESSION_PLAN_TAINTED`. An `EnterPlanMode` attempt
must reach the hook and be denied. Write lanes additionally assert an
out-of-root `Bash.cwd` is denied while an in-root one runs.

**Operator-auth false alarm (seen on the 2026-05-31 0.6.0 run).** The skip-gate only checks that `config.toml` + `credentials/` *exist*, not that the token inside is *still valid*. An expired OAuth token sails past the gate, so the smoke **runs** (not skipped) and goes **red** with every label failing at `auth.login_required: OAuth provider "managed:kimi-code" requires login` — `records` is `[]` and the deny marker never appears because kimi dies before any tool call. This looks alarmingly like a hard break but is pure machine state: re-login (`kimi` interactive auth) and re-run. Distinguish it from a real break by the error string — a true compat break would show the model *attempting* a write and the hook *not* denying, not an auth abort with empty records. Don't pin `COMPAT-BROKEN` on an `auth.login_required` red. Related gotcha: don't pipe the smoke through `... | tail -N` and trust the reported exit code — the pipe's status is `tail`'s, not bun's, so a red suite can look like exit 0. Read the body, or run `bun run smoke:real; echo $?` unpiped.

### Phase 2 — Synthesis (15 min, main thread)

Read all four reports. Write a synthesis to `reports/NN-upstream-<ver>-synthesis.md`. Decide one of three outcomes:

| Findings | Outcome | Commit shape |
|---|---|---|
| Nothing load-bearing | Docs-only update + lightweight compat-marker tag | `docs: verify kimi-code <ver> compat — no runtime changes required` |
| Minor adjustments (e.g., extend `KIMI_TESTED_MINORS`, tighten a comment) | Patch release | Bump 5 version files, tag `vX.Y.Z`, gh release |
| Real breakage | Real fix + minor release by default | Bump 5 version files to the next minor, tag, gh release |

"Load-bearing" means runtime code changes. Doc tightening alone is not load-bearing.

Narrow exception: a patch release may fail closed on an explicitly opt-in experimental engine when the stable/default engine remains compatible, the refusal happens before spawn, and it cannot be bypassed by the hook-check diagnostic escape hatch. This exception does not certify the refused engine; re-enabling it still requires a released upstream fix plus the full exact-binary gate.

### Phase 3 — Edits (variable)

Surgical only. Common doc edits even when no code changes:
- `AGENTS.md`: extend the "Upstream compat" line with the verified version
- `AGENTS.md`: update the dual-source session-meta paragraph's verified-through range
- `runtime/stream-json.ts`: update the source-of-truth comment's verified-through range
- `ROADMAP-TO-GA.md`: append an audit log entry with date, verdict, and findings

If extending `KIMI_TESTED_MINORS` (`runtime/kimi-version-probe.ts`), that's a runtime change — bump to patch release. The "untested minor" test fixtures (`tests/runtime/kimi-engine.test.ts` `NEXT_UNTESTED_VERSION`, `tests/runtime/kimi-version-probe.test.ts`) derive from `maxTestedMinor()` since 2026-09-02, so the boundary move needs no test edit — but the `isInTestedRange` "known minor" list in the probe test still enumerates each certified minor and should gain a line. Probe-list comments compile into `dist/`, so batch every wording fix before the final `bun run build && bun run generate:surfaces`; each reviewer round otherwise costs a full gate re-run. On a monitor `BLOCKER` that cites `auth.login_required`, probe auth first: copy `config.toml` + `credentials/` + `oauth/` + `device_id` into a temp `KIMI_CODE_HOME` (never print them) and run `kimi -p 'Reply with exactly: OK' --output-format stream-json` — 20 seconds decides whether anything else is wrong.

### Phase 4 — Multi-reviewer pass on the audit commit

The audit reports reviewed kimi-code. The reviewers in this phase review **your edits** to confirm they accurately reflect the audit.

Dispatch two reviewers in parallel:

1. **code-reviewer** agent on the working-tree diff — checks for correctness, cross-references the report citations, flags overclaims or wrong file paths
2. **general-purpose** agent doing "doc fidelity" — verifies every factual claim in the docs is supported by a specific report; checks numerical claims; flags marketing language

Apply must-fix findings before commit. Nits are at your discretion.

> Why not use `code-reviewer` for both: independence. The fidelity audit specifically grades the writing against the source reports, which is a different question than the code-reviewer's "is this commit correct."

### Phase 5 — Commit, tag, push

**Docs-only outcome** (most common — no breakage):
```bash
git add AGENTS.md ROADMAP-TO-GA.md runtime/stream-json.ts dist/stream-json.js
git commit -m "docs: verify kimi-code <ver> compat — no runtime changes required" \
  -m "<audit summary>"
git push origin main
git tag -a "compat-verified-kimi-code-<ver>" -m "<audit verdict + reports>"
git push origin "compat-verified-kimi-code-<ver>"
```

**Patch release outcome** (something load-bearing):
```bash
# Bump runtime/version.ts, package.json, .claude-plugin/plugin.json,
#                 .claude-plugin/marketplace.json, AGENTS.md
bun run check       # must be green
git add -A
git commit -m "release: <new-version> — kimi-code <ver> compat"
git tag -a "v<new-version>" -m "..."
git push origin main "v<new-version>"
gh release create "v<new-version>" --notes-file <(echo "<audit body>")
```

The compat-marker tag (`compat-verified-kimi-code-<ver>`) is independent of the plugin version tag (`v<X.Y.Z>`). Both can coexist.

## Anti-patterns

- **Don't use the `kimi:kimi-challenge` subagent for the adversarial pass**. It invokes `kimi -p` under the hood; its foreground job can disappear (`FOREGROUND_PROCESS_DISAPPEARED`) leaving the wrapper agent unsure whether the work completed. Use `general-purpose` with an adversarial brief instead.
- **Don't extend `KIMI_TESTED_MINORS` on source-reading alone — run the Phase 1b smoke against the new release first.** The probe is the user's only signal that we tested against their version. The local real-binary smoke (`bun run smoke:real`) now exists (H7 partial), so "tested" should mean "smoke ran green against this release", not just "four agents read the diff". Until the smoke runs in per-push CI against a pinned release (H7 remaining — blocked on an OAuth-credentials secret), it stays a manual pre-release gate; record in the synthesis whether it ran or was skipped.
- **A headless/cloud-prepared catch-up DEFERS its smoke — treat the PR as smoke-pending until you run it locally against that branch.** A catch-up prepared in a cloud/CI session with no kimi binary cannot run Phase 1b (`PREREQS_OK` is false; the suite skips — installing the binary doesn't help, the smoke needs valid Moonshot OAuth creds). Before merging such a PR, run `bun run smoke:real` **locally against the actual PR branch**, then flip the "smoke pending" docs (`CHANGELOG`, `kimi-version-probe.ts` comment, `ROADMAP`) to GREEN so the tagged commit is accurate. Do **not** substitute the daily-checkup routine's `report-NN` green smoke for this if the PR added code the report's smoke didn't cover: the 2026-06-19 v1.2.6 PR bundled the `/kimi:swarm --cap` env-wiring feature, but report 81's green smoke *predated* that code (report 81 had explicitly said the feature should NOT be bundled), so it certified only the pre-feature tree. Re-running locally against the branch is what actually closed the gate. (Same run: watch for the cwd-persisted-into-the-clone trap — `bun run check` piped through `tail` reported exit 0 while actually failing "Script not found check" because a prior `cd` had left the shell in `.claude/kimi-code-research/kimi-code-repo`; run gates unpiped from the plugin root.)
- **Don't tag a plugin version (`vX.Y.Z`) for zero-code-change audits.** Reserve patch and minor releases for actual changes. Use the compat-marker tag for verification-only events.
- **Don't skip the multi-reviewer pass on the audit commit.** The 2026-05-27 run caught a `~/.kimi/plugins/installed.json` path error (correct path: `~/.kimi-code/plugins/installed.json`) propagated from the source audit reports into the roadmap — exactly the kind of detail one reader misses.
- **Don't conclude `additionalDirs`/session config is empty by reading `run-prompt.ts` alone — the harness impl (v1: `rpc/core-impl.ts`; v2: `app/bootstrap/` + `workspace/sessionLifecycle/`) can auto-load project-local config at bootstrap.** `run-prompt.ts` only delegates to `createKimiHarness().createSession/resumeSession`; the real bootstrap (`createSessionWithOverrides`/`resumeSessionWithOverrides`) lives in `packages/agent-core/src/rpc/core-impl.ts` and is where on-disk config is merged into the permission context. In the 2026-06-23 0.19.1 audit, #812 (commit `c0eeca2`) made both the `-p` create and resume paths unconditionally read `.kimi-code/local.toml` `[workspace] additional_dir` into `additionalDirs` — so reading run-prompt.ts made it look `--add-dir`-only, and only the Phase-4 adversarial reviewer caught it. Always read `05-session-bootstrap.diff`; if a claim depends on a session field being empty/default on the `-p` path, trace it through `core-impl.ts`, not just the CLI entrypoint. (The safety conclusion held — the index-0 hook + single-root `rescue-approval.ts` bind before the only `additionalDirs` consumer, `GitCwdWriteApprovePermissionPolicy` at index 17, which is dead below auto-approve on `-p` — but the audit *reasoning* was wrong. See report 85's CORRECTION box.)

## Reference: the 2026-05-27 0.4.0 audit

For a worked example see:
- Commit: `b67263c` (`git show b67263c`)
- Tag: `compat-verified-kimi-code-0.4.0` (`git show compat-verified-kimi-code-0.4.0`)
- Reports (gitignored): `.claude/kimi-code-research/reports/31-upstream-04-hook-contract.md` ... `35-upstream-04-synthesis.md`
- Roadmap audit log: `ROADMAP-TO-GA.md` § "Post-GA audit log"
