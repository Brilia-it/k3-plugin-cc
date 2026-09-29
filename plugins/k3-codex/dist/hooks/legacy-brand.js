// BRILIA fork (k3-plugin-cc), added in 2.0.7-brilia.0.6.0. Not an upstream file.
//
// Before 0.6.0 this fork wrote its hook block into ~/.kimi-code/config.toml
// under upstream's marker, `kimi-plugin-cc-managed`. From 0.6.0 the marker is
// `k3-plugin-cc-managed`, so this plugin and the upstream kimi plugin can live in
// the same config without one rewriting the other's block.
//
// A block under the OLD marker is either ours (left by a pre-0.6 install of this
// fork) or upstream's (the kimi plugin, installed side by side). It is ours only
// when its hook command is this plugin's approval hook installed under this
// fork's tree: `isOurApprovalHookCommand`, which requires a
// `/brilia-k3-marketplace/` or `/k3-plugin-cc/` path segment. Ours: setup removes
// it and writes the new block. Anything else: left byte for byte.
//
// A block under the old marker is NEVER accepted as an installed hook. Its hook
// reads the pre-0.6 variables (KIMI_PLUGIN_CC_*), which this plugin no longer
// sets, so for a K3 session it would allow every tool call. The verifier knows
// only the new marker; this module exists to remove what the old one left.
import { hostIdFromHookCommand, isOurApprovalHookCommand } from "./install-paths.js";
import { decodeManagedCommandLine } from "./managed-block.js";
export const LEGACY_MARKER_TAG = "kimi-plugin-cc-managed";
const LEGACY_BEGIN_RE = /^#\s*===\s*BEGIN\s+kimi-plugin-cc-managed(?::([A-Za-z0-9._-]+))?(?:\s+\([^)]+\))?\s*===\s*$/;
const LEGACY_END_RE = /^#\s*===\s*END\s+kimi-plugin-cc-managed(?::([A-Za-z0-9._-]+))?\s*===\s*$/;
// Any marker of the CURRENT brand ends the look-ahead: a legacy BEGIN whose END
// would lie past a current block is not a well-formed legacy block.
const CURRENT_MARKER_RE = /^#\s*===\s*(?:BEGIN|END)\s+k3-plugin-cc-managed\b/;
const HOOKS_TABLE_RE = /^\[\[hooks\]\]\s*$/;
const EVENT_LINE_RE = /^event\s*=\s*"PreToolUse"\s*$/;
const TIMEOUT_LINE_RE = /^timeout\s*=\s*\d+\s*$/;
function splitLines(contents) {
    return contents.split("\n").map((line) => line.replace(/\r$/, ""));
}
/**
 * Every well-formed block under the old marker, in file order. `alsoOurs` is
 * the command THIS install would write: a block running exactly that command is
 * ours whatever its path (a development checkout keeps one path across
 * versions), the same byte-exact ownership signal the orphan prune uses.
 */
