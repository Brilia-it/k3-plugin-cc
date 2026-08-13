// Shared canonical-path helpers for the kimi-plugin-cc PreToolUse hook.
//
// Why a separate module:
//
//   `runtime/commands/setup.ts` is the installer; `runtime/hooks/install.ts`
//   is the per-call verifier. Audit (reports 27 + 28) found two
//   convergent issues:
//
//     1. The verifier's drift gate was opt-in (callers had to pass
//        `expectedHookPath`). rescue.ts called it WITHOUT the path, so
//        a managed block referencing a stale hook script silently passed.
//        kimi-code's spawn of the stale path exited 127 (or
//        MODULE_NOT_FOUND), which the hook runner treats as ALLOW —
//        rescue's workspace-bound allowlist bypassed in production.
//
//     2. Even when callers DID pass `expectedHookPath`, the verifier
//        used `commandPath.includes(expectedHookPath)` (substring), so a
//        crafted command like `true # /path/to/approval-hook.js` would
//        pass: `/bin/sh -c "true # ..."` runs only `true` (exit 0,
//        no-op allow), then kimi-code treats exit 0 as ALLOW.
//
//   Fix: every verifier path now reconstructs the canonical expected
//   shell command from the resolved Node binary + hook script path, and
//   does EXACT equality. This module owns the single source of truth for
//   how that command is built.
//
//   Both setup.ts (write side) and install.ts (verify side) import from
//   here. The probe in setup.ts also uses `buildHookShellCommand` so the
//   shell probe runs the exact byte string the managed block writes.
//   These three call sites cannot drift without a compile error.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeError } from "../errors.js";
/**
 * Prefer a non-version-stamped path to the SAME Node binary.
 *
 * `process.execPath` is fully symlink-resolved, so under Homebrew it is
 * `/opt/homebrew/Cellar/node/<version>/bin/node` — a path that changes on
 * every `brew upgrade node`. The managed block is verified by byte-exact
 * equality, so that churn silently invalidates EVERY host's hook at once and
 * forces a re-run of `/kimi:setup` with no user-visible cause (diagnosed
 * 2026-07-25; a June config backup held `node/26.0.0` and `node/26.3.0`
 * side by side, i.e. this had already fired before).
 *
 * `process.argv0` preserves the path the interpreter was actually invoked
 * with, and `scripts/companion.sh` execs `$(command -v node)` — the stable
 * `/opt/homebrew/bin/node` symlink. Prefer it, but ONLY when it provably
 * denotes the same executable: absolute, and `realpath()`-identical to
 * `process.execPath`. That guard is the whole safety argument — it can never
 * select a DIFFERENT binary, only a more stable NAME for the one already
 * running. Any doubt falls back to `execPath`, so the result is always an
 * absolute path to a real interpreter.
 *
 * Side benefit: this keeps the hook and the companion on the same interpreter
 * by construction, since companion.sh resolves `node` through that same
 * stable name. The old behavior could diverge — companion running the new
 * node while the hook stayed pinned to a Cellar path brew had already
 * deleted, which spawns nothing and (exit 127) reads as ALLOW.
 *
 * Scope: helps symlink-based installs (Homebrew, and any manager exposing a
 * stable `node`). nvm/asdf/mise expose version-stamped paths directly, so
 * argv0 == execPath there and behavior is unchanged, not worse.
 */
export function preferStableNodePath(execPath, argv0 = process.argv0, realpath = realpathSync) {
    if (argv0 === undefined || argv0.length === 0 || !path.isAbsolute(argv0)) {
        return execPath;
    }
    try {
        return realpath(argv0) === realpath(execPath) ? argv0 : execPath;
    }
    catch {
        return execPath;
    }
}
/**
 * Resolve the absolute path to the Node binary used in the PreToolUse
 * hook command. kimi-code spawns hooks via `/bin/sh -c "<command>"`; a
 * bare `node` would rely on the shell's PATH at execution time, which
 * fails under GUI/LaunchAgent launches with sanitized PATH. Require an
 * absolute path — either a stable alias of the in-process interpreter
 * (see `preferStableNodePath`) or an explicit `KIMI_PLUGIN_CC_NODE_BIN`
 * override.
 */
