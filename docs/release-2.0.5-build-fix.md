# Plugin 2.0.5 build correction

Plugin 2.0.5 fixes lockfile-clean builds without expanding CLI certification
or changing managed-session policy. Exact Kimi Code support remains through
2.0.2. v2.0.4 remains immutable; no installed hosts are updated by publication.

## Cause and correction

The v2.0.4 local checks used TypeScript 6.0.2, @types/node 25.6.0 and
@types/bun 1.3.12 from a stale dependency directory. The lockfile and CI used
7.0.2, 26.5.1 and 1.4.2 respectively. Reusing that directory in a temporary
worktree did not make the build lockfile-clean.

TypeScript 7.0.2 emitted the typed SQLite constructor expression as
`new require(...).Database(...)` (also `DatabaseSync`). This changes the
JavaScript `new` binding. The regenerated output failed under both Node and
Bun; CI first detected the root/Codex mirror mismatch. The tagged v2.0.4
prebuilt files retained the earlier working parenthesized form.

The source now binds each constructor to a local name before instantiation.
The read-only flags, regular-file/symlink checks, bounded queries, job
provenance checks and session-preview behavior are unchanged.

## Regression evidence

Four new tests execute the emitted root and Codex modules under separate
Node and Bun processes. Each uses a real fixture database with one eligible
job, requires a one-session dry-run result, and checks unchanged database
bytes/mtime and session state. A missing-store fixture would bypass the
constructor and would not prove this fix.

Before the fix, all four compiled cases failed with constructor errors while
the 10 source-level tests passed. Afterward, all 14 repair-session tests passed
with 60 assertions. No model calls, real operator stores, or credentials were
used. The existing 2.0.2 source/control/live-smoke evidence remains applicable:
the fix changes only local session repair, not subprocess execution or hooks.

## Release discipline

Local frozen-dependency full check passed: 902 tests, 28 opt-in skips, zero
failures, 3,015 assertions. Build, types, generated surfaces and distribution
drift all passed. `bun audit` found no vulnerabilities. Two independent final
reviews found no must-fix issues. The check used an isolated worktree with a
fresh frozen installation, not a symlink to the original dependency directory;
its staged tree matched the release candidate. Only result documentation
changed after that check. No live model calls were repeated for this fix.

Dependencies are installed with `bun install --frozen-lockfile` before build
and validation. The local gate and CI must both pass before publishing the
new tag. Regenerated artifacts are checked into both host distributions.
Future release instructions now make these steps explicit.
