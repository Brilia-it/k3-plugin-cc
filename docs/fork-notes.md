# BRILIA fork: notes for maintainers and coding agents

This file holds what is specific to the BRILIA fork (`k3-plugin-cc`) and does not fit in
[AGENTS.md](../AGENTS.md), which upstream caps at 24 KB (`scripts/check-contract-size.mjs`). Read it
before releasing, promoting to `main`, or taking an upstream release.

## Remotes and tags

In a clone of this fork `origin` is usually upstream (read-only), and the fork's remote is `brilia`.
The release commit reaches `main` through `staging/<name>` and `scripts/promote-to-main.mjs` (below);
only then tag it `vX.Y.Z-brilia.A.B.C` and push the tag to `brilia`. Release tags `v*` are immutable
here too, by ruleset.

## No npm publishing

None of upstream's npm publishing applies here. This fork is not published to npm:
`.github/workflows/publish.yml` is removed, `package.json` is `"private": true` with no
`publishConfig`, and the npm package `kimi-plugin-cc` is upstream's. `check:package` and
`check:consumer-security` are kept as packaging tests only. If a future upstream merge brings
`publish.yml` back, delete it again.

## How a change reaches `main`

`main` is protected by a ruleset: no force push, no deletion, and a green `check` from GitHub Actions
on the commit. Push to a `staging/<name>` branch (CI runs there too), wait for `check` to pass, then
run the copy of `scripts/promote-to-main.mjs` that is on `main` (the script refuses to run if it
differs from it). It fast-forwards `main` only if every `check` on the commit comes from a push run of
`.github/workflows/ci.yml` on that staging branch, and every attempt of that run succeeded, not only
the last (`--accept-failed-attempts=<run id>` for a failure you have understood). It refuses a commit
that changes what defines CI (`.github/`, `package.json`, `bun.lock`, `bunfig.toml`, any root
`tsconfig*.json`, `scripts/`) unless `--ci-change-reviewed=<full 40-char sha>` names exactly the
commit whose diff you read. A change to the script itself goes in its own commit, promoted by the
copy already on `main`, before anything that should be judged by the new version. Its logic is
tested in `tests/scripts/promote-to-main.test.js`. Never fast-forward `main` to the head of a pull
request from an external fork. The ruleset cannot enforce the script: someone with write access can
still push a green commit by hand.

## Names, and how an upstream release comes in

This fork uses its own names wherever a person or a program can see them (`/k3:*`, `k3-*`,
`K3_PLUGIN_CC_*`, `k3-plugin-cc-managed`, `k3-plugin-cc/`, the MCP server `k3` and its tools
`k3_*`); Moonshot's CLI keeps its own (`kimi`, `kimi-code`, `KIMI_CODE_*`, and the job fields that
name it, such as `kimi_session_id` and `kimi_pid`). The renaming has one definition,
`scripts/identity-map.mjs`.

To take an upstream release: check out the upstream tag in a separate worktree, run
`node scripts/identity-map.mjs apply <that worktree>` there (it rewrites contents and file names, and
leaves the `KEEP_VERBATIM` page and the `MERGED_BY_HAND` prose, `README.md`, `CHANGELOG.md` and
`NOTICE`, as upstream wrote them), commit that as the renamed upstream, and merge it; conflicts then
mark only real behaviour differences. Read upstream's changes to those three files and write them
into ours by hand. Never run `apply` on this repository's own tree: the migration code spells
upstream's names on purpose. After the merge, `node scripts/identity-map.mjs verify <upstream tag>`
must report zero undeclared differences.

## What the fork does not carry

- **The DeepSeek Harness host** (upstream 2.5.0 and 2.5.1: `plugins/kimi-dsh/`, `runtime/dsh/`,
  `dsh/`, `scripts/check-dsh-package.mjs`, the DSH fields of `package.json`). Decided on 2026-11-10.
  The upstream paths are listed in `DECLARED_REMOVED` of `scripts/identity-map.mjs`, so `verify`
  fails if a merge brings them back. Delete them again, with what only exists for them.
- **`publish.yml`**, see above.

## State of the 2.5.6 rebuild

`2.5.6-brilia.0.1.0` rebuilds the fork on upstream v2.5.6 in phases. Phase 1 carries the identity
map, the packaging, CI and documentation of the fork. The behaviour changes of 0.7.0 (the Windows
fixes, the migration from 0.5.x names, the job and wait fixes, the quota classification, one model
job at a time, the model probe) come back in the next phases; until then README and NOTICE describe
some changes that this tree does not carry yet.