export function resolveNodeBinary(env) {
    const override = env.KIMI_PLUGIN_CC_NODE_BIN;
    if (override === undefined || override.length === 0) {
        return preferStableNodePath(process.execPath);
    }
    if (!path.isAbsolute(override)) {
        throw new RuntimeError("SETUP_NODE_BIN_NOT_ABSOLUTE", [
            `KIMI_PLUGIN_CC_NODE_BIN must be an absolute path; got ${JSON.stringify(override)}.`,
            `kimi-code spawns hooks via /bin/sh -c, where a bare command relies on the shell's PATH at hook execution time.`,
            `Use an absolute path so the hook keeps firing under sanitized-PATH launches.`,
        ].join(" "), "setup.node-bin", { details: { override } });
    }
    return override;
}
/**
 * Build the exact shell command string that the host shell needs to spawn
 * the hook. Single source of truth for:
 *
 *   - what `/kimi:setup` writes into kimi-code's config
 *     (`command = "..."` inside [[hooks]])
 *   - what the shell probe runs
 *   - what the verifier (`evaluateInstalled`) equality-checks the
 *     installed `command = "..."` against on every command spawn
 *
 * WINDOWS FIX (BRILIA fork). Upstream single-quotes both tokens, which is
 * correct for `/bin/sh -c` and WRONG for `cmd.exe`: single quotes are not
 * quoting characters there, so the command fails to launch. Because the hook
 * protocol treats every exit code other than 2 as ALLOW, a hook that cannot
 * launch degrades to fail-open SILENTLY, while `/kimi:setup --check` still
 * reports "Probe: ok". Measured on Windows 11 with kimi-code 0.30.0:
 *
 *   | quoting                | /bin/sh | cmd.exe        |
 *   |------------------------|---------|----------------|
 *   | single quotes (upstream) | exit 2 (deny) | exit 255 (fail-open) |
 *   | double quotes            | exit 2 (deny) | exit 2 (deny)        |
 *
 * Double quotes are therefore the only form that holds in BOTH shells, and
 * they are safe on Windows because `"` is an illegal character in NTFS paths.
 * On POSIX the historical single-quote form is preserved verbatim, so this
 * change is a no-op off Windows.
 */
export function buildHookShellCommand(hookScriptPath, env) {
    const nodeBin = resolveNodeBinary(env);
    const quote = process.platform === "win32" ? shellDoubleQuote : shellSingleQuote;
    return `${quote(nodeBin)} ${quote(hookScriptPath)}`;
}
/**
 * POSIX shell single-quote a string. Inner `'` are escaped as `'\''`
 * (close-quote, escaped quote, re-open-quote). Always safe — no shell
 * metacharacters survive the encoding.
 */
export function shellSingleQuote(value) {
    return `'${value.replaceAll("'", "'\\''")}'`;
}
/**
 * Double-quote a string for `cmd.exe` (and, incidentally, for POSIX shells,
 * where backslashes inside double quotes are literal unless followed by
 * `$`, a backtick, `"` or `\`).
 *
 * No escaping of the value is performed, by design: `"` is not a legal
 * character in a Windows path, and `setup` already refuses hook paths
 * containing quotes, control characters or newlines
 * (SETUP_HOOK_PATH_UNSAFE). If one ever reached here it would produce an
 * ambiguous command, so we fail loudly instead of emitting something that
 * might silently degrade to fail-open.
 */
export function shellDoubleQuote(value) {
    const offending = CMD_UNSAFE_CHARS.filter((ch) => value.includes(ch));
    if (offending.length > 0) {
        throw new Error(`kimi-plugin-cc: refusing to build a hook command from a path containing ${offending
            .map((ch) => JSON.stringify(ch))
            .join(", ")}: ${JSON.stringify(value)}. ` +
            "Double quotes do not neutralize these in cmd.exe, so the resulting command would be " +
            "ambiguous, and an ambiguous hook command degrades to fail-open (any exit code other " +
            "than 2 is treated as ALLOW). Move the plugin to a path without these characters, or " +
            "set KIMI_PLUGIN_CC_HOOK_SCRIPT to one.");
    }
    return `"${value}"`;
}
/**
 * Characters that survive double quotes in cmd.exe and would make the hook
 * command ambiguous.
 *
 *   `"` closes the quote.
 *   `%` still expands (`%VAR%`) INSIDE double quotes.
 *   `!` expands when delayed expansion is enabled (`cmd /V:ON`), also inside quotes.
 *
 * All three are legal in NTFS filenames, so a plugin installed under, say,
 * `C:\builds\100%\...` would silently produce a broken command. Failing loudly
 * is the only safe option here: the consequence of getting it wrong is not a
 * crash but a silently disabled security gate.
 *
 * `^ & < > |` are deliberately NOT listed: double quotes DO neutralize them in
 * cmd.exe, so rejecting them would be a false positive on legal paths.
 */
