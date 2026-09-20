# Kimi Code 2.0.2 certification — 2026-09-20

Build correction: v2.0.4's post-push CI failed because local validation used
stale compiler dependencies. Plugin 2.0.5 fixes the emitted SQLite constructor
expression and adds Node/Bun compiled-runtime tests. The exact CLI safety
evidence below remains unchanged. See [build-fix evidence](release-2.0.5-build-fix.md).

Plugin 2.0.4 certifies exact Kimi Code 2.0.2 for all eight native-v2
operations under the unchanged no-plan construction. The user authorized
publication after the source and live gates passed. Installed-host updates
and an operator CLI upgrade are not part of this release.

## Exact source and certification changes

The certified source is `@moonshot-ai/kimi-code@2.0.2`, immutable commit
`9d07f634be94ebeb1deba2f55d247807cf729315`, compared with certified 2.0.1
at `caf7d4e2fef06967280b325da06e44a4b0516eba`.

The CLI, before-execute gates, external hooks, plan/restore, and
bootstrap/config playbook scopes are unchanged. The tool/fan-out scope
changes only system-prompt prose: cwd is no longer called the project root.
The plugin's trusted-root checks, rather than that prose, enforce writes.

Supplemental source review covers the changed loop and compaction files
outside those scopes. `engineJournal()` adds a synthetic in-memory
`turn.ended` seed to the human-event journal when resuming; this is not a
plan event or a new source for restoring plan state. Turn indices are
monotonic, duplicate steer materialization is suppressed, and compaction
pre-shrinks model context to the effective window budget. None of those
changes replaces the tool-execution hook or the raw plan-taint journal scan.
The exact live resume and goal lanes passed after this source review.

The hook schema and event names are byte-identical to 2.0.1. The candidate
accepts only exact 2.0.2 with matching major/minor/patch fields for the
existing version-sensitive events. Unknown patches, prereleases, build
suffixes, mismatched components, and malformed entries remain refused.
Schema acceptance is not permission to execute an uncertified binary.

The source scan has an explicit 2.0.2 hash row. The production certification
row was added only after the exact-binary controls and every smoke lane passed.

## Verification

- Exact 2.0.2 source tag scan: 15 passed, 89 assertions.
- Pre-certification schema/engine regressions: 82 passed, 336 assertions.
  Those tests checked refusal before the production row was added. Release
  regressions now check certified routing for all eight operations and refuse
  2.0.3, 2.1.0, prereleases and build suffixes.
- Exact 2.0.2 binary version probe with a synthetic hook configuration:
  validation passes for PermissionRequest, PermissionResult and Interrupt;
  no personal configuration, credentials, or model calls used.
- Pre-certification `bun run check`: 898 passed, 28 opt-in skips, zero failures, 2,986
  assertions; build, types, generated surfaces and drift gate passed.
- Plan-ON control: exact 2.0.2 denied Glob through the hook, then wrote a
  687-byte plan without invoking that hook for Write. The known bypass
  persists, confirming that the no-plan construction remains necessary.
- Plan-OFF controls: separate Write and EnterPlanMode prompts both reached
  the deny hook. Both exited 0; no target file or plan file appeared. All
  three controls emitted exact 2.0.2 as the first stream-json record.
- Full candidate smoke after the schema change: exit 0, 15 passed, zero
  failures or skips, 84 assertions, 432.64 seconds. Resume and tainted-journal
  refusal passed. The nine-turn goal run created no target files and surfaced
  the hook-denial marker; it ended at the expected budget abort. This does
  not count independent denials on every turn. Both pursue
  terminal paths passed. Write-swarm captured a 278-byte patch, preserved
  the test's real checkout, cleaned its worktree, and denied an escape write.
  This supersedes the earlier monitor's pre-model schema refusal.
- Production matrix includes exact 2.0.2; plugin metadata is 2.0.4.
  Installed hosts and the operator binary remain unchanged.

Final release checks: focused schema/engine tests passed 82/82 with 337
assertions. `bun run check` passed with 898 tests, 28 opt-in skips, zero
failures and 2,987 assertions, including build, types, surfaces and drift.
The opt-in tag scan and live tests were run separately, as reported above.
Both independent final reviews found no must-fix issues.

The original checkout's final full check hit four five-second fixture-copy
timeouts. A separate recursive copy also stalled; a process sample showed
`clonefileat` waiting before any installed runtime executed. A clean `/tmp`
worktree with the identical staged tree (`e932a0b3fe66a8b604aabc66c1993ce783b22683`)
passed the complete check using the same dependencies and unchanged default
test limits. Those four tests took 213 to 1,325 milliseconds there. This
points to a checkout-specific filesystem issue, not a proven root cause in
macOS. Only this result documentation changed after that successful check.

The user explicitly authorized temporary subscription-authentication copies
for this batch under [CI guidance](ci.md). Controls and smoke ran sequentially,
once each, with no automatic retry. The three control homes were deleted;
the smoke harness cleaned its homes. A final directory check found no
remaining smoke homes. No raw config or credentials were printed or retained
in the reports. The operator home and installed binary were not changed.

Live logs are `2026-09-20-202-plan-on.log`, `2026-09-20-202-plan-off.log`,
and `2026-09-20-202-smoke.log` under the local reports directory. Publication
was authorized separately after this evidence passed. Host installation and
hook re-pinning remain separate decisions.

Local independent source reviews and synthesis are retained under
`.claude/kimi-code-research/reports/2026-09-20-202-*`. These are source-review
evidence. The live results above supplement those source-only reviews; they
do not establish exhaustive compaction or interrupted-resume behavior.
