# K3 plugin for Claude Code, built for Windows

Use Kimi K3 from inside Claude Code for code reviews or to delegate tasks to K3.

This plugin is for Claude Code users who already pay for a Kimi Code subscription and want to reach
it from the workflow they already have.

## Why this fork exists: Windows

The plugin we fork, [linxule/kimi-plugin-cc](https://github.com/linxule/kimi-plugin-cc), states
that **Windows is not currently supported**. This fork is the version that works on Windows, and
the difference is not cosmetic:

- **Setup works.** The hook is what stops a read-only review from writing to your files. On Windows,
  upstream derives the hook path with backslashes, which its own safety check rejects, so setup
  refuses and every command stays blocked until you set `KIMI_PLUGIN_CC_HOOK_SCRIPT` by hand. Here
  the path is normalised and setup works with no override.
- **Once installed, the safety hook actually runs.** If you do set the path by hand on upstream,
  the next problem appears: upstream writes the hook command with POSIX single quotes, and
  `kimi-code` launches hooks through `cmd.exe` on Windows (Node's `shell: true`, in `kimi-code`
  2.1.1 as in 0.30.0), which cannot run that form. The hook never starts, any exit code other than
  2 means "allow", so the write guard is silently off. Here the command is double-quoted and the
  guard denies.
- **The setup probe tells the truth.** Upstream's probe reports "skipped (Windows)" as a success,
  which is why the case above still shows `Probe: ok`. Here the probe launches the hook the way
  `kimi-code` does on Windows and reports what actually happened.

What we verified, and when, is under [Which versions this is](#which-versions-this-is). The fixes
change how the hook command is written and launched on Windows only; on macOS and Linux it is
written and launched exactly as upstream does. What the fixes do **not** change: if the hook process
crashes or times out, the call still goes through. That limit belongs to the hook contract and is
described under [Known limits](#known-limits-stated-plainly).

> ### This is an unofficial fork
>
> **Not affiliated with, endorsed by, or supported by Moonshot AI**, the makers of Kimi and the
> `kimi-code` CLI. Official product: **[kimi.com/code](https://www.kimi.com/code/)**.
>
> **Not the original project either.** This is a fork of
> **[linxule/kimi-plugin-cc](https://github.com/linxule/kimi-plugin-cc)** (Apache-2.0) by Xule Lin,
> who wrote everything that makes this work. Our changes are three Windows fixes, listed below.
>
> Maintained by [BRILIA](https://brilia.it) on a best-effort basis. If something breaks, open an
> issue **here**, not with Moonshot AI and not with the upstream author.

## What You Get

- `/k3:review` for a normal read-only K3 review
- `/k3:challenge` for a steerable adversarial review
- `/k3:ask` for a free-form question about the repository
- `/k3:rescue`, `/k3:status`, `/k3:result` and `/k3:cancel` to delegate work and manage background jobs

## Requirements

- **A Kimi Code subscription.** [Get one at kimi.com/code](https://www.kimi.com/code/).
  - **Yours, not somebody else's.** The plugin never carries a credential: it drives the
    `kimi-code` CLI that is already logged in on your machine. Each person installs and
    authenticates their own.
  - Usage contributes to your own Kimi Code limits.
- **The `kimi-code` CLI, installed and authenticated.** Run `kimi login` once, then check with
  `kimi --version`. Use a version this release certifies; **2.1.1** is the recommended one (see
  [Which versions this is](#which-versions-this-is)). On Windows, `kimi-code` itself needs
  [Git for Windows](https://gitforwindows.org/), whose Git Bash it uses as its shell.
- **Node.js 22.5 or later** (the runtime uses the built-in `node:sqlite`).

### Before you install: the terms, and an open question

This plugin drives the CLI in print mode (`kimi -p`), which is non-interactive. Moonshot's
[Kimi Code Community Guidelines](https://www.kimi.com/code/docs/en/kimi-code/community-guidelines.html)
say:

> Kimi Code subscriptions are for personal interactive use only. Using it for non-interactive
> purposes — such as scripted batch execution or data annotation pipelines — goes beyond normal use.

The stated consequence for going beyond normal use is that Moonshot will "review the situation first
and take appropriate action — such as limiting concurrent access", which surfaces as a
`You've reached your concurrent request limit` error. The guidelines also describe account
suspension, but that clause is about buying through unauthorised channels and does not apply here.

**We cannot tell you whether your use of this plugin counts as interactive.** Moonshot's own CLI
reference documents `-p` for running "a single prompt in a script or CI environment", and says that
mode defaults to the `auto` permission policy. So one page documents the flag and another calls
non-interactive use abnormal. The technical mode is not in doubt: `-p` is non-interactive. What is unclear is how a
human-initiated plugin invocation is classified under a subscription, and only Moonshot can settle that, and we are not going to settle it for them by reading it in our favour.

What we can tell you plainly:

- Every command that talks to the model goes through `kimi -p`. There is no interactive mode that
  avoids it. (`setup`, `status`, `result`, `cancel` and `replay` never invoke `kimi -p` and never reach the
  model.)
- Some commands go considerably further from interactive use than a single review does. `/k3:pursue`
  runs an autonomous multi-turn goal loop, and `/k3:swarm` fans out to parallel subagents. If the
  distinction between interactive and automated matters to you, those are the ones to weigh.
- If the answer matters for your account, ask Moonshot support before installing, or use an API plan
  whose terms cover programmatic use.

Checked against the live page on 2026-09-28. Terms change; check them yourself.

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add Brilia-it/k3-plugin-cc
```

Install the plugin:

```bash
/plugin install k3@brilia-k3-marketplace
```

Restart Claude Code, then bootstrap the safety hook once:

```bash
/k3:setup
```

Verify it is actually enforcing, not just installed:

```bash
/k3:setup --check
```

**This fork is not on npm.** Upstream also ships as the `kimi-plugin-cc` package on npm; that
package is upstream's code, without the Windows fixes. Install this fork from the marketplace above.

### Coexistence with the upstream plugin

**Partial, and worth understanding before you try it.** The slash commands and the agents no longer
collide: ours are `/k3:*` and `k3-*`, upstream's are `/kimi:*` and `kimi-*`.

The safety hook still does. Both plugins write a managed block into the same
`~/.kimi-code/config.toml`, keyed by a host id that answers "which editor is driving kimi-code",
not "which plugin". Installed under `~/.claude/`, both answer `claude-code`, so they own the same
block: whichever ran `setup` last holds it, and the other refuses to run until you re-run its setup,
which flips it back. That refusal is correct fail-closed behaviour, but two legitimately installed
plugins should not force it on each other.

Until that is fixed, **use one at a time**. Nothing is unsafe about having both installed; the one
that does not own the block simply will not run.

## Platform support

| Platform | Status |
|---|---|
| Windows 11 | **Tested, and the reason this fork exists.** Upstream does not support Windows. See [Which versions this is](#which-versions-this-is) for what was verified and how |
| macOS | **Supported, not tested by us.** How the hook command is written, quoted and launched is gated behind `process.platform === "win32"`, so on POSIX it is upstream v2.0.7's, which upstream certifies against `kimi-code` 0.42.0/0.43.x/2.0.x/2.1.0/2.1.1 (native v2) and 0.1-0.41.x (legacy). Not byte-for-byte, though: see [What this fork changes](#what-this-fork-changes) |
| Linux | Same as macOS |

If you are the first to run this on macOS or Linux, we would like to hear about it either way.

## Known limits, stated plainly

**The hook fails open.** Enforcement is an external hook process, and the contract treats any exit
code other than 2 as "allow". If that process crashes or times out, the operation goes through.
This is upstream debt (`H1`) and it is not fixed here. The root cause is outside both projects:
`kimi -p` hard-codes `permission: auto` and exposes no sandbox flag, so an external hook is the only
lever available. For contrast, the official Codex plugin passes `sandbox: "read-only"` as a protocol
parameter, so a failed call yields no review rather than an unguarded one.

**Read-only means "does not write", not "reads only what you handed it".** The hook blocks writes.
It does not confine what the model may read, and whatever is read is sent to the vendor. This is
equally true of every plugin of this kind, including the official Codex one.

**So: point it at a working directory, not at a tree that holds secrets or client data.**

See [SECURITY.md](./SECURITY.md) for the details and for what we did verify.

## What to expect in practice

Notes from running this daily since 2026-08-14, on **Windows 11, `kimi-code` 0.30.0, Node 22.20**.
Each item says how well we know it. Behaviour may differ on later versions.

| What happens | How we know |
|---|---|
| **Our subscription hit its cycle quota.** `403 You've reached your usage limit for this billing cycle`, and it stayed until the cycle rolled over. When it happens it is not the hook, not your `PATH`, and not a truncated reply: it is billing. | happened to us |
| **On Windows, `review` can fail on a large enough diff**, with `CLI_SPAWN_FAILED` / `spawn ENAMETOOLONG`. The companion puts the diff into the spawn arguments and Windows caps command-line length, so it is the size of the diff that breaks it, not the mere presence of uncommitted work. A small dirty tree is fine. Remedy: stash what is unrelated, or point `ask` at the specific files. | reproduced |
| **A run can stop early and still look finished.** Two ways: the host that spawned it hits its own timeout, or `API Error: Connection closed mid-response`. Either way the partial output is well-formed and reads like an answer. **As a completeness check, confirm it reaches the last section you asked for.** Ask for seven numbered points and count them. Reaching the end does not make an answer right, but stopping short makes it certainly partial. | reproduced, both ways |
| **`-p` and `--auto` refuse to combine**: `Cannot combine --prompt with --auto`. Matches the vendor's CLI reference. | reproduced |
| **`KIMI_BINARY_UNAVAILABLE` is a classification, not a diagnosis.** The wrapper maps certain spawn failures to it, normally meaning the CLI could not be found or executed; other things can fail a spawn too, `ENAMETOOLONG` above among them. We hit it once with `kimi` demonstrably on `PATH`, and `/k3:setup` cleared it. Cause never established, so: try `/k3:setup` before you go hunting your `PATH`. | one occurrence, cause unknown |
| **Long prompts have produced the answer twice** in one stdout. Where we saw it, the second pass was the fuller one. We have not counted often enough to call that a rule. | observed a few times, cause unknown |
| **stderr carries the reasoning trace** (tens of KB), **stdout carries the answer.** Read the wrong stream and it looks like it said nothing. | reproduced |
| **Sessions can be resumed.** Our runs ended with a `To resume this session: kimi -r session_...` line. | seen on every run we kept |

### What it is actually good for

Adversarial review. On one product review it found a real arithmetic error and two hidden
assumptions that neither Claude nor three subagents had caught. **In that same review, 2 of its 6
claims did not survive checking.**

That is one case and not an error rate, so do not read a percentage into it. Both halves are the
point: it is a second pair of eyes, not an oracle. Check what it tells you. Used that way it earns
its keep; used as an authority it will cost you.

### Which versions this is

This fork is built on upstream **v2.0.7**, and its version number says so: the half before
`-brilia.` is the upstream release we are built on, the half after counts our own changes. We
re-aligned on **2026-09-28**; before that we sat on v2.0.5, v1.10.1 and v1.9.8.

**Which engine you get depends on your `kimi-code` version, exactly.** Upstream moved to
kimi-code's native agent-core-v2 when kimi-code 0.42.0 deleted the legacy v1 engine, and
kimi-code has since gone to 2.x. Certification for native v2 is per **exact** version, not per
minor:

| Your `kimi-code` | What happens |
|---|---|
| **0.1 through 0.41.x** | Legacy v1 engine, as before. Certified per minor. |
| **0.42.0, 0.43.0, 0.43.1, 2.0.0, 2.0.1, 2.0.2, 2.1.0, 2.1.1** | Native v2, certified for all eight operations. **2.1.1 is the recommended version.** |
| **anything else** | **Every model-spawning command refuses** (`KIMI_CAPABILITY_NOT_CERTIFIED`) until a release certifies that exact version. |

That last row is the one to know about, because **kimi-code can update itself**. On the next
kimi-code release after 2.1.1, the plugin will refuse until upstream certifies it. Pin
`KIMI_PLUGIN_CC_KIMI_BIN` to a known binary if you need continuity.

The opposite can happen too. On our machine kimi-code sat on 0.30.0 for four days after 2.1.1 was
out: its updater logged the new version as eligible on every run and never installed it, and we
only drive it through this plugin. We have not established why. So check `kimi --version` against
the table rather than assuming you are current. To install an exact version on Windows, the
official installer takes one: `$env:KIMI_VERSION = '2.1.1'; irm https://code.kimi.com/kimi-code/install.ps1 | iex`.

Two behaviours worth knowing before you update: **sessions created before 1.10 cannot be resumed on
native v2** (nothing is deleted, but start fresh ones), and **`default_plan_mode = true` in
`~/.kimi-code/config.toml` blocks every command** — that setting would arm the one code path that
bypasses the safety hook, and `/k3:setup` cannot repair it. Full list in
[docs/migration.md](./docs/migration.md).

This release also carries upstream's **v1.10.2 security fix**: a denial of service in the vendored
command parser. If you are on an older build of this fork, that is the reason to update even if you
do not care about the rest.

**What we verified on Windows for this release, and what we did not** (2026-09-28, Windows 11,
after the merge with upstream v2.0.7):

- **The hook, driven the way `kimi-code` drives it.** `tests/manual/enforcement-matrix.mjs` launches
  the built hook through a shell with Node's `shell: true`, which is how `kimi-code` launches hooks:
  nine write vectors denied on `cmd.exe` and on `sh`, a read allowed, and the negative control (a
  hook that does not exist) correctly failing open. It does not go through `kimi-code` itself.
- **That `kimi-code` 2.1.1 still launches hooks that way.** Read in its source, not measured:
  `runHook.ts` spawns the hook command with `shell: true`, which on Windows means `cmd.exe`.
- **Not yet: an end-to-end run through a real `kimi-code` 2.1.1 session.** The last one went
  through `kimi-code` **0.30.0** on 2026-09-23. The 2.1.1 run waits on our subscription's weekly
  quota, and this line will say so until it is done.
- **The unit tests run on Linux, in CI**, which must be green before `main` moves. Run locally on
  Windows, the suite includes POSIX-only tests (`/usr/bin/false`, symlinks) that fail there for
  reasons unrelated to this fork.

## What this fork changes

Three Windows fixes. How the hook command is written, quoted and launched changes on Windows only.
Two things differ on every platform, so this is not upstream byte-for-byte on macOS or Linux either:
the parser that recognises this plugin's own hook command also accepts the double-quoted form there,
so a hand-written double-quoted hook under an upstream install path would be treated as ours; and
setup's messages and the managed block carry this fork's names and version.

1. **The hook command is double-quoted.** It was quoted POSIX-style with single quotes, which
   `cmd.exe` does not recognise, so the hook never launched. Since any exit code other than 2 means
   "allow", enforcement was silently inert while the setup check (upstream's `/kimi:setup --check` at
   the time we found it) still reported `Probe: ok`.
   Measured with the same command string: `/bin/sh` exits 2, `cmd.exe` exited 255 when we found it
   (2026-08-12) and 1 in an independent re-test on 2026-09-28. The number moves; what matters is
   that it is not 2, so the call is allowed. Upstream v2.0.7 still writes the single-quoted form.
2. **Hook paths are normalised.** The path derived from `CLAUDE_PLUGIN_ROOT` contains backslashes on
   Windows, and the TOML safety check rejects backslashes, so every Windows user had to set
   `KIMI_PLUGIN_CC_HOOK_SCRIPT` by hand. Setup now works with no override, unless the path itself
   contains `%`, `!` or `"`: those cannot be quoted safely for `cmd.exe`, and setup refuses rather
   than guess, with or without the override.
3. **The Windows shell probe runs.** It used to return "skipped (Windows)" as a *success*. We
   measured how `kimi-code` 0.30.0 actually spawns the hook on Windows (`node.exe <- cmd.exe <- kimi.exe`,
   via `ComSpec`) and the probe now reproduces that path. For 2.1.1 its source says the same.

These have **not** been proposed upstream yet, so the upstream project is not aware of them and
is not responsible for them. We intend to open them as pull requests against
[linxule/kimi-plugin-cc](https://github.com/linxule/kimi-plugin-cc). If they land there, use the
upstream plugin instead of this fork: it is the same code with one fewer maintainer between you
and it.

## Uninstall

```bash
/k3:setup --uninstall
/plugin uninstall k3@brilia-k3-marketplace
```

`--uninstall` removes the managed hook block from `~/.kimi-code/config.toml`. Your Kimi Code login
is untouched.

Review and challenge inspect your Git diff. Use ask for general questions about your repository.

All the engineering here is [Xule Lin](https://github.com/linxule)'s. The job store, the cancellation
handling, the approval policy, the stream parser and the safety architecture are his work. We made
it work on Windows, keep checking that it still does, and wrote this README.

Claude Code also has an optional [review gate](./commands/setup.md). It checks work when Claude finishes a turn and is off by default.

Apache-2.0, same as upstream. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