const CMD_UNSAFE_CHARS = ['"', "%", "!"];
/**
 * Resolve the absolute path to the compiled hook script.
 *
 * Resolution order:
 *
 *   1. `KIMI_PLUGIN_CC_HOOK_SCRIPT` override — tests / advanced users.
 *   2. Sibling resolution from this file's URL. This module lives at
 *      `<root>/{runtime,dist}/hooks/install-paths.{ts,js}`. The hook
 *      artifact lives at `<root>/dist/hooks/approval-hook.js`. Walk up
 *      to `<root>` and append the canonical hook artifact path.
 */
export function resolveHookScriptPath(env) {
    const override = env.KIMI_PLUGIN_CC_HOOK_SCRIPT;
    if (override !== undefined && override.length > 0) {
        if (!path.isAbsolute(override)) {
            // kimi-code spawns hooks via `/bin/sh -c "<command>"` with a
            // cwd that may not match the companion's. A relative path here
            // would resolve against the kimi-code shell's working dir at
            // hook execution time — different from the path resolved at
            // install time. The mismatch would let the verifier bless a
            // path that doesn't actually run. Match the NODE_BIN_NOT_ABSOLUTE
            // contract by requiring an absolute override. Audit re-review
            // (report 34 Codex MEDIUM) flagged this.
            throw new RuntimeError("SETUP_HOOK_SCRIPT_NOT_ABSOLUTE", [
                `KIMI_PLUGIN_CC_HOOK_SCRIPT must be an absolute path; got ${JSON.stringify(override)}.`,
                `kimi-code spawns hooks via /bin/sh -c with a cwd that may differ from the companion's.`,
                `Use an absolute path so the verifier and the runtime spawn refer to the same file.`,
            ].join(" "), "setup.hook-script-path", { details: { override } });
        }
        // Deliberately NOT normalized. The override is supplied verbatim by the
        // operator and is compared byte-for-byte against the managed block by the
        // verifier; rewriting it here would make a block written with the operator's
        // own spelling read as drift. Normalization exists to fix the path WE
        // derive (below), which is the one that made the plugin uninstallable on
        // Windows. An operator using the override can spell it unambiguously.
        return override;
    }
    const here = fileURLToPath(import.meta.url);
    const parts = here.split(path.sep);
    // Pin to the canonical suffix `{runtime|dist}/hooks/install-paths.{ts,js}`
    // — anchoring to a specific tail keeps ancestor directories named
    // "runtime" or "dist" from confusing the lookup.
    if (parts.length < 3) {
        throw resolveHookFailure(here);
    }
    const tailParent = parts[parts.length - 2];
    const tailGrandparent = parts[parts.length - 3];
    if (tailParent !== "hooks" || (tailGrandparent !== "runtime" && tailGrandparent !== "dist")) {
        throw resolveHookFailure(here);
    }
    const pluginRoot = parts.slice(0, parts.length - 3).join(path.sep) || path.sep;
    return normalizeHookPathSeparators(path.join(pluginRoot, "dist", "hooks", "approval-hook.js"));
}
/**
 * On Windows, express the hook script path with forward slashes.
 *
 * Why this exists at all: without it the plugin is not installable on Windows.
 * `resolveHookScriptPath` derives the path from CLAUDE_PLUGIN_ROOT, so on
 * Windows it comes back with backslashes, and `assertHookPathTomlSafe` rejects
 * backslashes outright (SETUP_HOOK_PATH_UNSAFE). Every Windows user therefore
 * had to set KIMI_PLUGIN_CC_HOOK_SCRIPT by hand to a forward-slash path — a
 * machine-specific workaround that cannot ship.
 *
 * Why normalize rather than relax the validator: the backslash is TOML's escape
 * character, so accepting it means owning BOTH cmd.exe quoting and TOML escaping
 * instead of neither. Normalizing removes the character from the problem
 * entirely, and the safety check stays exactly as strict as it was.
 *
 * Why forward slashes are safe here: Node accepts them on Windows for every
 * filesystem API, and cmd.exe treats them literally inside a double-quoted
 * argument (the "forward slash means a switch" behaviour belongs to shell
 * builtins like `dir`, not to a quoted argument handed to `node.exe`).
 *
 * No-op off Windows, where paths never contain backslashes as separators and a
 * literal backslash in a filename must stay untouched.
 */
