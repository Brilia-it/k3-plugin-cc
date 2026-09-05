# Security

This is an unofficial fork. Report issues **here**, not to Moonshot AI and not to the upstream
author.

## What the plugin actually guarantees

Read-only commands (`/k3:review`, `/k3:challenge`, `/k3:ask`) run the `kimi-code` CLI with a
`PreToolUse` hook installed in `~/.kimi-code/config.toml`. The hook denies write-capable tools and
allows a fixed read-only set.

This matters because `kimi -p` hard-codes `permission: auto`: without the hook, every tool call the
model makes is auto-approved. The hook is not defence in depth. **It is the only defence.**

## What we verified, and how

Measured on Windows 11, `kimi-code` 0.30.0, Node v22.20.0. Last re-run on **2026-09-05**,
against the exact commit published here.

**Nine write vectors, all denied**, on `cmd.exe` and on `sh`: write via the file tool, via `Bash`,
via PowerShell, via shell redirection, from a child process, edit, rename, delete, and an absolute
path outside the working directory. Plus a positive control (a permitted read succeeds).

**A negative control**, which is the part that makes the rest meaningful: with the hook pointed at a
script that does not exist, the write succeeds. A test bench that cannot detect an inert hook proves
nothing about a healthy one.

**End to end in a real session.** Not a bench that imitates the spawn: a real `kimi-code` session on
Windows was asked to create a file. It attempted `Bash`, was denied, attempted `Write`, was denied
again, and reported back that the operation was refused by the hook policy.

Reproduce with `node tests/manual/enforcement-matrix.mjs` and
`node tests/manual/shell-probe-discrimination.mjs`.

## What it does NOT guarantee

**The hook contract is fail-open.** Exit code 2 means deny; **anything else means allow**. A hook
that crashes, times out, or cannot be launched does not fail safe. This is tracked upstream as `H1`
and is still open.

That is exactly the bug this fork found on Windows: the command was quoted for a POSIX shell,
`cmd.exe` could not launch it, the exit code was 255, so every tool call was allowed, while
`/kimi:setup --check` reported `Probe: ok`. Both halves matter: enforcement was inert **and** the
diagnostic said it was fine.

The root cause is not in this plugin or in the upstream one. `kimi -p` exposes no sandbox flag, so
an external hook is the only lever available. By contrast the official Codex plugin passes
`sandbox: "read-only"` as a protocol parameter to `codex app-server`: if that call fails you get no
review, rather than an unguarded one. **The absence of a result is safe; the absence of a hook is
not.**

**Reads are not confined.** The hook stops writes. It does not restrict which paths the model may
read, and there is no secret scanning. Reading and exfiltrating are separate steps and only the
first one is a tool call: a model can read a file and repeat its contents in its answer, which no
`PreToolUse` hook can see.

**Everything read reaches the vendor.** Prompt, tool results and response transit Moonshot's
infrastructure under their terms. This is equally true of comparable plugins, including the official
Codex one.

## Practical guidance

**Point it at a working directory, not at a tree that holds secrets or client data.** This is a
scope decision you make when you invoke it, not a boundary the plugin enforces for you.

If you need a real boundary, use one the operating system can hold: a dedicated account with ACLs, a
container, or a separate checkout containing only what you intend to share.

## Write-capable commands

`/k3:rescue`, `/k3:pursue` and `/k3:swarm --write` can modify files. They run through an allowlist
scoped to the workspace, with symlink containment and shell-metacharacter checks. Everything above
about reads still applies, and the fail-open contract still applies. Treat them as write access
granted to a third-party model, because that is what they are.

## Reporting

**If it is a vulnerability, report it privately**, through
[GitHub private vulnerability reporting](https://github.com/Brilia-it/k3-plugin-cc/security/advisories/new)
on this repository. Do not open a public issue for one: a public issue tells everyone else first.

For anything that is not a vulnerability, a normal issue is the right place.

Either way, if it involves credentials or client data, describe the **shape** of the problem without
pasting the data. A log pasted in a hurry is the most common way sensitive paths leak.

This is an unofficial fork: report here, not to Moonshot AI and not to the upstream author. If the
problem turns out to be in upstream code, we will take it there ourselves and credit you.
