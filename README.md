# K3 plugin for Claude Code

Use Kimi K3 from inside Claude Code for code reviews or to delegate tasks to K3.

This plugin is for Claude Code users who already pay for a Kimi Code subscription and want to reach
it from the workflow they already have.

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
  `kimi --version`.
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

Checked against the live page on 2026-09-05. Terms change; check them yourself.

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

### Coexistence with the upstream plugin

The commands live under `/k3:*` and the upstream plugin uses `/kimi:*`, so both can be installed
side by side without colliding.

## Platform support

| Platform | Status |
|---|---|
| Windows 11 | **Tested.** Enforcement verified end to end inside a real `kimi-code` session |
| macOS | **Supported, not tested by us.** Every change we made is gated behind `process.platform === "win32"`, so the POSIX path is byte-for-byte upstream v1.9.8, which upstream certifies against `kimi-code` 0.30.0 |
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

This fork is built on upstream **v1.9.8** (commit `145cf80`). Upstream has since moved to **v1.9.13**,
so you are not getting their latest: you are getting v1.9.8 plus three Windows fixes. Newer upstream releases have been tested
against newer `kimi-code` builds; this fork's Windows enforcement was last exercised locally
against `kimi-code` **0.30.0**, on **2026-09-05**. If you run a newer CLI, the measurements above still
describe 0.30.0, not what you have.

## What this fork changes

Three Windows fixes, all gated behind `win32`, none of which alter behaviour on macOS or Linux:

1. **The hook command is double-quoted.** It was quoted POSIX-style with single quotes, which
   `cmd.exe` does not recognise, so the hook never launched. Since any exit code other than 2 means
   "allow", enforcement was silently inert while `/kimi:setup --check` still reported `Probe: ok`.
   Measured with the same command string: `/bin/sh` exits 2, `cmd.exe` exits 255.
2. **Hook paths are normalised.** The path derived from `CLAUDE_PLUGIN_ROOT` contains backslashes on
   Windows, and the TOML safety check rejects backslashes, so every Windows user had to set
   `KIMI_PLUGIN_CC_HOOK_SCRIPT` by hand. Setup now works with no override.
3. **The Windows shell probe runs.** It used to return "skipped (Windows)" as a *success*. We
   measured how `kimi-code` actually spawns the hook on Windows (`node.exe <- cmd.exe <- kimi.exe`,
   via `ComSpec`) and the probe now reproduces that path.

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

## Acknowledgments

All the engineering here is [Xule Lin](https://github.com/linxule)'s. The job store, the cancellation
handling, the approval policy, the stream parser and the safety architecture are his work. We fixed
three Windows papercuts and wrote this README.

## License

Apache-2.0, same as upstream. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