export function normalizeHookPathSeparators(hookScriptPath) {
    if (process.platform !== "win32")
        return hookScriptPath;
    return hookScriptPath.replace(/\\/g, "/");
}
function resolveHookFailure(here) {
    return new RuntimeError("SETUP_RESOLVE_HOOK_FAILED", `Could not infer plugin root from install-paths module path ${here}. Set KIMI_PLUGIN_CC_HOOK_SCRIPT to the absolute path of dist/hooks/approval-hook.js.`, "setup.resolve-hook", { details: { here } });
}
/**
 * Parse a hook shell command of the canonical `'<nodeBin>' '<hookScript>'`
 * shape (two POSIX single-quoted tokens, space-separated) back into its two
 * tokens. The exact inverse of `buildHookShellCommand` →
 * `shellSingleQuote(nodeBin) + " " + shellSingleQuote(hookScript)`.
 *
 * Returns `null` for any command that isn't exactly two single-quoted tokens
 * (e.g. a legacy bare-`node` form, a crafted/garbage command, or anything with
 * unquoted bare words) — callers treat `null` as "can't classify; use the
 * generic mismatch message". Strict by design: it only recognizes the canonical
 * single-quoted form this module emits, so it never mis-attributes a hand-rolled
 * command's tokens. Tokens with embedded spaces or apostrophes round-trip
 * (spaces live inside the quotes; `'` is encoded as `'\''`).
 */
export function parseHookShellCommand(command) {
    const tokens = parseSingleQuotedTokens(command);
    if (tokens === null || tokens.length !== 2) {
        return null;
    }
    return { nodeBin: tokens[0], hookScript: tokens[1] };
}
/**
 * Tokenize a string of POSIX single-quoted tokens as produced by
 * `shellSingleQuote` (`'...'` with inner `'` encoded as `'\''`). Returns the
 * decoded token list, or `null` if the input contains any unquoted bare
 * character or an unterminated quote — i.e. anything outside the grammar this
 * module emits.
 */
function parseSingleQuotedTokens(input) {
    const tokens = [];
    let i = 0;
    const n = input.length;
    while (i < n) {
        if (input[i] === " ") {
            i += 1;
            continue;
        }
        let token = "";
        let consumedAny = false;
        while (i < n && input[i] !== " ") {
            const ch = input[i];
            if (ch === '"') {
                // BRILIA fork: a "..." quoted segment, the form emitted on Windows by
                // buildHookShellCommand. The value can never contain a literal `"`
                // (illegal in Windows paths, and rejected by shellDoubleQuote), so the
                // next `"` is always the real close.
                const close = input.indexOf('"', i + 1);
                if (close === -1)
                    return null; // unterminated quote
                token += input.slice(i + 1, close);
                i = close + 1;
                consumedAny = true;
            }
            else if (ch === "'") {
                // A '...'  quoted segment. Single-quoted content can never contain a
                // literal "'", so the next "'" is always the real close.
                const close = input.indexOf("'", i + 1);
                if (close === -1)
                    return null; // unterminated quote
                token += input.slice(i + 1, close);
                i = close + 1;
                consumedAny = true;
            }
            else if (ch === "\\") {
                // The `\'` half of a `'\''` escape (an apostrophe in the value).
                if (i + 1 >= n)
                    return null;
                token += input[i + 1];
                i += 2;
                consumedAny = true;
            }
            else {
                // A bare unquoted character — not part of the canonical grammar.
                return null;
            }
        }
        if (!consumedAny)
            return null;
        tokens.push(token);
    }
    return tokens;
}
/**
 * H4 — classify a hook-command MISMATCH into an actionable diagnosis. When the
 * managed block is structurally valid but its `command` differs from what this
 * companion would write, the raw "expected X; got Y" dump is hard to act on. The
 * common real cause is environment drift: a Node upgrade or version-manager
 * (nvm/asdf/mise/fnm/Homebrew) switch moved the pinned interpreter, or a plugin
 * update changed the version-stamped hook-script path. This names which token
 * drifted and, for Node, whether the old binary still exists on disk (a gone
 * binary is the unambiguous "your Node moved" signal).
 *
 * Returns `undefined` when it can't classify (either command isn't the canonical
 * two-single-quoted-token shape, or the tokens are somehow equal) — the caller
 * then falls back to the generic mismatch message. Pure except for the injected
 * `nodeExists` predicate (so the fs probe stays at the call site). Does NOT alter
 * the verifier's exact-equality decision — only the human/LLM-facing reason.
 */
