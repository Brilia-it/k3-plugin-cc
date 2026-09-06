# Native v2 status — 2026-09-06

Native v2 remains disabled for every plugin operation. Certifying kimi-code
0.41.0 on legacy-v1 does not enable v2, tower, or subagent fork. The
[approved entry gate](native-v2-certification-provenance.md#2-non-negotiable-native-v2-entry-gate)
is unchanged.

## Released evidence: 0.41.0

The exact release commit is `95478e8c7ba248fd2470d5bb151555ec7fedd19d`.
The [feature assembly](https://github.com/MoonshotAI/kimi-code/blob/95478e8c7ba248fd2470d5bb151555ec7fedd19d/packages/agent-core-v2/src/index.ts#L329)
still imports plan before external hooks (lines 329 and 341). The plan guard's
sole production [`event.allow()`](https://github.com/MoonshotAI/kimi-code/blob/95478e8c7ba248fd2470d5bb151555ec7fedd19d/packages/agent-core-v2/src/features/plan/planService.ts#L110)
still ends the listener iteration before the external hook can veto.

The September 6 monitor's exact-binary reproduction exercised a fresh
`default_plan_mode=true` session: the deny-all hook blocked `Glob`, then the
plan-file `Write` created 658 bytes without invoking that hook. The separate
legacy-v1 control invoked the hook for both calls and created no plan file.
This is fresh-session bypass evidence, not a new restored-v2-plan smoke result.
The bypassed write is the exact plan file under `KIMI_CODE_HOME`, not an
arbitrary user-worktree write.

Changes that matter to future certification:

- [#3517](https://github.com/MoonshotAI/kimi-code/pull/3517) removes
  `staleGuard`. The instrumented 0.39.1 listener list is historical; the current
  source no longer contains that listener. Plan still precedes external hooks.
- [#3481](https://github.com/MoonshotAI/kimi-code/pull/3481) deletes the package
  docs, including `agent-core-v2/docs/Permission.md`. Its earlier discussion of
  plan-file exemptions and undecided listener ordering is historical evidence,
  not a document present in 0.41.0. Deletion does not establish a new contract.
- [#3529](https://github.com/MoonshotAI/kimi-code/pull/3529) skips the dangerous
  and unanalyzable Bash command policy in auto mode. V2 print uses auto mode;
  this policy cannot substitute for the external hook. The nonInteractive
  exclusion already existed in 0.40.0, so this is not a newly lost print-mode
  protection.
- The earlier [#3444](https://github.com/MoonshotAI/kimi-code/pull/3444) Bash
  `cwd` behavior remains: `resolve()` maps paths without asserting workspace
  membership. This is intended upstream behavior and a future confinement
  audit requirement, not a second issue we are filing.
- [#3531](https://github.com/MoonshotAI/kimi-code/pull/3531) adds v2 print
  shutdown quiescence and wire-journal flushing. Recheck exit/cancellation and
  tail-record durability when certifying v2; this does not change hook order.
- The release also adds context-budget reminders, always-on turn-level file
  history, and web tower support. None supplies external-hook precedence.

## Unreleased watchlist

Checked `main` at `af81bb92215dca2f933579ce0119f7add452bc96` on September 6.
Post-release changes preserve media attachment names ([#3548](https://github.com/MoonshotAI/kimi-code/pull/3548)),
align the visualizer with v2, and fix web UI auto-opening. The ordering mechanism
is unchanged. This source scan is not binary certification of `main`.

Two open proposals deserve review if merged:

- [#3552](https://github.com/MoonshotAI/kimi-code/pull/3552): graduate Remote
  Control, session indexing, and search from experimental flags; introduces
  `[database]` switches and renames environment variables. Recheck defaults,
  config precedence, and background side effects on the exact released tag.
- [#3537](https://github.com/MoonshotAI/kimi-code/pull/3537): anchor compaction
  continuation on the latest user message. Relevant to future long-running v2
  operations, but not an ordering fix or a complete compaction-safety solution.

## Upstream follow-up

[#3431](https://github.com/MoonshotAI/kimi-code/issues/3431) is open, with only
our September 2 comment and no maintainer response or `/approve` as of this
check. Keep it as the single issue. On September 8, recheck it and, if still
unanswered, post the concise 0.41.0 reproduction update prepared locally.
The reference fix remains held for approval; rebase and rerun its gates before
offering any current-main validation claim. No duplicate issue or unapproved
reference-fix PR is part of this release.

After a released ordering guarantee, certification still requires both fresh
default-plan and restored-plan lifecycle proofs, then the per-operation source,
smoke, resume, and full repository gates. The plugin-side reachability bridge
remains unadopted; possible v1 retirement does not waive the approved gate.

Local evidence: `.claude/kimi-code-research/daily-monitor/2026-09-06-upstream-monitor.md`
and certification reports 121–125 under `.claude/kimi-code-research/reports/`.
