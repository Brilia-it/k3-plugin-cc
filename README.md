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

These are offered upstream as pull requests. If they land there, use the upstream plugin.

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