/**
 * Machine-readable sibling of `describeHookCommandDrift`. Same inputs, same
 * parse, but returns WHICH token moved instead of prose — so an LLM caller can
 * branch on `axis` rather than pattern-matching a human sentence (LLM-caller
 * discipline: load-bearing context goes in structured state, never in prose).
 *
 * `"hook-script"` is the recoverable case: install paths are version-stamped,
 * so a plugin update moves it and re-running setup on THAT host re-pins it.
 * `"node-bin"`/`"both"` are reported but deliberately NOT auto-recoverable by
 * a caller retry — a moved interpreter can mean the pinned one is gone, and a
 * hook that fails to spawn exits 127, which kimi-code reads as ALLOW.
 *
 * Returns `undefined` when either command isn't the canonical two-token shape
 * or the commands are equal. Never influences the installed decision.
 */
/**
 * Do two paths name the same file? Used ONLY to sharpen a drift *message*
 * (distinguishing the v1.9.0 stable-path re-pin from a real interpreter move).
 * Never load-bearing: any throw means "can't tell", and the caller falls back
 * to the more conservative wording.
 */
function defaultSameFile(a, b) {
    try {
        return realpathSync(a) === realpathSync(b);
    }
    catch {
        return false;
    }
}
export function classifyHookCommandDrift(installedCommand, expectedCommand, sameFile = defaultSameFile) {
    const installed = parseHookShellCommand(installedCommand);
    const expected = parseHookShellCommand(expectedCommand);
    if (installed === null || expected === null) {
        return undefined;
    }
    const nodeDrift = installed.nodeBin !== expected.nodeBin;
    const hookDrift = installed.hookScript !== expected.hookScript;
    if (!nodeDrift && !hookDrift) {
        return undefined;
    }
    const axis = nodeDrift && hookDrift ? "both" : nodeDrift ? "node-bin" : "hook-script";
    // A node token that changed SPELLING but still names the same file is not an
    // interpreter move. Distinguishing this matters because it is precisely the
    // v1.9.0 upgrade shape (the pin moves off the version-stamped path, and the
    // plugin's own version-stamped script path moves at the same time → `both`),
    // which every existing install hits exactly once. Without this the caller
    // would be told "do not retry, the interpreter may be gone" while the human
    // message says "your Node did not move" — a contradiction where the
    // structured field, being the load-bearing one, was the wrong half.
    return {
        axis,
        installedCommand,
        expectedCommand,
        ...(nodeDrift ? { nodeInterpreterUnchanged: sameFile(installed.nodeBin, expected.nodeBin) } : {}),
    };
}
export function describeHookCommandDrift(installedCommand, expectedCommand, nodeExists, sameFile = defaultSameFile) {
    const installed = parseHookShellCommand(installedCommand);
    const expected = parseHookShellCommand(expectedCommand);
    if (installed === null || expected === null) {
        return undefined;
    }
    const nodeDrift = installed.nodeBin !== expected.nodeBin;
    const hookDrift = installed.hookScript !== expected.hookScript;
    if (!nodeDrift && !hookDrift) {
        return undefined;
    }
    const parts = [];
    if (nodeDrift) {
        if (!nodeExists(installed.nodeBin)) {
            parts.push(`Node binary drift: the installed hook pins ${installed.nodeBin}, which no longer exists on disk ` +
                `(this companion runs ${expected.nodeBin}). This is the classic Node-upgrade / version-manager ` +
                `(nvm, asdf, mise, fnm, Homebrew) drift — the pinned interpreter moved, so kimi-code can no longer ` +
                `spawn the hook and read-only enforcement silently degrades.`);
        }
        else if (sameFile(installed.nodeBin, expected.nodeBin)) {
            // Both paths name the SAME interpreter — a spelling change, not a moved
            // binary. This is the v1.9.0 migration: the pin moved off the
            // symlink-resolved (version-stamped) path onto the stable one, so every
            // pre-1.9.0 install drifts exactly once. Blaming a "version-manager
            // switch between runs" here would be actively misleading — the user
            // changed nothing about their Node.
            parts.push(`Node path spelling changed: the installed hook pins ${installed.nodeBin} and this companion runs ` +
                `${expected.nodeBin} — these are the SAME interpreter reached by different paths. Since v1.9.0 the ` +
                `hook pins the stable path instead of the version-stamped one, so a Node upgrade no longer breaks it. ` +
                `This is the expected one-time re-pin after upgrading the plugin; your Node did not move.`);
        }
        else {
            parts.push(`Node binary changed: the installed hook pins ${installed.nodeBin}, but this companion runs ` +
                `${expected.nodeBin} (both exist on disk — likely a Node version-manager switch between runs).`);
        }
    }
    if (hookDrift) {
        parts.push(`Hook script path drift: the installed hook points at ${installed.hookScript}, but this companion's ` +
            `hook is ${expected.hookScript} (likely a plugin update or move — the install path is version-stamped).`);
    }
    parts.push("Run /kimi:setup to re-pin the managed block to this companion's current paths.");
    return parts.join(" ");
}
/**
 * Best-effort: compute the canonical expected shell command for the
 * current env. Returns `undefined` if either path can't be resolved
 * (caller treats this as "managed block is unverifiable; do not assume
 * installed"). Never throws.
 *
 * This is the helper the verifier uses on every plugin command spawn.
 */