export function findLegacyBrandBlocks(contents, alsoOurs) {
    const lines = splitLines(contents);
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
        const begin = LEGACY_BEGIN_RE.exec(lines[i].trim());
        if (begin === null) {
            i += 1;
            continue;
        }
        let endLine = -1;
        let command = null;
        let hooksTables = 0;
        let event = false;
        let foreign = false;
        for (let j = i + 1; j < lines.length; j += 1) {
            const trimmed = lines[j].trim();
            if (LEGACY_BEGIN_RE.test(trimmed) || CURRENT_MARKER_RE.test(trimmed))
                break;
            if (LEGACY_END_RE.test(trimmed)) {
                endLine = j;
                break;
            }
            if (trimmed.length === 0 || trimmed.startsWith("#"))
                continue;
            if (HOOKS_TABLE_RE.test(trimmed)) {
                hooksTables += 1;
                continue;
            }
            if (EVENT_LINE_RE.test(trimmed)) {
                event = true;
                continue;
            }
            if (TIMEOUT_LINE_RE.test(trimmed))
                continue;
            const decoded = decodeManagedCommandLine(trimmed);
            if (decoded !== null) {
                if (command !== null)
                    foreign = true;
                command = decoded;
                continue;
            }
            foreign = true;
        }
        if (endLine === -1) {
            // An unmatched legacy BEGIN is not a block. Leave it; nothing to migrate.
            i += 1;
            continue;
        }
        const suffix = begin[1]?.toLowerCase() ?? null;
        const host = suffix ?? (command !== null ? hostIdFromHookCommand(command) : null);
        const simpleBody = hooksTables === 1 && event && command !== null && !foreign;
        blocks.push({
            beginLine: i,
            endLine,
            host,
            command,
            ours: simpleBody && (command === alsoOurs || isOurApprovalHookCommand(command)),
        });
        i = endLine + 1;
    }
    return blocks;
}
/**
 * Remove this fork's own legacy blocks. With `host`, only the blocks of that
 * host (the other host migrates its own on its next setup, exactly like the
 * current marker's host scoping); without it, every one of ours (`--all`).
 * Blocks that are not ours are kept byte for byte and returned in `kept`.
 */
export function stripLegacyBrandBlocks(contents, lineEnding, host, alsoOurs) {
    const blocks = findLegacyBrandBlocks(contents, alsoOurs);
    // A block running exactly this install's command is this host's own even if
    // a host-id override makes its path-derived host differ (as in the prune).
    const removed = blocks.filter((b) => b.ours && (host === undefined || b.host === host || (alsoOurs !== undefined && b.command === alsoOurs)));
    const kept = blocks.filter((b) => !removed.includes(b));
    if (removed.length === 0)
        return { stripped: contents, removed, kept };
    const drop = new Set();
    for (const block of removed) {
        for (let line = block.beginLine; line <= block.endLine; line += 1)
            drop.add(line);
    }
    const lines = splitLines(contents).filter((_, index) => !drop.has(index));
    // Collapse runs of >= 3 blank lines created by removal back to 2, as the
    // current-marker strip does.
    const collapsed = [];
    let blankRun = 0;
    for (const line of lines) {
        if (line.length === 0) {
            blankRun += 1;
            if (blankRun <= 2)
                collapsed.push(line);
        }
        else {
            blankRun = 0;
            collapsed.push(line);
        }
    }
    return { stripped: collapsed.join(lineEnding), removed, kept };
}
/** Human-readable notes for setup's warnings. Empty when there is nothing to say. */
export function describeLegacyBrandBlocks(removed, kept, mode) {
    const notes = [];
    if (removed.length > 0) {
        notes.push(mode === "removed"
            ? `Migrated ${removed.length} hook block(s) written by k3-plugin-cc before 0.6.0 under the old marker ` +
                `\`${LEGACY_MARKER_TAG}\`: removed, and replaced by the \`k3-plugin-cc-managed\` block. Their hook read ` +
                `variables this plugin no longer sets, so they no longer protected K3 sessions.`
            : `Found ${removed.length} hook block(s) written by k3-plugin-cc before 0.6.0 under the old marker ` +
                `\`${LEGACY_MARKER_TAG}\`. They no longer protect K3 sessions; run /k3:setup to remove them.`);
    }
    const otherHost = kept.filter((b) => b.ours);
    if (otherHost.length > 0) {
        notes.push(`${otherHost.length} pre-0.6 k3-plugin-cc block(s) of another host (${[
            ...new Set(otherHost.map((b) => b.host ?? "unknown")),
        ].join(", ")}) remain: each host migrates its own on its next setup.`);
    }
    const foreign = kept.filter((b) => !b.ours);
    if (foreign.length > 0) {
        notes.push(`Left ${foreign.length} block(s) under the marker \`${LEGACY_MARKER_TAG}\` untouched: their hook is not ` +
            `this plugin's (most likely the upstream kimi plugin, which uses that marker). They do not affect K3.`);
    }
    return notes;
}