export function tryBuildExpectedHookCommand(env) {
    try {
        const hookScriptPath = resolveHookScriptPath(env);
        const command = buildHookShellCommand(hookScriptPath, env);
        // Surfaced so the verifier can probe the pinned interpreter for
        // executability. DERIVED FROM `command` BY PARSING IT BACK, never by calling
        // `resolveNodeBinary` a second time.
        //
        // Re-resolving would be a latent bypass: `resolveNodeBinary`'s no-override
        // path runs `preferStableNodePath`, which calls `realpathSync` and falls
        // back to `execPath` on ANY throw. So it is NOT a pure function of `env` —
        // it reads live filesystem state. If the pinned symlink were unlinked
        // between the two calls (exactly what `brew upgrade node` does), call #1
        // would embed the symlink in `command` while call #2 returned the old
        // realpath. The verifier would then compare the config against the symlink
        // (match) but probe the OLD Cellar path for executability (may still exist)
        // — reporting installed=true for a hook whose actual pinned interpreter is
        // gone. `/bin/sh -c` would exit 127, which kimi-code reads as ALLOW.
        //
        // Parsing the command back is the exact inverse of how it was built, so
        // `nodeBin` is byte-identical to the token in `command` BY CONSTRUCTION —
        // the guarantee is structural, not probabilistic. The `??` is unreachable
        // (we just built this string with the very quoting `parseHookShellCommand`
        // decodes) and exists only so a future change to either side degrades to
        // the old behavior instead of throwing.
        const nodeBin = parseHookShellCommand(command)?.nodeBin ?? resolveNodeBinary(env);
        return { command, hookScriptPath, nodeBin };
    }
    catch (err) {
        if (err instanceof RuntimeError) {
            return { error: err };
        }
        return {
            error: new RuntimeError("SETUP_RESOLVE_HOOK_FAILED", `Unexpected error resolving hook path: ${err.message}`, "setup.resolve-hook", err instanceof Error
                ? { cause: err, details: {} }
                : { details: {} }),
        };
    }
}
// ----- Host identity -----------------------------------------------------
//
// Claude Code and Codex install this plugin to DIFFERENT, version-stamped,
// host-specific paths but SHARE one `~/.kimi-code/config.toml`:
//
//   Claude: ~/.claude/plugins/cache/kimi-marketplace/kimi/<ver>/dist/hooks/approval-hook.js
//   Codex:  ~/.codex/plugins/cache/kimi-marketplace/kimi/<ver>/dist/hooks/approval-hook.js
//
// The managed block is host-scoped (marker suffix `:<host-id>`) so each host
// owns and verifies its OWN PreToolUse block without clobbering the other's.
// The host id must be VERSION-INDEPENDENT so a plugin upgrade REFRESHES the
// same host's block instead of accumulating one block per version.
/**
 * Resolve a stable, version-independent host id for the managed-block marker.
 *
 * Order: an explicit `KIMI_PLUGIN_CC_HOST_ID` override (slugified) wins — used
 * by tests and the live-repair path. Otherwise derive from the resolved hook
 * script path. Pass the already-resolved `hookScriptPath` when you have it
 * (the verifier + setup do) so we don't re-resolve and risk a second throw.
 */
export function resolveHostId(env, hookScriptPath) {
    const override = env.KIMI_PLUGIN_CC_HOST_ID;
    if (override !== undefined && override.trim().length > 0) {
        return slugifyHostId(override);
    }
    const resolved = hookScriptPath ?? resolveHookScriptPath(env);
    return hostIdFromHookScript(resolved);
}
/**
 * Derive a host id from a hook-script path. `~/.claude/...` → `claude-code`,
 * `~/.codex/...` → `codex` (both literal + version-independent), else a stable
 * `host-<sha1(hookDir)[:8]>` for dev checkouts / unrecognized layouts.
 */
export function hostIdFromHookScript(hookScriptPath) {
    const norm = hookScriptPath.split(path.sep).join("/");
    if (norm.includes("/.claude/"))
        return "claude-code";
    if (norm.includes("/.codex/"))
        return "codex";
    // Dev checkouts are not version-stamped, so hashing the hook's directory is
    // stable across runs (and across plugin upgrades, which don't move it). Use
    // 16 hex chars (64 bits): an 8-char prefix is only 32 bits, where two
    // distinct dev roots can collide (Codex review found a concrete pair) and the
    // second setup would treat the first host's block as its own and clobber it.
    const digest = createHash("sha1").update(path.dirname(hookScriptPath)).digest("hex");
    return `host-${digest.slice(0, 16)}`;
}
/**
 * Normalize an arbitrary host-id override into the `[a-z0-9-]+` slug the
 * marker regex accepts. Empty results fall back to `host` so the marker is
 * always well-formed.
 */
export function slugifyHostId(value) {
    const slug = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);
    return slug.length > 0 ? slug : "host";
}
/**
 * True when a (decoded) hook `command` string is unambiguously THIS plugin's
 * approval hook — a canonical two-single-quoted-token command whose script is
 * `approval-hook.js` living under a `kimi-plugin-cc` / `kimi-marketplace`
 * install tree. Used to prune orphaned, marker-less `[[hooks]]` entries left by
 * older installs. Deliberately strict: a hand-rolled or non-canonical command
 * returns false, so we never remove a user's own hook.
 */
/**
 * Derive the host id that OWNS a hook command, from its script path — the
 * host-scoped counterpart of `hostIdFromHookScript`. Returns `null` when the
 * command isn't the canonical two-single-quoted-token shape (a stale/bare
 * legacy command whose owner can't be determined). Callers treat `null` as
 * "claimable by the current host." Lets a legacy (un-suffixed) block be
 * attributed to whichever host actually wrote it, so one host's `/kimi:setup`
 * never adopts or removes another host's block.
 */
export function hostIdFromHookCommand(command) {
    const parsed = parseHookShellCommand(command);
    if (parsed === null)
        return null;
    return hostIdFromHookScript(parsed.hookScript);
}
export function isOurApprovalHookCommand(decodedCommand) {
    const parsed = parseHookShellCommand(decodedCommand);
    if (parsed === null)
        return false;
    const script = parsed.hookScript.split(/[\\/]/);
    if (script[script.length - 1] !== "approval-hook.js")
        return false;
    const normalized = parsed.hookScript.replace(/\\/g, "/");
    // Require a real path SEGMENT, not an arbitrary substring — otherwise a
    // user hook at `/opt/acme/kimi-plugin-cc-wrapper/approval-hook.js` would be
    // misclassified as ours and pruned. (Codex review.)
    return normalized.includes("/kimi-plugin-cc/") || normalized.includes("/kimi-marketplace/");
}
